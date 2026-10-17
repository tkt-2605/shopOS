import { useState } from 'react'
import { deviceSetting, setDeviceSetting } from '../core/device'
import { searchArticles, type Lang } from '../help/articles'

/**
 * "How do I…", on the Get help screen: short steps for what goes wrong, in
 * English or Tamil, opened from the app so they work with the line down.
 * The language chosen is this machine's, remembered for next time.
 */

const LANG = 'help_lang'

export function HelpArticles() {
  const [lang, setLang] = useState<Lang>(deviceSetting(LANG) === 'ta' ? 'ta' : 'en')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const found = searchArticles(query, lang)

  const choose = (next: Lang) => {
    setLang(next)
    void setDeviceSetting(LANG, next)
  }

  return (
    <section>
      <div className="get-help-row" style={{ justifyContent: 'space-between' }}>
        <div className="get-help-label">{lang === 'ta' ? 'எப்படிச் செய்வது' : 'How do I…'}</div>
        <div className="get-help-row" role="group" aria-label="Language">
          <button className={`btn sm${lang === 'en' ? ' primary' : ''}`} aria-pressed={lang === 'en'} onClick={() => choose('en')}>English</button>
          <button className={`btn sm${lang === 'ta' ? ' primary' : ''}`} aria-pressed={lang === 'ta'} onClick={() => choose('ta')}>தமிழ்</button>
        </div>
      </div>
      <input
        className="input" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder={lang === 'ta' ? 'தேடுக, எ.கா. password' : 'Search, e.g. paid twice'}
        aria-label={lang === 'ta' ? 'உதவியைத் தேடுக' : 'Search help'}
      />
      <div className="help-articles">
        {found.length === 0 && <p className="get-help-note">{lang === 'ta' ? 'எதுவும் கிடைக்கவில்லை.' : 'Nothing matches. Ask support.'}</p>}
        {found.map((a) => (
          <div key={a.id} className="help-article">
            <button className="link-btn" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
              {a.title[lang]}
            </button>
            {open === a.id && (
              <ol>
                {a.steps[lang].map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
