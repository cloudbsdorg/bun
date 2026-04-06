// https://github.com/oven-sh/bun/issues/28911
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
    db.exec("INSERT INTO t (id) VALUES (0), (1), (2)");
    const max = Database.MAX_QUERY_CACHE_SIZE;

    // Fill the cache with `max` distinct small queries. Grab a stable
    // reference to the oldest cached Statement so we can tell whether it
    // survives a round of evictions — and whether it's still usable.
    const oldestStmt = db.query(`SELECT 0 AS x, id FROM t`);
    oldestStmt.all();
    for (let i = 1; i < max; i++) {
      db.query(`SELECT ${i} AS x, id FROM t`).all();
    }
    expect(db[cacheCountSymbol]).toBe(max);

    // Insert more distinct small queries than the cap allows. This
    // should trigger FIFO eviction of the oldest entry. Before the fix
    // the new queries were silently dropped (not cached) and the
    // original 20 stayed pinned forever.
    for (let i = max; i < max + 10; i++) {
      const s = db.query(`SELECT ${i} AS x, id FROM t`);
      s.all();
    }
    expect(db[cacheCountSymbol]).toBe(max);

    // The evicted Statement MUST still be usable via the held reference.
    // Eviction removes the cache's reference, but the caller's reference
    // keeps the underlying prepared statement alive. Finalizing it from
    // under the caller would silently destroy handles that application
    // code commonly stores at module or class scope for repeated use.
    expect(oldestStmt.isFinalized).toBe(false);
    expect(oldestStmt.all()).toEqual([
      { x: 0, id: 0 },
      { x: 0, id: 1 },
      { x: 0, id: 2 },
    ]);

    // Re-querying the oldest SQL: if it's still in the cache, query()
    // returns the same Statement instance; if it was evicted, a fresh
    // one is prepared.
    const afterEviction = db.query(`SELECT 0 AS x, id FROM t`);
    expect(afterEviction).not.toBe(oldestStmt);

    // The held reference stays usable even after being replaced in the
    // cache.
    expect(oldestStmt.isFinalized).toBe(false);
    expect(oldestStmt.all()).toHaveLength(3);
  } finally {
    db.close();
  }
});

test("using db + large transient queries does not throw on dispose (#28911)", () => {
  // Large SQL texts never enter the cache (they exceed the per-entry
  // byte cap), so clearQueryCache() would have nothing to finalize and
  // sqlite3_close(db) from `using`'s Symbol.dispose would return
  // SQLITE_BUSY if any transient statement handles were still open.
  // The Database now weakly tracks non-cached db.query() statements
  // and finalizes any survivors inside clearQueryCache(), which runs
  // from close().
  const values = Array.from({ length: 10_000 }, (_, i) => `'${i.toString(16).padStart(16, "0")}'`).join(",");
  const baseSql = `SELECT id FROM t WHERE template_id IN (${values}) LIMIT 1`;
  expect(baseSql.length).toBeGreaterThan(PER_ENTRY_BYTE_CAP);

  expect(() => {
    using db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, template_id TEXT)");
    // Fire off several large transient queries without holding refs or
    // calling finalize() — the pattern from the #28911 repro.
    for (let i = 0; i < 5; i++) {
      db.query(`${baseSql} /*iter=${i}*/`).all();
    }
    // Symbol.dispose runs here with 5 unfinalized transient statements
    // in flight. Before the tracking fix this would throw
    // "database is locked".
  }).not.toThrow();
});

test("FIFO-evicted cache entry that is re-queried moves to newest slot (#28911)", () => {
  using db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  const max = Database.MAX_QUERY_CACHE_SIZE;

  // Fill the cache completely with distinct queries.
  for (let i = 0; i < max; i++) {
    db.query(`SELECT ${i} AS x FROM t`).all();
  }
  expect(db[cacheCountSymbol]).toBe(max);

  // Grab and externally-finalize the OLDEST entry (inserted first).
  const oldestSql = `SELECT 0 AS x FROM t`;
  db.query(oldestSql).finalize();

  // Re-query it — the hit path should prepare a replacement and move
  // the refreshed entry to the NEWEST slot in the FIFO, not leave it
  // at the front where it would be the immediate next eviction target.
  const refreshed = db.query(oldestSql);
  expect(refreshed.isFinalized).toBe(false);

  // Add max-1 more distinct queries. If the refreshed entry was still
  // at the oldest slot, it would be evicted in the first of these. If
  // it was correctly moved to newest, it survives all max-1 evictions.
  for (let i = max; i < max + max - 1; i++) {
    db.query(`SELECT ${i} AS x FROM t`).all();
  }
  expect(db[cacheCountSymbol]).toBe(max);

  // Re-query the refreshed SQL — if the slot move worked, this is a
  // cache hit and returns the SAME Statement instance.
  const stillCached = db.query(oldestSql);
  expect(stillCached).toBe(refreshed);
});

test("disabling the cache at runtime evicts finalized cached entries (#28911)", () => {
  // A caller who sets MAX_QUERY_CACHE_SIZE = 0 at runtime expects caching
  // to be fully off. Previously, the cache-hit path for a cached but
  // externally-finalized statement unconditionally re-prepared with
  // SQLITE_PREPARE_PERSISTENT and re-inserted into the cache — bypassing
  // the runtime override. Verify the override is respected.
  const prevCount = Database.MAX_QUERY_CACHE_SIZE;
  try {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      const sql = "SELECT 1 AS x FROM t";

      // Admit a small query to the cache under default limits.
      const first = db.query(sql);
      first.all();
      expect(db[cacheCountSymbol]).toBe(1);

      // User disables caching at runtime, then externally finalizes the
      // cached handle (e.g. via a `using` stmt from another code path).
      Database.MAX_QUERY_CACHE_SIZE = 0;
      first.finalize();

      // The next db.query() for the same SQL should NOT re-populate the
      // cache — caching is disabled.
      const replacement = db.query(sql);
      expect(replacement).not.toBe(first);
      expect(replacement.isFinalized).toBe(false);
      expect(replacement.all()).toEqual([]);
      expect(db[cacheCountSymbol]).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    Database.MAX_QUERY_CACHE_SIZE = prevCount;
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
  try {
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
    }
  } finally {
    // Restore statics in an outer finally so a throwing db.close() (or
    // anything inside the test body) can never leak the overrides into
    // subsequent tests in the same process.
    Database.MAX_QUERY_CACHE_SIZE = prevCount;
    Database.MAX_QUERY_CACHE_ENTRY_BYTES = prevEntryBytes;
  }
});
