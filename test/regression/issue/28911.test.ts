// https://github.com/oven-sh/bun/issues/28911
// bun:sqlite's query cache was bounded only by entry count (20 slots),
// so a small number of very large dynamic SQL texts (e.g. a
// `SELECT ... IN (...)` with 300k literals — ~5.7 MB per query string)
// could pin hundreds of MB of prepared-statement state and OOM a 1 GB
// container. The cache now also refuses to cache queries whose SQL
// exceeds a per-entry byte threshold, caps total cached SQL bytes, and
// FIFO-evicts old entries when a new one needs a slot.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

const cacheCountSymbol = Symbol.for("Bun.Database.cache.count");

// Keep these in sync with src/js/bun/sqlite.ts.
const PER_ENTRY_BYTE_CAP = 64 * 1024;
const TOTAL_BYTE_CAP = 2 * 1024 * 1024;

test("large dynamic queries do not fill the query cache (#28911)", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, template_id TEXT)");

    // Build a SELECT ... IN (...) with enough literals to comfortably
    // exceed the 64 KB per-entry cap. Each literal is 19 bytes —
    // 10k of them is ~190 KB of SQL text.
    const values = Array.from({ length: 10_000 }, (_, i) => `'${i.toString(16).padStart(16, "0")}'`).join(",");
    const baseSql = `SELECT id FROM t WHERE template_id IN (${values}) LIMIT 1`;
    expect(baseSql.length).toBeGreaterThan(PER_ENTRY_BYTE_CAP);

    // Each iteration differs only in a trailing comment, so the full-text
    // cache key never matches. Before the fix this filled 20 cache slots
    // with ~190 KB of SQL each (plus much larger prepared-statement
    // state), pinning several MB and never releasing until close().
    // After the fix the per-entry byte cap keeps these out of the cache
    // entirely and the cache count stays at 0.
    for (let i = 0; i < 25; i++) {
      const stmt = db.query(`${baseSql} /*iter=${i}*/`);
      stmt.all();
      // Explicit finalize keeps pending sqlite3_stmt handles from
      // piling up under ASAN and lets close() succeed.
      stmt.finalize();
    }

    expect(db[cacheCountSymbol]).toBe(0);
  } finally {
    db.close();
  }
});

test("small queries still populate the query cache", () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("INSERT INTO t (name) VALUES ('a'), ('b'), ('c')");

  // Repeatedly calling db.query with the same string reuses the cached
  // prepared statement — one slot used, regardless of call count.
  for (let i = 0; i < 5; i++) {
    expect(db.query("SELECT * FROM t WHERE name = ?").all("a")).toEqual([{ id: 1, name: "a" }]);
  }
  expect(db[cacheCountSymbol]).toBe(1);

  // A handful of distinct small queries each take a slot.
  for (let i = 0; i < 5; i++) {
    db.query(`SELECT ${i} AS x, id FROM t WHERE id = ?`).all(1);
  }
  expect(db[cacheCountSymbol]).toBe(6);
});

test("query cache FIFO-evicts the oldest entry once the count cap is reached (#28911)", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const max = Database.MAX_QUERY_CACHE_SIZE;

    // Fill the cache with `max` distinct small queries. Grab a stable
    // reference to the oldest cached Statement so we can tell whether it
    // survives a round of evictions.
    const oldestStmt = db.query(`SELECT 0 AS x FROM t`);
    oldestStmt.all();
    for (let i = 1; i < max; i++) {
      db.query(`SELECT ${i} AS x FROM t`).all();
    }
    expect(db[cacheCountSymbol]).toBe(max);

    // Insert more distinct small queries than the cap allows. This
    // should trigger FIFO eviction of the oldest entry. Before the fix
    // the new queries were silently dropped (not cached) and the
    // original 20 stayed pinned forever — the test below would still
    // see the oldest entry as cached.
    for (let i = max; i < max + 10; i++) {
      const s = db.query(`SELECT ${i} AS x FROM t`);
      s.all();
      s.finalize();
    }
    expect(db[cacheCountSymbol]).toBe(max);

    // Re-querying the oldest SQL: if it's still in the cache, query()
    // returns the same Statement instance; if it was evicted, a fresh
    // one is prepared.
    const afterEviction = db.query(`SELECT 0 AS x FROM t`);
    expect(afterEviction).not.toBe(oldestStmt);
  } finally {
    db.close();
  }
});

test("query cache total SQL bytes are bounded (#28911)", () => {
  // Raise the per-entry byte cap so medium-sized queries are eligible
  // for caching, and raise the count cap so the byte cap — not the
  // count cap — is what binds.
  const prevCount = Database.MAX_QUERY_CACHE_SIZE;
  const prevEntryBytes = Database.MAX_QUERY_CACHE_ENTRY_BYTES;
  Database.MAX_QUERY_CACHE_SIZE = 1000;
  Database.MAX_QUERY_CACHE_ENTRY_BYTES = 512 * 1024;
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");

    // ~120 KB of SQL each — well under the raised 512 KB per-entry cap
    // but enough of them to push past the 2 MB total byte cap.
    const values = Array.from({ length: 6_000 }, (_, i) => `'${i.toString(16).padStart(16, "0")}'`).join(",");
    const baseSql = `SELECT id FROM t WHERE id IN (${values})`;
    expect(baseSql.length).toBeLessThan(Database.MAX_QUERY_CACHE_ENTRY_BYTES);

    for (let i = 0; i < 50; i++) {
      const stmt = db.query(`${baseSql} /*iter=${i}*/`);
      stmt.all();
      stmt.finalize();
    }

    // 50 distinct queries × ~120 KB = 6 MB; without a byte cap the raised
    // count cap (1000) would let every one stay cached. With the 2 MB
    // total byte cap, at most ~17 can fit.
    const maxEntries = Math.floor(TOTAL_BYTE_CAP / baseSql.length) + 1;
    const count = db[cacheCountSymbol] as number;
    expect(count).toBeLessThanOrEqual(maxEntries);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(50);
  } finally {
    db.close();
    Database.MAX_QUERY_CACHE_SIZE = prevCount;
    Database.MAX_QUERY_CACHE_ENTRY_BYTES = prevEntryBytes;
  }
});
