/**
 * Every migration, and whether a till one version behind can still be talked to.
 *
 * This file holds the list and nothing else -- no `node:fs`, no bundler glob --
 * because both of the places that carry the migrations need the classification
 * and neither can load the other. `db/migrations.ts` reads the .sql files off
 * disk for tests and tooling; the app globs the same folder through Vite; and
 * `services/sync.ts` runs in the webview, where `node:fs` does not exist. A
 * plain array can be imported by all three.
 *
 * ## What the two words mean
 *
 * `additive` is a change that leaves every row an older build wrote still
 * readable and writable by it: a new table, a new index, a new trigger, a
 * column added nullable or with a default, a row inserted or corrected.
 *
 * A defaulted column is only additive when the default is *true* of every row
 * the newer build writes. An older till cannot send what it has not got, so a
 * row that reaches a newer till by way of an older one -- a hub relaying it,
 * or an older till's copy winning a merge -- arrives without the column and is
 * stored with the default. A default that changes what the row *means* (the
 * direction money moved, an amount owed) turns that into a wrong figure on a
 * till that was never out of date. `REVIEWED_DEFAULTS` below is where each
 * defaulted column on a replicated table has to say why that cannot happen.
 *
 * `breaking` is anything else -- a rename, a drop, a CHECK made stricter, a
 * table rebuilt into a new shape, a defaulted column whose default would be a
 * lie about a row an older till passed on -- and a column that carries a rule
 * an older till would not follow: one that changes what a till bills, prices,
 * taxes or allows. The rows cross safely and the old till then sells by the
 * old rule. 068 is the example: the loose item reached a 0.2.5 till intact, and
 * that till billed it at nothing, because it had never heard of an amount
 * typed at the counter. The owner's answer to a till that cannot keep up is
 * that it stops syncing until it is updated (`update-rollout.md`, section 10),
 * and that answer only reaches it through this word. Across one of those, two tills cannot
 * exchange rows safely in either direction: the newer one writes columns the
 * older has no place for, and the older sends rows missing columns the newer
 * has made NOT NULL.
 *
 * ## The bias is deliberate
 *
 * The two mistakes are not the same size. Calling a breaking migration additive
 * lets two tills corrupt each other's books quietly; calling an additive one
 * breaking refuses a sync that would have been fine, and somebody updates the
 * other till. So anything not obviously safe is `breaking`, and `030` is the
 * standing example -- it drops two tables that nothing replicates, so sync
 * would very likely survive it, and it is marked breaking anyway, because "very
 * likely" is not the standard to apply to somebody else's books.
 *
 * **A new migration is added here in the same commit as its file.**
 * `migrations.test.ts` fails if this list and the folder disagree.
 */

export type MigrationKind = 'additive' | 'breaking'

