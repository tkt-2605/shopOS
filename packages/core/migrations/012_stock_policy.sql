-- What the counter does when the count says there is nothing left.
--
-- Until now the till refused, full stop. That was never a decision anybody
-- made — it was the only branch that got written — so existing shops are moved
-- to 'warn' rather than left on a behaviour they did not choose. A shop that
-- genuinely wants the count enforced can say so in Settings; a shop that has
-- been quietly unable to sell the item in the customer's hand gets a counter
-- that works on Monday.
INSERT INTO settings (key, value, updated_at)
SELECT 'stock_policy', 'warn', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'stock_policy');
