import { writeFileSync } from 'node:fs'
import { PRIVACY } from './privacy.js'
const md = [
  '# Your shop\'s information and ShopOS',
  '',
  '> DRAFT for review by a lawyer before any shop is shown it. Generated from',
  '> `apps/portal/src/legal/privacy.ts`, which the portal serves at `/privacy`:',
  '> edit that file and run `npx tsx apps/portal/src/legal/write-notice.ts`.',
  '',
  ...PRIVACY.flatMap((s) => [`## ${s.heading}`, '', ...s.paragraphs.flatMap((p) => [p, ''])]),
].join('\n')
writeFileSync(new URL('../../../../docs/legal/privacy-notice.md', import.meta.url), md)
process.stdout.write('docs/legal/privacy-notice.md\n')
