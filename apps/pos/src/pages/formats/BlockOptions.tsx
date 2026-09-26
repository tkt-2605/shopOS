import { DocFormat as Fmt, type Block } from '@shopos/core'
import { Field } from '../../ui/components'

/** Only the blocks that have something to set say anything here. */
export function BlockOptions({ block, onChange }: {
  block: Block
  onChange: (opts: Fmt.BlockOpts) => void
}) {
  switch (block.kind) {
    case 'title':
      return (
        <Field label="Words across the top">
          <input
            className="input"
            value={block.opts?.label ?? ''}
            placeholder="TAX INVOICE"
            onChange={(e) => onChange({ ...block.opts, label: e.target.value })}
          />
        </Field>
      )

    case 'text':
      return (
        <div className="block-opts">
          <Field label="Your line">
            <input
              className="input"
              value={block.opts?.body ?? ''}
              placeholder="Queries: {{shop.phone}}"
              onChange={(e) => onChange({ ...block.opts, body: e.target.value })}
            />
          </Field>
          <p className="block-note">
            {Fmt.TOKENS.map((t) => `{{${t.token}}}`).join('  ')}
          </p>
        </div>
      )

    case 'space':
      return (
        <Field label="Blank lines">
          <input
            className="input num"
            type="number"
            min={1}
            max={6}
            value={block.opts?.lines ?? 1}
            onChange={(e) => onChange({ ...block.opts, lines: Number(e.target.value) })}
          />
        </Field>
      )

    default:
      return null
  }
}
