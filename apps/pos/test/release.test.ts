import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  releaseProblems, readReleaseInputs, releaseConfig, feedUrl, isMinisignPublicKey,
  manifest, findInstaller, targetFromArgs, retarget, describeTarget, firstShops,
} from '../../../tools/release'
import { LICENCE_KEYS } from '../../../packages/core/src/config/licensing'

/**
 * The steps of `release.yml` that are not the build: the tag check, the
 * config merged over `tauri.conf.json`, and the `latest.json` tills read.
 */

/** From `tauri signer generate` in a scratch folder; its private half was thrown away. */
const THROWAWAY_PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IENDQkY4NzFCODQzQTg2RUEKUldUcWhqcUVHNGUvekZOSWZlOFBxQUMwOW9pUFdFOXZubUNFTzYwcDVFZ2pzenV0UnIrbzAyYnMK'

const good = { version: '../package.json' }

describe('a release tag', () => {
  it('matches the package', () => {
    expect(releaseProblems({ tag: 'v0.2.0', packageVersion: '0.2.0', tauriConfig: good })).toEqual([])
  })

  it('is refused when the package was not bumped', () => {
    expect(releaseProblems({ tag: 'v0.2.0', packageVersion: '0.1.1', tauriConfig: good })[0]).toContain('does not match')
  })

  it('is refused when it is not a version at all', () => {
    expect(releaseProblems({ tag: 'release-2', packageVersion: '0.1.0', tauriConfig: good })[0]).toContain('not vX.Y.Z')
  })

  it('is refused when the config holds its own version or its own feed', () => {
    expect(releaseProblems({ tag: 'v0.1.0', packageVersion: '0.1.0', tauriConfig: { version: '0.1.0' } })).toHaveLength(1)
    expect(releaseProblems({
      tag: 'v0.1.0', packageVersion: '0.1.0', tauriConfig: { ...good, plugins: { updater: {} } },
    })).toHaveLength(1)
  })

  it('passes against the repository as it stands, which carries no feed of its own', () => {
    const inputs = readReleaseInputs('')
    expect(releaseProblems({ ...inputs, tag: `v${inputs.packageVersion}` })).toEqual([])
  })
})

describe('the release config', () => {
  const settings = { releaseRepo: 'tkt-2605/shopos-releases', updaterPubkey: THROWAWAY_PUBKEY }

  it('points tills at the public release repository and carries the key', () => {
    const made = releaseConfig(settings)
    if (!('config' in made)) throw new Error(made.problems.join('; '))
    expect(made.config).toEqual({
      plugins: {
        updater: {
          pubkey: THROWAWAY_PUBKEY,
          endpoints: ['https://github.com/tkt-2605/shopos-releases/releases/latest/download/latest.json'],
          windows: { installMode: 'passive' },
        },
      },
      bundle: { createUpdaterArtifacts: true },
    })
  })

  it('takes a feed on the vendor\'s own domain instead, and a signing command once there is one', () => {
    expect(feedUrl({ ...settings, feedUrl: 'https://updates.example.in/stable/latest.json' }))
      .toBe('https://updates.example.in/stable/latest.json')
    const made = releaseConfig({ ...settings, signCommand: 'signer sign "%1"' })
    expect('config' in made && made.config).toMatchObject({ bundle: { windows: { signCommand: 'signer sign "%1"' } } })
  })

  it('refuses the licence key where the updater key goes', () => {
    // It has happened the other way round in this repository already.
    expect(isMinisignPublicKey(LICENCE_KEYS[0]!.publicKey)).toBe(false)
    expect(isMinisignPublicKey(THROWAWAY_PUBKEY)).toBe(true)
    const made = releaseConfig({ ...settings, updaterPubkey: LICENCE_KEYS[0]!.publicKey })
    expect('problems' in made && made.problems[0]).toContain('not a minisign public key')
  })

  it('refuses a feed that is not https, and a repository that is not owner/repo', () => {
    const made = releaseConfig({ ...settings, releaseRepo: 'shopos', feedUrl: 'http://updates.example.in/latest.json' })
    expect('problems' in made && made.problems).toHaveLength(2)
  })
})

