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
 * `breaking` is anything else -- a rename, a drop, a CHECK made stricter, a
 * table rebuilt into a new shape. Across one of those, two tills cannot
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
  [35, '035_money_that_goes_the_other_way.sql', 'additive'],
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
