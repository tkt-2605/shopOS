-- Bills emailed to the customers the shop chooses.
--
-- `customers.email_bills_since` is when somebody ticked "Email every bill" on
-- that customer, and null when nobody has. A date rather than a yes: only bills
-- rung from then on go out, so ticking it never mails a customer a year of old
-- bills, and taking the tick off and putting it back starts again from the
-- second time.
--
-- `bill_emails` is the main till's own note of which bills it has handed to its
-- outbox, so a bill is queued once and only once. It stays on the main: the
-- main is the only till that sends, and the outbox that holds the message until
-- the mail server takes it is on the main's disk too.
--
-- No backfill: every customer reads as not chosen, which is what they are.
--
-- Additive: a nullable column on customers, read by nothing that bills, prices
-- or taxes, and a table that never travels. A customer whose row last came
-- through a till below 073 arrives without the column and reads as not chosen;
-- the worst that does is stop that customer's emails until someone ticks it
-- again.

ALTER TABLE customers ADD COLUMN email_bills_since TEXT;

CREATE TABLE bill_emails (
  bill_id    TEXT PRIMARY KEY REFERENCES bills(id),
  to_address TEXT NOT NULL,
  queued_at  TEXT NOT NULL,
  -- Why it could not be queued, when it could not: the till has no mail set up,
  -- or the invoice would not render. Null once it is in the outbox.
  error      TEXT
) STRICT;
