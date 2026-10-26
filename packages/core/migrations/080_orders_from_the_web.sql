-- Orders from the web, and a photo for an item.
--
-- A shop that sells online (`services/web/`) takes orders from a storefront the
-- main till answers through a tunnel. An order waits here, `pending`, until a
-- person at the main accepts it; accepting raises an ordinary sales order and
-- from then on the order is that document -- billed at the counter like any
-- other, through `convertedFrom`, and collected when every line is billed.
-- Nothing here moves stock or money.
--
-- ## Who writes what
--
-- `web_orders` and `web_accounts` are written on the main, the only till that
-- answers the web. They travel so the other tills can see an order and bill
-- it, and because a cashier on any till ticks a customer's phone as checked
-- face to face. A record merged by revision like any other: two tills do not
-- edit one order, since only the main takes an answer from the customer and
-- only the main gives one.
--
-- `product_photos` says which of an item's attachments is the photo the
-- storefront shows, in two sizes made on the till when it was added. It
-- travels; the files themselves do not (attachments never have), which is why
-- the screen offers it only on the main.
--
-- `web_state` is the main's own: the key it signs customers' sessions with and
-- Google's signing keys as last fetched. A new main makes its own and its
-- customers sign in again, which is the right cost for a key that never
-- leaves the machine.
--
-- Additive: four new tables and their triggers. A till below 080 has none of
-- them in its replicated list and skips their records (`ignoredTables`).

CREATE TABLE web_accounts (
  id                TEXT PRIMARY KEY,
  -- Google's own id for the person. An email is a label, never the identity:
  -- see `apps/portal/src/auth/oauth.ts` for why.
  google_sub        TEXT NOT NULL UNIQUE,
  email             TEXT,
  name              TEXT,
  phone             TEXT,
  -- Set by a cashier who checked the number with the customer in front of
  -- them. Until then the phone is only what was typed.
  phone_verified_at TEXT,
  phone_verified_by TEXT REFERENCES users(id),
  -- The shop's customer this account bills as, once an order was accepted.
  customer_id       TEXT REFERENCES customers(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  rev               INTEGER NOT NULL DEFAULT 1,
  origin_id         TEXT
) STRICT;

CREATE TABLE web_orders (
  id               TEXT PRIMARY KEY,
  -- The number a customer reads out at the counter: W-12.
  order_no         INTEGER NOT NULL UNIQUE,
  account_id       TEXT NOT NULL REFERENCES web_accounts(id),
  -- Made by the phone, so an order sent twice over a bad line is one order.
  client_order_id  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'packing', 'ready', 'rejected', 'cancelled')),
  contact_name     TEXT NOT NULL,
  contact_phone    TEXT NOT NULL,
  note             TEXT,
  -- What the customer asked for and the prices they were shown, as sent. The
  -- prices are what they saw, not what they will pay: the till prices the
  -- order when it is accepted.
  lines_json       TEXT NOT NULL,
  catalog_hash     TEXT,
  seen_total       INTEGER NOT NULL,
  document_id      TEXT REFERENCES documents(id),
  till_total       INTEGER,
  reason           TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  placed_at        TEXT NOT NULL,
  answered_at      TEXT,
  answered_by      TEXT REFERENCES users(id),
  packing_at       TEXT,
  ready_at         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  rev              INTEGER NOT NULL DEFAULT 1,
  origin_id        TEXT,
  UNIQUE (account_id, client_order_id)
) STRICT;

CREATE INDEX idx_web_orders_status ON web_orders(status);
CREATE INDEX idx_web_orders_document ON web_orders(document_id) WHERE document_id IS NOT NULL;

CREATE TABLE product_photos (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  -- About 600 pixels across, for the item's own page.
  photo_id   TEXT NOT NULL REFERENCES attachments(id),
  -- About 200 pixels across, for lists.
  thumb_id   TEXT NOT NULL REFERENCES attachments(id),
  updated_at TEXT NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 1,
  origin_id  TEXT
) STRICT;

CREATE TABLE web_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TRIGGER bump_rev_web_accounts AFTER UPDATE ON web_accounts FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE web_accounts SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER feed_web_accounts_ins AFTER INSERT ON web_accounts FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'web_accounts' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('web_accounts', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_web_accounts_upd AFTER UPDATE ON web_accounts FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'web_accounts' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('web_accounts', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_web_accounts_del AFTER DELETE ON web_accounts FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'web_accounts' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('web_accounts', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

CREATE TRIGGER bump_rev_web_orders AFTER UPDATE ON web_orders FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE web_orders SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER feed_web_orders_ins AFTER INSERT ON web_orders FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'web_orders' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('web_orders', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_web_orders_upd AFTER UPDATE ON web_orders FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'web_orders' AND row_id = NEW.id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('web_orders', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_web_orders_del AFTER DELETE ON web_orders FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'web_orders' AND row_id = OLD.id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('web_orders', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;

CREATE TRIGGER bump_rev_product_photos AFTER UPDATE ON product_photos FOR EACH ROW
WHEN NEW.rev = OLD.rev AND (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  UPDATE product_photos SET rev = OLD.rev + 1 WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER feed_product_photos_ins AFTER INSERT ON product_photos FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_photos' AND row_id = NEW.product_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('product_photos', NEW.product_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_product_photos_upd AFTER UPDATE ON product_photos FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_photos' AND row_id = NEW.product_id;
  INSERT INTO change_feed (table_name, row_id, op, at)
  VALUES ('product_photos', NEW.product_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER feed_product_photos_del AFTER DELETE ON product_photos FOR EACH ROW
WHEN (SELECT applying FROM sync_state WHERE id = 1) = 0
BEGIN
  DELETE FROM change_feed WHERE table_name = 'product_photos' AND row_id = OLD.product_id;
  INSERT INTO change_feed (table_name, row_id, op, at, deleted_rev)
  VALUES ('product_photos', OLD.product_id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), OLD.rev);
END;
