/**
 * The three steps of a release that are not the build itself.
 *
 *   npx tsx tools/release.ts check v0.2.0
 *   npx tsx tools/release.ts config            # writes src-tauri/tauri.release.json
 *   npx tsx tools/release.ts manifest v0.2.0   # writes latest.json beside the installer
 *   npx tsx tools/release.ts target v0.2.0 --only 01a1256f   # which shops get it
 *
 * `release.yml` runs them in that order. They are here rather than inline in
 * the workflow so that each is tested and can be run by hand.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readTarget, shortShopId, type ReleaseTarget } from '../packages/core/src/domain/updateTarget'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const RELEASE_CONFIG = join(root, 'apps/pos/src-tauri/tauri.release.json')
export const BUNDLE_DIR = join(root, 'target/release/bundle/nsis')

// ---------------------------------------------------------------- check

/**
 * One version number, `apps/pos/package.json`, which `tauri.conf.json` reads
 * by path. A tag that says otherwise would ship an installer whose About line
 * names one version while `latest.json` names another, and the updater
 * compares the two on every till.
 */
export interface ReleaseInputs {
  tag: string
  packageVersion: string
  tauriConfig: { version?: unknown; plugins?: Record<string, unknown> }
}

export function releaseProblems({ tag, packageVersion, tauriConfig }: ReleaseInputs): string[] {
  const problems: string[] = []
  const version = tag.startsWith('v') ? tag.slice(1) : null

  if (version === null || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    problems.push(`tag "${tag}" is not vX.Y.Z`)
  } else if (version !== packageVersion) {
    problems.push(`tag ${tag} does not match apps/pos/package.json (${packageVersion}); bump the package first`)
  }
  if (tauriConfig.version !== '../package.json') {
    problems.push(`tauri.conf.json "version" must be "../package.json", not ${JSON.stringify(tauriConfig.version)}`)
  }
  if (tauriConfig.plugins !== undefined && 'updater' in tauriConfig.plugins) {
    problems.push('tauri.conf.json carries plugins.updater; the feed and key come from the repository settings at release time')
  }
  return problems
}

export function readReleaseInputs(tag: string): ReleaseInputs {
  const pkg = JSON.parse(readFileSync(join(root, 'apps/pos/package.json'), 'utf8')) as { version: string }
  const conf = JSON.parse(readFileSync(join(root, 'apps/pos/src-tauri/tauri.conf.json'), 'utf8')) as ReleaseInputs['tauriConfig']
  return { tag, packageVersion: pkg.version, tauriConfig: conf }
}

// ---------------------------------------------------------------- config

export interface ReleaseSettings {
  /** `owner/repo` of the public repository tills download from. */
  releaseRepo: string
  /** The updater's public key, exactly as `tauri signer generate` printed it. */
  updaterPubkey: string
  /** Overrides the GitHub feed, for a feed on the vendor's own domain. */
  feedUrl?: string
  /** The CA's signing command, once there is a certificate; `%1` is the file. */
  signCommand?: string
}

/** Where tills look, unless the vendor has put a feed on their own domain. */
export function feedUrl(settings: Pick<ReleaseSettings, 'releaseRepo' | 'feedUrl'>): string {
  return settings.feedUrl?.trim() || `https://github.com/${settings.releaseRepo}/releases/latest/download/latest.json`
}

/**
 * What is merged over `tauri.conf.json` for a release build, and only then.
 *
 * Refuses the mistakes that cannot be taken back once a till has installed the
 * result: a feed that is not HTTPS, and a key that is not the updater's. The
 * second has happened in this repository already, the other way round -- the
 * updater's key pasted where the licence key goes -- and a till built with the
 * wrong one can never accept an update.
 */