export const MIGRATION_FILES: ReadonlyArray<readonly [number, string, MigrationKind]> = [
  // The first one. There is no version before it to be compatible with.
  [1, '001_initial.sql', 'breaking'],
  [2, '002_stock_value.sql', 'additive'],
  [3, '003_margin_guards.sql', 'additive'],
  [4, '004_attachments.sql', 'additive'],
  [5, '005_stock_counts.sql', 'additive'],
  [6, '006_reorder.sql', 'additive'],
  [7, '007_barcodes.sql', 'additive'],
  [8, '008_pricing_page.sql', 'additive'],
  [9, '009_grouping.sql', 'additive'],
  // `customer_item_prices` rebuilt into a new shape and renamed over the old.
  [10, '010_customer_ladders.sql', 'breaking'],
  [11, '011_features_and_returns.sql', 'additive'],
  [12, '012_stock_policy.sql', 'additive'],
  [13, '013_customer_identity.sql', 'additive'],
  [14, '014_doc_formats.sql', 'additive'],
  // `doc_formats` rebuilt and renamed, the same way.
  [15, '015_sheet_formats.sql', 'breaking'],
  [16, '016_documents.sql', 'additive'],
  [17, '017_bill_from_order.sql', 'additive'],
  [18, '018_sheet_templates.sql', 'additive'],
  [19, '019_device_provenance.sql', 'additive'],
  [20, '020_settings_revision.sql', 'additive'],
  [21, '021_change_feed.sql', 'additive'],
  [22, '022_document_revision.sql', 'additive'],
  [23, '023_sync_peers.sql', 'additive'],
  [24, '024_shop_identity.sql', 'additive'],
  [25, '025_pairing.sql', 'additive'],
  [26, '026_sync_visibility.sql', 'additive'],
  [27, '027_doc_no_length.sql', 'additive'],
  [28, '028_invoice_snapshot.sql', 'additive'],
  [29, '029_document_says_what_it_is.sql', 'additive'],
  // `activity_log` and `sync_queue` dropped. See the note on bias above.
  [30, '030_two_tables_nobody_read.sql', 'breaking'],
  // `price_lists.is_active` dropped.
  [31, '031_one_way_to_retire_a_price_list.sql', 'breaking'],
  // `users.deleted_at` and `roles.deleted_at` dropped.
  [32, '032_the_retirement_that_never_was.sql', 'breaking'],
  [33, '033_a_setting_nothing_asks_for.sql', 'additive'],
  [34, '034_two_questions_the_tables_would_not_answer.sql', 'additive'],
  /* Breaking, although it only adds a column. A refund row relayed by a till
     that has not run this arrives without `direction` and is stored as 'in':
     the refund booked as a receipt, the customer's balance out by twice the
     amount, on a till that was up to date. Reclassified before release. */
  [35, '035_money_that_goes_the_other_way.sql', 'breaking'],
  [36, '036_a_hub_that_relays.sql', 'additive'],
  /* A column on a replicated table. A till that has not run this migration
     does not send it and drops it from what arrives -- `ignoredColumns` is the
     machinery for exactly that -- so the two still exchange every row. What it
     does not get is the claim, which is a shop that cannot be protected from
     two tills on one counter until both are updated. That is a reason to
     update, not a reason to refuse to sync. */
  [37, '037_a_counter_says_which_till_sits_at_it.sql', 'additive'],
  [38, '038_a_record_that_cannot_land.sql', 'additive'],
  [39, '039_a_merge_is_not_an_edit.sql', 'additive'],
  [40, '040_a_delete_says_what_it_was.sql', 'additive'],
  [41, '041_a_layout_the_shop_has_finished_with.sql', 'additive'],
  [42, '042_a_bill_nobody_has_rung_up.sql', 'additive'],
  [43, '043_one_default_without_an_index.sql', 'additive'],
  [44, '044_a_peer_says_how_to_reach_it.sql', 'additive'],
  [45, '045_a_claim_with_a_date_on_it.sql', 'additive'],
  [46, '046_two_clocks_drifting.sql', 'additive'],
  [47, '047_a_place_for_a_fingerprint.sql', 'additive'],
  [48, '048_nothing_to_send_is_not_silence.sql', 'additive'],
  [49, '049_a_sign_in_is_not_a_shop_fact.sql', 'additive'],
  /* Two defaulted columns on `suppliers`, and breaking for the same reason
     as 035: a supplier relayed by an older till lands on a newer one owing
     nothing, whatever the shop recorded. Reclassified before release. */
  [50, '050_what_the_shop_owed_before.sql', 'breaking'],
  [51, '051_points_that_move.sql', 'additive'],
  [52, '052_what_the_database_holds_itself.sql', 'additive'],
  [53, '053_points_as_first_earned.sql', 'additive'],
  [54, '054_what_an_order_became.sql', 'additive'],
  [55, '055_what_a_row_may_hold.sql', 'additive'],
  [56, '056_a_barcode_taken_off.sql', 'additive'],
  [57, '057_a_return_nobody_has_given.sql', 'additive'],
  [58, '058_what_a_movement_was_worth.sql', 'additive'],
  [59, '059_a_submitted_document_is_final.sql', 'additive'],
  [60, '060_whose_shelf_count.sql', 'additive'],
  [61, '061_a_peer_that_does_not_come_back.sql', 'additive'],
  /* Three new tables and nothing changed on an old one. A till below this
     skips batch rows as a table it does not have, which is 054's case. */
  [62, '062_a_batch_and_the_day_it_expires.sql', 'additive'],
  /* Defaulted columns whose defaults -- no cess, rates include tax -- would be
     a lie about a product or a list an older till relayed. See the file. */
  [63, '063_cess_and_rates_before_tax.sql', 'breaking'],
  /* One new table and nothing changed on an old one. A till below this skips
     ledger rows as a table it does not have, which is 054's case. */
  [64, '064_the_books.sql', 'additive'],
  /* Defaulted columns that would be a lie about a purchase an older till
     relayed -- no tax and owing nothing -- and a guard rebuilt. */
  [65, '065_what_a_supplier_billed.sql', 'breaking'],
  /* A column on `sync_state`, which never travels. */
  [66, '066_the_books_filled_once.sql', 'additive'],
  /* A table that never travels. */
  [67, '067_discrepancies_seen.sql', 'additive'],
  /* A column that carries a rule: an older till holds the loose item without
     it and bills it at nothing. Shipped as additive in 0.2.6 and corrected in
     0.2.7 -- a 0.2.6 till still talks to a 0.2.5 one, every later build does not. */
  [68, '068_an_item_priced_at_the_counter.sql', 'breaking'],
  /* A UNIQUE dropped: a till below this would refuse the second item's row
     for a code and stop its sync partway through a batch. */
  [69, '069_one_barcode_several_items.sql', 'breaking'],
  /* A batch's own price: a till below this bills the new pack at the item's
     old price. The other two columns only record. */
  [70, '070_a_batch_has_its_own_price.sql', 'breaking'],
  /* Two columns on `sync_state`, which never travels. */
  [71, '071_one_main_till.sql', 'additive'],
  [72, '072_a_claim_says_when_it_was_granted.sql', 'additive'],
  /* A nullable column read by nothing that bills, and a table that never travels. */
  [73, '073_bills_emailed_to_chosen_customers.sql', 'additive'],
  /* A nullable cost on products: a default for the person typing, read by
     nothing that bills, prices, taxes or values stock. */
  [74, '074_an_item_has_a_cost_price.sql', 'additive'],
  /* When that cost was set, nullable: decides only which of two suggestions is shown. */
  [75, '075_a_cost_price_says_when.sql', 'additive'],
  // A new replicated record; a till below it skips the records as a table it has not got.
  [76, '076_every_till_knows_which_bills_were_emailed.sql', 'additive'],
  [77, '077_a_main_that_hands_over_keeps_answering.sql', 'additive'],
  /* A CHECK widened to let an order line be closed short: a till below it refuses
     the row, and would show a closed order as open and receive against it. */
  [78, '078_an_order_closed_short.sql', 'breaking'],
  [79, '079_a_box_has_its_own_mrp.sql', 'breaking'],
  // New tables only; a till below it skips their records as tables it has not got.
  [80, '080_orders_from_the_web.sql', 'additive'],
  /* Nullable columns on web_orders, written only by the main and read only by
     the online-orders screens; a till below it relays an order without them. */
  [81, '081_an_order_sent_back_changed.sql', 'additive'],
  /* Zero credit limit turns from "no limit" into "no credit": a till below it
     would give unlimited credit to a customer marked No credit. */
  [82, '082_a_zero_limit_is_no_credit.sql', 'breaking'],
  /* Nullable columns on web_accounts, written and read only by the main as it
     answers the storefront; a till below it relays an account without them. */
  [83, '083_an_online_customer_can_be_stopped.sql', 'additive'],
  // A new table that stays on each till; nothing about it crosses.
  [84, '084_what_each_migration_said.sql', 'additive'],
]

