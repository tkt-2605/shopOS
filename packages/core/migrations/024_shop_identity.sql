-- Which shop this database is.
--
-- Found by pointing two tills at each other and watching them fail: applying the
-- first till's Admin role to the second died on `UNIQUE constraint failed:
-- roles.name`, halfway through a batch.
--
-- The cause is not the merge rule. It is that both databases had been
-- **bootstrapped separately**, so each had minted its own Admin role, its own
-- counter, its own price list — same names, different ids. Every natural key in
-- the schema collides that way: roles.name, registers.prefix, users.username,
-- categories.name. There is no merge rule for it, because the two rows are not
-- two versions of one thing. They are two different things that happen to be
-- called the same.
--
-- docs/multi-device.md already answered this without noticing it was a question:
-- one database per shop. A second till **joins** a shop, it does not create one
-- and then reconcile. In practice that means a new till is migrated and left
-- empty, and the first sync fills it — which is a different operation from two
-- set-up tills exchanging changes, and the two must not be confused.
--
-- So this is the thing that tells them apart. A database that has been set up
-- has a shop_id; one that has only been migrated has none and may join anybody.
-- Two databases with different ids are two shops and are refused at the
-- handshake, before a single row moves, with a sentence saying why.
--
-- It is minted here for a shop already running, and by `bootstrap` from now on.
-- A restored backup carries it, which is correct: that is the same shop, on
-- whatever machine it has landed on. It replicates like any other setting, so a
-- till that joins is told which shop it has joined.
--
-- `randomblob` rather than the UUIDv7 the rest of the schema uses, because a
-- migration has no way to call into TypeScript and this value is opaque -- it is
-- compared for equality and never sorted, read or parsed.

INSERT INTO settings (key, value, updated_at)
SELECT 'shop_id', lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (SELECT 1 FROM roles)
   AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'shop_id');
