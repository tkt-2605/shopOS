import type { SqlDriver } from '../db/driver.js'
import type { DocFormat } from '../domain/docFormat.js'
import { DEFAULT_FORMATS } from '../domain/docFormat.js'

export async function listFormats(db: SqlDriver, paper?: string): Promise<DocFormat[]> {
  let sql = 'SELECT id, name, paper, kinds, blocks, created_at as createdAt, updated_at as updatedAt FROM doc_formats'
  const params: any[] = []

  if (paper) {
    sql += ' WHERE paper = ?'
    params.push(paper)
  }

  sql += ' ORDER BY created_at'

  const rows = await db.query<{
    id: string
    name: string
    paper: 'thermal_58' | 'thermal_80' | 'a4' | 'a5'
    kinds: string
    blocks: string
    createdAt: string
    updatedAt: string
  }>(sql, params)

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    paper: row.paper,
    kinds: JSON.parse(row.kinds),
    blocks: JSON.parse(row.blocks),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

export async function loadFormat(db: SqlDriver, formatId: string): Promise<DocFormat | null> {
  const row = await db.get<{
    id: string
    name: string
    paper: 'thermal_58' | 'thermal_80' | 'a4' | 'a5'
    kinds: string
    blocks: string
    createdAt: string
    updatedAt: string
  }>(
    'SELECT id, name, paper, kinds, blocks, created_at as createdAt, updated_at as updatedAt FROM doc_formats WHERE id = ?',
    [formatId],
  )

  if (!row) return null

  return {
    id: row.id,
    name: row.name,
    paper: row.paper,
    kinds: JSON.parse(row.kinds),
    blocks: JSON.parse(row.blocks),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function getDefaultFormat(db: SqlDriver, paper: string, docKind: string = 'bill'): Promise<DocFormat | null> {
  const formats = await listFormats(db, paper)

  for (const fmt of formats) {
    if (fmt.kinds.includes(docKind)) {
      return fmt
    }
  }

  const defaults = DEFAULT_FORMATS.filter((f) => f.paper === paper && f.kinds.includes(docKind))
  return defaults.length > 0 ? defaults[0]! : null
}

export async function saveFormat(db: SqlDriver, format: DocFormat): Promise<void> {
  const now = new Date().toISOString()

  const existing = await loadFormat(db, format.id)

  if (existing) {
    await db.execute(
      `UPDATE doc_formats SET name = ?, paper = ?, kinds = ?, blocks = ?, updated_at = ? WHERE id = ?`,
      [
        format.name,
        format.paper,
        JSON.stringify(format.kinds),
        JSON.stringify(format.blocks),
        now,
        format.id,
      ],
    )
  } else {
    await db.execute(
      `INSERT INTO doc_formats (id, name, paper, kinds, blocks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        format.id,
        format.name,
        format.paper,
        JSON.stringify(format.kinds),
        JSON.stringify(format.blocks),
        now,
        now,
      ],
    )
  }
}

export async function deleteFormat(db: SqlDriver, formatId: string): Promise<void> {
  // Prevent deletion of default formats
  if (formatId === 'thermal_default' || formatId === 'a4_default') {
    throw new Error('Cannot delete default formats')
  }

  await db.execute('DELETE FROM doc_formats WHERE id = ?', [formatId])
}
