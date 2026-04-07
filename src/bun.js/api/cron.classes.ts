// Tombstone for `CronJob`: the real binding was added on main in
// https://github.com/oven-sh/bun/pull/28701, which isn't in this branch's
// ancestry. Tracking an empty tombstone here (rather than letting the file
// be absent) makes the file's contents deterministic under `git checkout`
// even if the working directory previously held a copy from main — the
// codegen pass skips empty arrays by design.
export default [];
