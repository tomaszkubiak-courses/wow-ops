import test from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { listAccounts } from '../server/queries/accounts.js';

// This file borrows the real `logs` database for its fixture tables, rather
// than creating a scratch database of its own, because the `mangos` MySQL
// user on this machine has `USAGE ON *.*` plus `ALL PRIVILEGES` on only
// `characters`, `logs`, `mangos` and `realmd` - no CREATE DATABASE privilege -
// so `CREATE DATABASE wow_ops_test_logon` fails with ERROR 1044. `logs` is the
// one database the panel does not need at runtime.
//
// The fixture tables must be named `account`, `account_banned` and
// `account_access`, matching the real logon-database tables, because
// server/queries/accounts.js names all three unqualified - a fixture under
// different names would not exercise the real query. `node --test` runs
// separate test files concurrently, so any other test file that also
// borrows `logs` MUST NOT reuse these three table names, or one file's DROP
// TABLE can race another file's CREATE TABLE.
//
// Each test creates its own pool and registers teardown on it *before* doing
// any DROP/CREATE/INSERT, so that if seed() throws partway through - a lock
// wait timeout, a transient connection error, whatever - t.after still runs
// and cleans up whatever got created, and always closes the pool. See the
// "seed failure leaves nothing behind" test below, which proves this by
// deliberately breaking the seed step.
const BASE = { host: '127.0.0.1', port: 3306, user: 'mangos', password: 'mangos', database: 'logs' };

async function seed(pool) {
  await pool.query('DROP TABLE IF EXISTS account_access');
  await pool.query('DROP TABLE IF EXISTS account_banned');
  await pool.query('DROP TABLE IF EXISTS account');

  // Deliberately has no failed_logins column - this realm's real account
  // table does not have one either (see server/queries/accounts.js).
  await pool.query(`
    CREATE TABLE account (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(32) NOT NULL,
      gmlevel TINYINT UNSIGNED NOT NULL DEFAULT 0,
      last_ip VARCHAR(30) NOT NULL DEFAULT '0.0.0.0',
      locked TINYINT UNSIGNED NOT NULL DEFAULT 0,
      last_login TIMESTAMP NULL DEFAULT NULL,
      online TINYINT NOT NULL DEFAULT 0,
      mutetime BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE account_banned (
      banid BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
      id BIGINT NOT NULL DEFAULT 0,
      bandate BIGINT NOT NULL DEFAULT 0,
      unbandate BIGINT NOT NULL DEFAULT 0,
      bannedby VARCHAR(50) NOT NULL,
      banreason VARCHAR(255) NOT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      PRIMARY KEY (id, bandate)
    ) ENGINE=InnoDB
  `);
  // Matches vmangos-core/sql/logon.sql:64 - keyed (id, RealmID), so one
  // account can hold both a wildcard row (RealmID = -1) and a realm-specific
  // row at the same time.
  await pool.query(`
    CREATE TABLE account_access (
      id INT UNSIGNED NOT NULL,
      gmlevel TINYINT UNSIGNED NOT NULL,
      RealmID INT NOT NULL,
      PRIMARY KEY (id, RealmID)
    ) ENGINE=InnoDB
  `);
  // account.gmlevel is deliberately seeded with a bogus value (9) that
  // matches no expected result: AccountMgr::SetSecurity only ever writes
  // account_access (AccountMgr.cpp:213), so a query that still reads
  // a.gmlevel would surface this bogus value and fail every assertion below.
  await pool.query(`
    INSERT INTO account (id, username, gmlevel, online) VALUES
      (1, 'TOMEK', 9, 1),
      (2, 'FRIEND', 9, 0),
      (3, 'RNDBOT1', 9, 1),
      (4, 'RNDBOT2', 9, 0)
  `);
  await pool.query(`
    INSERT INTO account_banned (id, bandate, unbandate, bannedby, banreason, active) VALUES
      (2, 1000, 2000, 'CONSOLE', 'expired ban', 0),
      (2, 3000, 3000, 'CONSOLE', 'cheating', 1),
      (4, 500, 900000, 'CONSOLE', 'bot misbehaving', 1)
  `);
  // TOMEK: realm-specific row only. FRIEND: wildcard row only. RNDBOT1: both
  // a realm-specific and a wildcard row, at different levels, so the higher
  // one (MAX) must win and the account must still appear exactly once.
  // RNDBOT2: no row at all, so it must come back as 0 via COALESCE.
  await pool.query(`
    INSERT INTO account_access (id, gmlevel, RealmID) VALUES
      (1, 4, 1),
      (2, 3, -1),
      (3, 2, 1),
      (3, 5, -1)
  `);
}

async function teardown(pool) {
  // DROP TABLE IF EXISTS is safe even when seed() never got as far as
  // creating any of the tables - all three statements are then no-ops - and
  // this must run even if seed() threw partway through, so the pool is
  // always closed in a finally.
  try {
    await pool.query('DROP TABLE IF EXISTS account_access');
    await pool.query('DROP TABLE IF EXISTS account_banned');
    await pool.query('DROP TABLE IF EXISTS account');
  } finally {
    await pool.end();
  }
}

