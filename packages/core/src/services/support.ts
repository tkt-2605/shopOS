import type { SqlDriver } from '../db/driver.js'
import { writeAudit } from '../integrity/audit.js'

/*
 * What support was given, written where the shop keeps everything else it
 * did: the audit log. The data itself is made and sent by the till's Rust
 * side (`support_data.rs`); this is the shop's own record that it went, who
 * sent it, and whether the customers were left out.
 */

export async function noteDataForSupport(
  db: SqlDriver,
  input: { actorId: string; fileId: string; anonymised: boolean; bytes: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    await writeAudit(tx, { actorId: input.actorId }, {
      entity: 'settings', entityId: 'support_data', action: 'create',
      after: { support_data: input.fileId, anonymised: input.anonymised ? 1 : 0, bytes: input.bytes },
    })
  })
}