export function releaseConfig(settings: ReleaseSettings): { config: object } | { problems: string[] } {
  const problems: string[] = []
  const feed = feedUrl(settings)

  if (!/^[\w.-]+\/[\w.-]+$/.test(settings.releaseRepo.trim())) {
    problems.push(`RELEASE_REPO "${settings.releaseRepo}" is not owner/repo`)
  }
  if (!feed.startsWith('https://')) problems.push(`the update feed "${feed}" is not https`)
  if (!isMinisignPublicKey(settings.updaterPubkey)) {
    problems.push('UPDATER_PUBKEY is not a minisign public key; paste the public half printed by `npx tauri signer generate`')
  }
  if (problems.length > 0) return { problems }

  const windows = settings.signCommand?.trim() ? { signCommand: settings.signCommand.trim() } : undefined
  return {
    config: {
      plugins: {
        updater: {
          pubkey: settings.updaterPubkey.trim(),
          endpoints: [feed],
          // A progress bar, not a wizard asking about folders: the app is
          // already closed, and a question nobody answers leaves the till down.
          windows: { installMode: 'passive' },
        },
      },
      bundle: { createUpdaterArtifacts: true, ...(windows ? { windows } : {}) },
    },
  }
}

export function isMinisignPublicKey(raw: string): boolean {
  let text: string
  try { text = Buffer.from(raw.trim(), 'base64').toString('utf8') } catch { return false }
  const [comment, key] = text.split('\n')
  if (!comment?.startsWith('untrusted comment:') || key === undefined) return false
  // "Ed" + 8-byte key id + 32-byte key.
  return Buffer.from(key.trim(), 'base64').length === 42
}

// ---------------------------------------------------------------- manifest

export interface Manifest {
  version: string
  notes: string
  pub_date: string
  platforms: Record<string, { signature: string; url: string }>
  /** Which shops the release is for (`domain/updateTarget.ts`). Absent: every shop. */
  shops?: ReleaseTarget
}

/**
 * The `latest.json` a till reads, pointing at the installer on the release.
 *
 * Both platform keys: `windows-x86_64-nsis` is what a till built with an
 * installer target asks for first, and plain `windows-x86_64` is its fallback.
 */
export function manifest(opts: {
  tag: string; releaseRepo: string; installer: string; signature: string; notes?: string; now?: Date
  shops?: ReleaseTarget | null
}): Manifest {
  const url = `https://github.com/${opts.releaseRepo}/releases/download/${opts.tag}/${encodeURIComponent(opts.installer)}`
  const entry = { signature: opts.signature.trim(), url }
  return retarget({
    version: opts.tag.replace(/^v/, ''),
    notes: opts.notes ?? '',
    pub_date: (opts.now ?? new Date()).toISOString(),
    platforms: { 'windows-x86_64-nsis': entry, 'windows-x86_64': entry },
  }, opts.shops ?? null)
}

// ---------------------------------------------------------------- target

/**
 * Which shops a release is for, from the command line:
 *
 *   --only 01a1256f,51c78eec   these shops and no others
 *   --hold 51c78eec            never these
 *   --percent 30               this share of the rest; 0 halts the release
 *   --all                      every shop, as a release without targeting
 *
 * A shop is its short id, the eight characters on its reports and its
 * Licence screen. `null` is `--all`.
 */
export function targetFromArgs(args: string[]): { target: ReleaseTarget | null } | { problems: string[] } {
  const problems: string[] = []
  const target: ReleaseTarget = {}
  let all = false
  const ids = (value: string | undefined, flag: string): string[] => {
    const list = (value ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '')
    if (list.length === 0) problems.push(`${flag} needs one or more shop ids, separated by commas`)
    for (const id of list) {
      if (!/^[0-9a-zA-Z-]+$/.test(id) || shortShopId(id).length < 8) problems.push(`"${id}" is not a shop id; use the 8 characters on its reports`)
    }
    return list.map(shortShopId)
  }
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--all') { all = true; continue }
    const value = args[i + 1]
    i += 1
    if (flag === '--only') target.only = ids(value, flag)
    else if (flag === '--hold') target.hold = ids(value, flag)
    else if (flag === '--percent') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 0 || n > 100) problems.push(`--percent needs a whole number from 0 to 100, not "${value ?? ''}"`)
      else target.percent = n
    } else problems.push(`unknown option "${flag ?? ''}"; expected --only, --hold, --percent or --all`)
  }
  if (all && Object.keys(target).length > 0) problems.push('--all cannot be combined with --only, --hold or --percent')
  if (!all && Object.keys(target).length === 0 && problems.length === 0) problems.push('say which shops: --only, --hold, --percent or --all')
  if (problems.length > 0) return { problems }
  return { target: all ? null : target }
}

