#!/usr/bin/env node
// Builds one release binary of the POS app per till config, and
// copies each one out before the next build overwrites target/release. Each
// config only changes `identifier` (which is what Tauri's app_data_dir keys
// on) and window placement, so every till keeps its own shop.db and its own
// spot on screen. Run via `npm run till:build` from apps/pos -- Tauri
// resolves --config relative to the app root, not this file's folder.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcTauri = dirname(fileURLToPath(import.meta.url))
const appRoot = join(srcTauri, '..')
// A Cargo workspace member builds into the *workspace* root's target/, not
// its own -- apps/pos/src-tauri/target is a decoy left by rust-analyzer.
const workspaceRoot = join(srcTauri, '..', '..', '..')
const exeName = 'shopos-pos.exe'
const tills = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map(Number)
  : [1, 2, 3, 4]

for (const n of tills) {
  console.log(`\n=== Building till ${n} ===`)
  const result = spawnSync(
    'npx',
    ['tauri', 'build', '--no-bundle', '--config', join('src-tauri', `tauri.till${n}.json`)],
    { cwd: appRoot, stdio: 'inherit', shell: true },
  )
  if (result.status !== 0) {
    console.error(`till ${n} build failed`)
    process.exit(result.status ?? 1)
  }

  const outDir = join(srcTauri, 'target', 'tills', `till-${n}`)
  mkdirSync(outDir, { recursive: true })
  try {
    copyFileSync(join(workspaceRoot, 'target', 'release', exeName), join(outDir, exeName))
  } catch (err) {
    // Windows holds a running exe open, and the stack trace for it says
    // "EBUSY" and nothing about what to do.
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      console.error(`\ntill ${n} is running. Close it and run this again.`)
      process.exit(1)
    }
    throw err
  }
  console.log(`till ${n} -> ${join(outDir, exeName)}`)
}

console.log(`\nBuilt till ${tills.join(', till ')}. Each is a standalone exe under target/tills/till-N/.`)
