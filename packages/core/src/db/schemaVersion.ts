/**
 * The schema this code is written against.
 *
 * Kept as a bare number, importable from anywhere, because the two places that
 * carry the migrations cannot both be: the test list reads the .sql files off
 * disk with `node:fs`, and the app globs the same folder through its bundler.
 * Neither can be loaded by the other.
 *
 * The glob is the trap. It is resolved when the bundle is built, so an app left
 * running while a new migration file is added carries the old set — and then the
 * TypeScript, which is hot-reloaded, starts querying columns the database has
 * never been given. What that looked like was a report failing with "no such
 * column", halfway through a session, with nothing to suggest the cause.
 *
 * So the app compares what it globbed against this on start and says plainly
 * that the build is behind, rather than letting every query find out on its own.
 *
 * **Raise this in the same commit as a new migration file.**
 */
export const EXPECTED_SCHEMA_VERSION = 34