function makePool(t) {
  const pool = mysql.createPool({ ...BASE, connectionLimit: 2 });
  // Registered immediately, before any DDL, so that a throw anywhere in
  // seed() still triggers cleanup.
  t.after(() => teardown(pool));
  return pool;
}

async function fixtureTableNames(pool) {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = 'logs' AND TABLE_NAME IN ('account', 'account_banned', 'account_access')`
  );
  return rows.map((r) => r.TABLE_NAME).sort();
}

test('seed failure leaves nothing behind', async (t) => {
  const pool = makePool(t);

  // Confirm the schema starts clean, so a later assertion that it is clean
  // again actually proves something rather than trivially matching a
  // starting state we never checked.
  assert.deepEqual(await fixtureTableNames(pool), [], 'no fixture table exists before this test seeds anything');

  const realQuery = pool.query.bind(pool);
  let calls = 0;
  pool.query = (...args) => {
    calls += 1;
    // seed()'s statement order is: 3 DROP TABLE IF EXISTS, then CREATE
    // TABLE account, then CREATE TABLE account_banned (call 5), then CREATE
    // TABLE account_access (call 6). Failing on the 6th call leaves two real
    // tables sitting in `logs` when seed() dies - a genuine partial seed for
    // teardown (registered by makePool above, before any DDL ran) to clean
    // up, not just an immediate no-op failure.
    if (calls === 6) {
      return Promise.reject(new Error('simulated seed failure'));
    }
    return realQuery(...args);
  };

  await assert.rejects(() => seed(pool), /simulated seed failure/);

  // Restore the real query method so t.after's teardown (still registered,
  // from makePool above) can actually reach MySQL when it runs after this
  // test returns.
  pool.query = realQuery;

  assert.equal(calls, 6, 'the failure must have happened after real tables were created, not before');
});

test('confirms the seed failure above left the logs database exactly as it found it', async () => {
  // A fresh pool and a fresh query, deliberately not reusing the previous
  // test's pool or its t.after: this runs only after that test's own
  // teardown has completed (node:test runs tests in one file sequentially
  // by default), so it proves teardown actually ran rather than merely
  // that seed() failed before creating anything.
  const pool = mysql.createPool({ ...BASE, connectionLimit: 1 });
  try {
    assert.deepEqual(await fixtureTableNames(pool), [], 'every fixture table created before the simulated failure must be gone');
  } finally {
    await pool.end();
  }
});

test('lists real accounts and hides bots by default', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { botPrefix: 'RNDBOT' });
  assert.deepEqual(rows.map((r) => r.username), ['FRIEND', 'TOMEK']);
});

test('includes bots when asked', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { includeBots: true, botPrefix: 'RNDBOT' });
  assert.equal(rows.length, 4);
});

test('reports the active ban, not an expired one', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { botPrefix: 'RNDBOT' });
  const friend = rows.find((r) => r.username === 'FRIEND');
  assert.equal(friend.ban_active, 1);
  assert.equal(friend.ban_reason, 'cheating');
  assert.equal(friend.ban_permanent, true, 'unbandate equal to bandate means permanent');
});

test('leaves unbanned accounts with a null ban', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { botPrefix: 'RNDBOT' });
  const tomek = rows.find((r) => r.username === 'TOMEK');
  assert.equal(tomek.ban_active, null);
  assert.equal(tomek.gmlevel, 4);
  assert.equal(tomek.online, 1);
});

test('reports a timed bot ban as not permanent', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { includeBots: true, botPrefix: 'RNDBOT' });
  const bot = rows.find((r) => r.username === 'RNDBOT2');
  assert.equal(bot.ban_active, 1);
  assert.equal(bot.ban_permanent, false);
});

test('reads gm level from a realm-specific account_access row', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { botPrefix: 'RNDBOT' });
  const tomek = rows.find((r) => r.username === 'TOMEK');
  assert.equal(tomek.gmlevel, 4, 'not the bogus account.gmlevel value of 9');
});

test('reads gm level from a wildcard (RealmID = -1) account_access row', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { botPrefix: 'RNDBOT' });
  const friend = rows.find((r) => r.username === 'FRIEND');
  assert.equal(friend.gmlevel, 3, 'not the bogus account.gmlevel value of 9');
});

test('collapses a wildcard and a realm-specific row with MAX, without duplicating the account', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { includeBots: true, botPrefix: 'RNDBOT' });
  const bots = rows.filter((r) => r.username === 'RNDBOT1');
  assert.equal(bots.length, 1, 'the account must appear exactly once');
  assert.equal(bots[0].gmlevel, 5, 'the higher of the two rows (5) must win');
});

test('an account with no account_access row reports gm level 0, not null', async (t) => {
  const pool = makePool(t);
  await seed(pool);

  const rows = await listAccounts({ logon: pool }, { includeBots: true, botPrefix: 'RNDBOT' });
  const bot = rows.find((r) => r.username === 'RNDBOT2');
  assert.equal(bot.gmlevel, 0);
});