/** The same release for different shops. Nothing else in it changes. */
export function retarget(m: Manifest, target: ReleaseTarget | null): Manifest {
  const { shops: _old, ...rest } = m
  return target === null ? rest : { ...rest, shops: target }
}

// ---------------------------------------------------------------- safety

/**
 * Whether `next` offers a release to more shops than `was`. Narrowing and
 * halting are never held up: they are what a bad release needs most.
 */
export function widens(was: ReleaseTarget | null, next: ReleaseTarget | null): boolean {
  if (next === null) return was !== null
  if (was === null) return false
  const reach = (t: ReleaseTarget) => t.only === undefined ? (t.percent ?? 100) : t.only.length > 0 ? 0.5 + t.only.length / 1000 : 0
  if (was.only !== undefined && next.only === undefined && (next.percent ?? 100) > 0) return true
  if ((next.only?.length ?? 0) > (was.only?.length ?? 0)) return true
  if ((was.hold?.length ?? 0) > (next.hold?.length ?? 0)) return true
  return reach(next) > reach(was)
}

/** What the portal says of one release (`apps/portal/src/health/releases.ts`). */
export interface ReleaseFigures {
  version: string
  tills: number
  clean: number
  panicked: number
  crashFree: number | null
}

/** Runs that must have ended before a release is judged; fewer is not a reason to stop. */
export const RUNS_TO_JUDGE = 20
/** How much worse than the release before it, in crash-free share, holds a rollout. */
export const CRASH_SLACK = 0.02

/**
 * Whether a release may go to more shops: not when it crashes noticeably
 * more often than the release before it did. Power cuts are already out of
 * these figures.
 */