/**
 * Every defaulted or NOT NULL column added to a replicated table by an additive
 * migration, keyed `file:table.column`, with the reason its default is true of
 * a row an older till passes on. `migration-files.test.ts` fails on one that is
 * not here, so the question gets asked at the moment it can still be answered
 * by calling the migration breaking instead.
 */
export const REVIEWED_DEFAULTS: Readonly<Record<string, string>> = {
  '051_points_that_move.sql:loyalty_entries.rev':
    'A revision, not a figure: 1 is what every row starts at, and no till below 051 '
    + 'is above the floor 050 set, so none can relay an entry without it.',
  '072_a_claim_says_when_it_was_granted.sql:registers.claim_seq':
    'Grant 0 is what every claim made by the old rule is. A till below 072 grants and relays '
    + 'claims with no number; a counter it sends arrives as grant 0, and two of those are settled '
    + 'by the rule they always were.',
  '076_every_till_knows_which_bills_were_emailed.sql:bill_emails.rev':
    'A revision, not a figure: 1 is what every note starts at, and no till below 076 replicates '
    + 'bill_emails, so none can relay a note without it.',
}

/**
 * Columns nothing reads or writes any more, kept only because dropping a
 * column means rebuilding its table -- a breaking migration. Each is named
 * with the migration that retired it, so the next rebuild of that table takes
 * it along instead of it being forgotten.
 */
export const DROP_AT_NEXT_REBUILD: ReadonlyArray<readonly [column: string, retiredBy: string]> = [
  ['price_lists.is_default', '043: the default is the `default_price_list` setting'],
  /* Not `users.failed_logins` or `last_login_at`: since 049 they are the
     fallback for a till that cannot say which machine it is, and still used. */
  ['users.locked_until', '049: nothing locks an account; only ever reset to null'],
]

/**
 * The oldest schema this build will sync with.
 *
 * The last breaking migration itself: a till that has run it has the shape it
 * made, and everything after it is additive, so a till anywhere from there to
 * head can exchange rows with this one. A till below it is refused at the
 * handshake, before a row moves.
 *
 * It was one *past* the last breaking migration until 4 October, which kept out
 * a till that had already run it -- harmless while every breaking migration
 * had an additive one after it, and a shop that could not sync with itself the
 * first time the newest migration was breaking (063).
 *
 * Derived rather than written down, because a number typed next to a list is a
 * number that stops matching the list. Adding a breaking migration raises this
 * on its own and cuts off every till below it -- which is the point, and is why
 * a migration is classified with some care.
 */
export const MIN_PEER_SCHEMA_VERSION: number = (() => {
  const lastBreaking = [...MIGRATION_FILES].reverse().find(([, , kind]) => kind === 'breaking')
  return lastBreaking?.[0] ?? 0
})()
