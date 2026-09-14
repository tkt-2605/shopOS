import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Migration } from './migrate.js'
import { EXPECTED_SCHEMA_VERSION } from './schemaVersion.js'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', 'migrations')

const FILES: ReadonlyArray<readonly [number, string]> = [
  [1, '001_initial.sql'],
  [2, '002_stock_value.sql'],
  [3, '003_margin_guards.sql'],
  [4, '004_attachments.sql'],
  [5, '005_stock_counts.sql'],
  [6, '006_reorder.sql'],
  [7, '007_barcodes.sql'],
  [8, '008_pricing_page.sql'],
  [9, '009_grouping.sql'],
  [10, '010_customer_ladders.sql'],
  [11, '011_features_and_returns.sql'],
  [12, '012_stock_policy.sql'],
  [13, '013_customer_identity.sql'],
  [14, '014_doc_formats.sql'],
  [15, '015_sheet_formats.sql'],
  [16, '016_documents.sql'],
  [17, '017_bill_from_order.sql'],
  [18, '018_sheet_templates.sql'],
  [19, '019_device_provenance.sql'],
  [20, '020_settings_revision.sql'],
  [21, '021_change_feed.sql'],
  [22, '022_document_revision.sql'],
  [23, '023_sync_peers.sql'],
  [24, '024_shop_identity.sql'],
  [25, '025_pairing.sql'],
  [26, '026_sync_visibility.sql'],
]

export const MIGRATIONS: Migration[] = FILES.map(([version, file]) => ({
  version,
  name: file,
  sql: readFileSync(join(migrationsDir, file), 'utf8'),
}))

/* Adding the file and adding it here are two steps and one gets forgotten. This
   is the third place that has to agree, so it checks rather than trusts. */
const highest = FILES[FILES.length - 1]?.[0] ?? 0
if (highest !== EXPECTED_SCHEMA_VERSION) {
  throw new Error(
    `migration list ends at ${highest} but the code expects ${EXPECTED_SCHEMA_VERSION}`,
  )
}
