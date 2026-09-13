-- One customer per phone number, and a bill that is not a sale.
--
-- The phone rule starts on, because entering the same person twice is the
-- common case and the shop should be protected from it by default — except in
-- a shop whose data already shows it doing the opposite. A household sharing
-- one phone between two khata accounts is a real arrangement, and a switch that
-- turned itself on and started refusing saves would be the software overruling
-- something the shop decided on purpose.
INSERT INTO settings (key, value, updated_at)
SELECT 'feature_unique_phone',
       CASE WHEN EXISTS (
         SELECT 1 FROM customers
          WHERE phone IS NOT NULL AND phone <> '' AND deleted_at IS NULL
          GROUP BY phone HAVING COUNT(*) > 1
       ) THEN 'off' ELSE 'on' END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'feature_unique_phone');

-- What a customer owed before this shop started using ShopOS has to live
-- somewhere the khata can allocate payments against, and the only thing
-- payments allocate against is a bill. So it is a bill — and is marked, so that
-- no sales report ever counts it as something the shop sold.
ALTER TABLE bills ADD COLUMN kind TEXT NOT NULL DEFAULT 'sale'
  CHECK (kind IN ('sale', 'opening'));

CREATE INDEX idx_bills_kind ON bills(kind) WHERE kind <> 'sale';
