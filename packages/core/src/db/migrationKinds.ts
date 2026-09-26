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
 * lie about a row an older till passed on. Across one of those, two tills cannot
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
 * One past the last breaking migration: everything from there to head is
 * additive, so a till anywhere in that range can exchange rows with this one.
 * A till below it is refused at the handshake, before a row moves.
 *
 * Derived rather than written down, because a number typed next to a list is a
 * number that stops matching the list. Adding a breaking migration raises this
 * on its own and cuts off every till below it -- which is the point, and is why
 * a migration is classified with some care.
 */
export const MIN_PEER_SCHEMA_VERSION: number = (() => {
  const lastBreaking = [...MIGRATION_FILES].reverse().find(([, , kind]) => kind === 'breaking')
  return (lastBreaking?.[0] ?? 0) + 1
})()
