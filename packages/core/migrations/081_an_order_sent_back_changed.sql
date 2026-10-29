-- An online order the shop changes and sends back.
--
-- The shop can answer a waiting order with a different list -- fewer of
-- something, an item it is out of taken off, another brand offered instead --
-- and a note. The customer sees the changes and either takes them, which puts
-- the changed list in place and returns the order to the shop to accept, or
-- cancels. Until they answer, the order stays waiting with the proposal beside
-- it; the lines they first asked for are untouched.
--
-- Additive: four nullable columns read only by the online-orders screens. A
-- till below 081 relays a row without them, and only the main writes them.

ALTER TABLE web_orders ADD COLUMN proposed_json TEXT;
ALTER TABLE web_orders ADD COLUMN proposal_note TEXT;
ALTER TABLE web_orders ADD COLUMN proposed_at TEXT;
ALTER TABLE web_orders ADD COLUMN proposed_by TEXT REFERENCES users(id);
ALTER TABLE web_orders ADD COLUMN agreed_at TEXT;
