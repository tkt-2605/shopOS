import { useRef, useState } from 'react'
import { HtmlTemplate as Tpl } from '@shopos/core'

/**
 * The box a shop writes its own invoice in.
 *
 * Three ways in, because the three kinds of shop that want this arrive
 * differently: one presses "Start from the built-in design" and moves things
 * around; one has a letterhead somebody already made and imports the file; one
 * knows exactly what they want and types it. The token list is on the screen
 * rather than in a manual, because a name that has to be looked up elsewhere is
 * a name that gets guessed.
 */
export function TemplateEditor({ value, onChange }: {
  value: string
  onChange: (template: string) => void
}) {
  const file = useRef<HTMLInputElement>(null)
  const [showTokens, setShowTokens] = useState(false)

  async function importFile(chosen: File | undefined) {
    if (!chosen) return
    /* Read here rather than kept as a path: the file is the shop's starting
       point, not a link. A template that read off the disk at print time would
       print nothing the day somebody tidied their Downloads folder. */
    onChange(await chosen.text())
  }

  return (
    <div className="template-editor">
      <div className="template-tools">
        <button type="button" className="btn sm" onClick={() => onChange(Tpl.STARTER_TEMPLATE)}>
          Start from the built-in design
        </button>
        <button type="button" className="btn sm" onClick={() => file.current?.click()}>
          Import an HTML file…
        </button>
        <input
          ref={file}
          type="file"
          accept=".html,.htm,text/html"
          hidden
          onChange={(e) => {
            void importFile(e.target.files?.[0])
            // Cleared, so choosing the same file twice in a row still fires.
            e.target.value = ''
          }}
        />
        <span style={{ flex: 1 }} />
        <button type="button" className="btn ghost sm" onClick={() => setShowTokens((on) => !on)}>
          {showTokens ? 'Hide the tokens' : 'What can I put in it?'}
        </button>
      </div>

      <textarea
        className="input template-source"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste your invoice HTML here, or start from the built-in design."
      />

      <p className="block-note">
        Plain HTML and CSS. The page size, its margins and the page breaks are
        already set for you, so what you write is the invoice itself. Scripts,
        frames and anything fetched off the internet are refused — a bill has to
        print the same with the line down.
      </p>

      {showTokens && (
        <div className="token-list">
          {Tpl.TEMPLATE_TOKENS.map((t) => (
            <div key={t.token} className="token-row">
              <code>{`{{${t.token}}}`}</code>
              <span>
                {t.means}
                {t.section && <em> — only inside {`{{#${t.section}}}`}</em>}
              </span>
            </div>
          ))}
          <div className="token-row">
            <code>{'{{#items}} … {{/items}}'}</code>
            <span>Repeats once for every line on the bill.</span>
          </div>
          <div className="token-row">
            <code>{'{{#payments}} … {{/payments}}'}</code>
            <span>Repeats once for every way it was paid.</span>
          </div>
          <div className="token-row">
            <code>{'{{#if customer.gstin}} … {{/if}}'}</code>
            <span>Prints what is between them only when that token has something in it.</span>
          </div>
          <div className="token-row">
            <code>{'{{^if customer.gstin}} … {{/if}}'}</code>
            <span>The opposite — only when it is empty. For a fallback line.</span>
          </div>
        </div>
      )}
    </div>
  )
}