export function crashGate(figures: readonly ReleaseFigures[], version: string): { ok: boolean; said: string } {
  const pct = (n: number) => `${(100 * n).toFixed(1)}%`
  const mine = figures.find((f) => f.version === version)
  if (mine === undefined || mine.crashFree === null || mine.clean + mine.panicked < RUNS_TO_JUDGE) {
    const runs = mine ? mine.clean + mine.panicked : 0
    return { ok: true, said: `${version} has ${runs} finished run(s) reported, too few to judge (${RUNS_TO_JUDGE} needed)` }
  }
  const before = figures
    .filter((f) => f.version !== version && f.crashFree !== null && compareVersions(f.version, version) < 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]
  if (before === undefined) return { ok: true, said: `${version} is ${pct(mine.crashFree)} crash-free; nothing earlier to compare with` }
  const ok = mine.crashFree >= before.crashFree! - CRASH_SLACK
  return {
    ok,
    said: `${version} is ${pct(mine.crashFree)} crash-free over ${mine.tills} till(s), against ${pct(before.crashFree!)} for ${before.version}`,
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(Number)
  const pb = b.split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (Number.isNaN(pa[i]) ? 0 : pa[i] ?? 0) - (Number.isNaN(pb[i]) ? 0 : pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * A hotfix: the next patch after a release that is out, cut from that
 * release and nothing newer, so it carries the one fix and nothing else
 * that has not been through a rollout.
 */
export function hotfixProblems(input: {
  tag: string; tags: readonly string[]; packageVersion: string; fromAncestor: (tag: string) => boolean; shops: readonly string[]
}): string[] {
  const problems: string[] = []
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(input.tag)
  if (m === null) return [`"${input.tag}" is not a release tag like v0.3.1`]
  const patch = Number(m[3])
  const previous = `v${m[1]}.${m[2]}.${patch - 1}`
  if (patch === 0) problems.push(`${input.tag} is not a patch: a hotfix is vX.Y.Z with Z above 0`)
  else if (!input.tags.includes(previous)) problems.push(`${previous} has no tag here; a hotfix follows a release that is out`)
  else if (!input.fromAncestor(previous)) problems.push(`this branch is not cut from ${previous}`)
  if (input.tags.includes(input.tag)) problems.push(`${input.tag} is already tagged`)
  if (input.packageVersion !== input.tag.slice(1)) problems.push(`apps/pos/package.json says ${input.packageVersion}; bump it to ${input.tag.slice(1)} first`)
  if (input.shops.length === 0) problems.push('name the shop or shops it is for first: --shops <id>,<id>')
  return problems
}

/** A hotfix tag carries its first shops in its message, as `shops: a, b`. */
export function shopsFromTagMessage(message: string | undefined): ReleaseTarget | null {
  const line = (message ?? '').split('\n').find((l) => /^shops:/i.test(l.trim()))
  return line === undefined ? null : firstShops(line.trim().slice('shops:'.length))
}

/** A sentence for the person who ran it. */
export function describeTarget(version: string, target: ReleaseTarget | null): string {
  if (target === null) return `${version} is for every shop`
  if (target.percent === 0 && !target.only) return `${version} is halted: no shop is offered it`
  const parts: string[] = []
  if (target.only) parts.push(`only ${target.only.join(', ')}`)
  if (target.percent !== undefined) parts.push(target.percent === 0 ? 'halted for everyone else' : `${target.percent}% of the others`)
  if (target.hold) parts.push(`never ${target.hold.join(', ')}`)
  return `${version} is for ${parts.join('; ')}`
}

/** The first shops a new release goes to, from the `RELEASE_FIRST_SHOPS` variable. */
export function firstShops(value: string | undefined): ReleaseTarget | null {
  const list = (value ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '').map(shortShopId)
  return list.length === 0 ? null : { only: list }
}

/** The one installer for this version in the bundle folder, and its signature. */
export function findInstaller(dir: string, version: string): { installer: string; signature: string } {
  const name = readdirSync(dir).filter((f) => f.endsWith('-setup.exe') && f.includes(`_${version}_`))
  if (name.length !== 1) throw new Error(`expected one installer for ${version} in ${dir}, found ${name.length}`)
  const sig = join(dir, `${name[0]}.sig`)
  if (!existsSync(sig)) throw new Error(`${name[0]} has no .sig: was TAURI_SIGNING_PRIVATE_KEY set?`)
  return { installer: name[0]!, signature: readFileSync(sig, 'utf8') }
}

// ---------------------------------------------------------------- cli

function fail(problems: string[]): never {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
  process.exit(1)
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [step, tag = ''] = process.argv.slice(2)
  const env = process.env
  const releaseRepo = env.RELEASE_REPO ?? ''

  if (step === 'check') {
    const problems = releaseProblems(readReleaseInputs(tag))
    if (problems.length > 0) fail(problems)
    process.stdout.write(`${tag} matches apps/pos/package.json\n`)
  } else if (step === 'config') {
    const made = releaseConfig({
      releaseRepo, updaterPubkey: env.UPDATER_PUBKEY ?? '',
      feedUrl: env.UPDATE_FEED_URL, signCommand: env.WINDOWS_SIGN_COMMAND,
    })
    if ('problems' in made) fail(made.problems)
    writeFileSync(RELEASE_CONFIG, `${JSON.stringify(made.config, null, 2)}\n`)
    process.stdout.write(`${RELEASE_CONFIG}\nfeed: ${feedUrl({ releaseRepo, feedUrl: env.UPDATE_FEED_URL })}\n`)
  } else if (step === 'manifest') {
    const found = findInstaller(BUNDLE_DIR, tag.replace(/^v/, ''))
    const out = join(BUNDLE_DIR, 'latest.json')
    // A hotfix tag names its own first shops; anything else starts where the repository says.
    const shops = shopsFromTagMessage(env.TAG_MESSAGE) ?? firstShops(env.RELEASE_FIRST_SHOPS)
    writeFileSync(out, `${JSON.stringify(manifest({ tag, releaseRepo, ...found, shops }), null, 2)}\n`)
    process.stdout.write(`${describeTarget(tag, shops)}\n`)
    process.stdout.write(`${out}\n`)
  } else if (step === 'target') {
    /* Rewrites latest.json on a release that already exists, draft or
       published, so a release can be widened, narrowed or halted without a
       rebuild. Uses the GitHub CLI, signed in to an account that can write
       to RELEASE_REPO. */
    if (!/^v\d+\.\d+\.\d+/.test(tag)) fail([`"${tag}" is not a release tag like v0.2.20`])
    if (!/^[\w.-]+\/[\w.-]+$/.test(releaseRepo)) fail(['set RELEASE_REPO to the owner/repo tills update from'])
    const options = process.argv.slice(4)
    const despite = options.includes('--despite-crashes')
    const chosen = targetFromArgs(options.filter((o) => o !== '--despite-crashes'))
    if ('problems' in chosen) fail(chosen.problems)
    const dir = mkdtempSync(join(tmpdir(), 'shopos-target-'))
    execFileSync('gh', ['release', 'download', tag, '--repo', releaseRepo, '--pattern', 'latest.json', '--dir', dir], { stdio: 'inherit' })
    const path = join(dir, 'latest.json')
    const current = JSON.parse(readFileSync(path, 'utf8')) as Manifest
    const was = readTarget(current.shops)
    if (widens(was, chosen.target)) {
      /* Wider: only if the release is not crashing more than the one before
         it, by the portal's figures. A portal not set up here is said, not
         taken as a pass in silence. */
      const portal = env.SHOPOS_PORTAL_URL
      const token = env.SHOPOS_ADMIN_TOKEN
      if (!portal || !token) {
        process.stderr.write('::warning::crash figures not checked: set SHOPOS_PORTAL_URL and SHOPOS_ADMIN_TOKEN\n')
      } else {
        const res = await fetch(`${portal.replace(/\/$/, '')}/v1/releases`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) fail([`the portal would not give crash figures: HTTP ${res.status}`])
        const gate = crashGate(((await res.json()) as { releases: ReleaseFigures[] }).releases, current.version)
        process.stdout.write(`${gate.said}\n`)
        if (!gate.ok && !despite) fail([`not widening ${current.version}: it crashes more than the release before it. Add --despite-crashes to go ahead anyway.`])
      }
    }
    const next = retarget(current, chosen.target)
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
    execFileSync('gh', ['release', 'upload', tag, path, '--repo', releaseRepo, '--clobber'], { stdio: 'inherit' })
    process.stdout.write(`was: ${describeTarget(current.version, was)}\nnow: ${describeTarget(next.version, chosen.target)}\n`)
  } else if (step === 'hotfix') {
    /* Tags a hotfix that goes first to the shops it is for. The tag's message
       carries them, and the manifest step reads it, so the fix reaches the
       shop that rang without reaching every shop the same hour. */
    const at = process.argv.indexOf('--shops')
    const shops = (at >= 0 ? process.argv[at + 1] ?? '' : '').split(',').map((s) => s.trim()).filter(Boolean)
    const git = (...a: string[]) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
    const problems = hotfixProblems({
      tag,
      tags: git('tag', '--list', 'v*').split('\n').filter(Boolean),
      packageVersion: readReleaseInputs(tag).packageVersion,
      fromAncestor: (t) => { try { git('merge-base', '--is-ancestor', t, 'HEAD'); return true } catch { return false } },
      shops,
    })
    if (problems.length > 0) fail(problems)
    git('tag', '-a', tag, '-m', `hotfix ${tag}\n\nshops: ${shops.map(shortShopId).join(', ')}`)
    process.stdout.write([
      `tagged ${tag}, first to ${shops.map(shortShopId).join(', ')}.`,
      `push it to build: git push origin ${tag}`,
      `then, after a day with no crashes: npx tsx tools/release.ts target ${tag} --all`,
      '',
    ].join('\n'))
  } else {
    fail([`unknown step "${step ?? ''}"; expected check, config, manifest, target or hotfix`])
  }
}
