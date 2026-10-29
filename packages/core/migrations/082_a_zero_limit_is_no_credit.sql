-- A credit limit of zero now means no credit (decided 28 Oct).
--
-- Until now zero meant "no limit": a customer left at the default could run
-- up any amount on the khata, and a shopkeeper who typed 0 to say "this one
-- pays cash" had given them unlimited credit instead. From here zero is no
-- credit at all, blocked or warned as the customer's setting says, and a
-- customer who may owe any amount says so with enforcement `none`, shown as
-- "No limit".
--
-- ## Customers already on zero
--
-- Moved to `none`, which is exactly what zero did for them yesterday: nobody
-- who bought on credit this morning is refused this afternoon. The shop can
-- then set a limit, or "No credit", customer by customer.
--
-- Inside the `applying` bracket, as 079 seeds: every till works this out the
-- same from the same rows, and feeding it would make conflicts out of a change
-- nobody typed. `rev` is raised here so the rev trigger leaves it alone, the
-- same on every till.
--
-- Breaking: a till below it reads zero as no limit, and would let a customer
-- marked "No credit" here take the whole shop's stock on the khata.

UPDATE sync_state SET applying = 1 WHERE id = 1;

UPDATE customers
   SET credit_enforcement = 'none', rev = rev + 1
 WHERE credit_limit = 0 AND credit_enforcement <> 'none';

UPDATE sync_state SET applying = 0 WHERE id = 1;