describe('latest.json', () => {
  it('names the version and points both windows keys at the installer', () => {
    const made = manifest({
      tag: 'v0.2.0', releaseRepo: 'tkt-2605/shopos-releases',
      installer: 'ShopOS_0.2.0_x64-setup.exe', signature: 'c2lnbmF0dXJl\n',
      now: new Date('2026-10-01T10:00:00Z'),
    })
    const entry = {
      signature: 'c2lnbmF0dXJl',
      url: 'https://github.com/tkt-2605/shopos-releases/releases/download/v0.2.0/ShopOS_0.2.0_x64-setup.exe',
    }
    expect(made).toEqual({
      version: '0.2.0', notes: '', pub_date: '2026-10-01T10:00:00.000Z',
      platforms: { 'windows-x86_64-nsis': entry, 'windows-x86_64': entry },
    })
  })

  it('finds the one installer for the version, and refuses one that was never signed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    writeFileSync(join(dir, 'ShopOS_0.1.9_x64-setup.exe'), '')
    writeFileSync(join(dir, 'ShopOS_0.2.0_x64-setup.exe'), '')
    expect(() => findInstaller(dir, '0.2.0')).toThrow('has no .sig')

    writeFileSync(join(dir, 'ShopOS_0.2.0_x64-setup.exe.sig'), 'sig')
    expect(findInstaller(dir, '0.2.0')).toEqual({ installer: 'ShopOS_0.2.0_x64-setup.exe', signature: 'sig' })
  })
})

describe('which shops a release is for', () => {
  const base = manifest({
    tag: 'v0.2.20', releaseRepo: 'o/r', installer: 'ShopOS_0.2.20_x64-setup.exe', signature: 's',
    now: new Date('2026-10-12T00:00:00Z'),
  })

  it('is every shop unless the release says otherwise, exactly as before', () => {
    expect(base).not.toHaveProperty('shops')
    expect(firstShops(undefined)).toBeNull()
    expect(firstShops('  ')).toBeNull()
  })

  it('goes first to the shops in RELEASE_FIRST_SHOPS', () => {
    const made = manifest({
      tag: 'v0.2.20', releaseRepo: 'o/r', installer: 'x', signature: 's', shops: firstShops('01a1256f, 51C78EEC'),
    })
    expect(made.shops).toEqual({ only: ['01a1256f', '51c78eec'] })
  })

  it('reads the options a person types', () => {
    expect(targetFromArgs(['--only', '01a1256f,51c78eec'])).toEqual({ target: { only: ['01a1256f', '51c78eec'] } })
    expect(targetFromArgs(['--hold', '51c78eec', '--percent', '30'])).toEqual({ target: { hold: ['51c78eec'], percent: 30 } })
    expect(targetFromArgs(['--percent', '0'])).toEqual({ target: { percent: 0 } })
    expect(targetFromArgs(['--all'])).toEqual({ target: null })
  })

  it('refuses what it cannot mean', () => {
    for (const args of [[], ['--only'], ['--only', 'abc'], ['--percent', '150'], ['--percent', 'half'],
      ['--all', '--only', '01a1256f'], ['--everyone']]) {
      expect('problems' in targetFromArgs(args), args.join(' ')).toBe(true)
    }
  })

  it('changes who gets a release and nothing else about it', () => {
    const narrowed = retarget(base, { only: ['01a1256f'] })
    expect(narrowed).toEqual({ ...base, shops: { only: ['01a1256f'] } })
    expect(retarget(narrowed, null)).toEqual(base)
  })

  it('says what it did in a sentence', () => {
    expect(describeTarget('0.2.20', null)).toBe('0.2.20 is for every shop')
    expect(describeTarget('0.2.20', { only: ['01a1256f'], hold: ['51c78eec'] }))
      .toBe('0.2.20 is for only 01a1256f; never 51c78eec')
    expect(describeTarget('0.2.20', { percent: 0 })).toBe('0.2.20 is halted: no shop is offered it')
    expect(describeTarget('0.2.20', { only: ['01a1256f'], percent: 0 })).toBe('0.2.20 is for only 01a1256f; halted for everyone else')
  })
})
