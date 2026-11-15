#!/usr/bin/env node
// Builds the POS app once and copies the exe into tills/till-N for each till
// asked for. Each copy reads its till number from its own folder at start-up
// (`src/dev_till.rs`) and takes that till's identifier -- which is what Tauri's
// app_data_dir keys on -- title and spot on screen, so every till keeps its own
// shop.db. One build used to be made per till only because those were baked in
// at compile time. Built from tauri.till1.json, whose `com.shopos.pos.till`
// identifier is what lets a copy renumber itself; a shop's own build cannot.
// Run via `npm run till:build` from apps/pos -- Tauri resolves --config
// relative to the app root, not this file's folder.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcTauri = dirname(fileURLToPath(import.meta.url))
const appRoot = join(srcTauri, '..')
// A Cargo workspace member builds into the *workspace* root's target/, not
// its own -- apps/pos/src-tauri/target is a decoy left by rust-analyzer.
// Cargo is asked rather than assumed, so a PC whose .cargo/config.toml moves
// target-dir to another drive puts the build, and the tills, there.
const workspaceRoot = join(srcTauri, '..', '..', '..')
const metadata = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'],
  { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const targetDir = metadata.status === 0
  ? JSON.parse(metadata.stdout).target_directory
  : join(workspaceRoot, 'target')
const exeName = 'shopos-pos.exe'
const tills = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map(Number)
  : [1, 2, 3, 4]

console.log("\n=== Building the tills' exe once ===")
const result = spawnSync(
  'npx',
  ['tauri', 'build', '--no-bundle', '--config', join('src-tauri', 'tauri.till1.json')],
  { cwd: appRoot, stdio: 'inherit', shell: true },
)
if (result.status !== 0) {
  console.error('the build failed')
  process.exit(result.status ?? 1)
}

const busy = []
for (const n of tills) {
  const outDir = join(targetDir, 'tills', `till-${n}`)
  mkdirSync(outDir, { recursive: true })
  try {
    copyFileSync(join(targetDir, 'release', exeName), join(outDir, exeName))
  } catch (err) {
    // Windows holds a running exe open, and the stack trace for it says
    // "EBUSY" and nothing about what to do. The others are still copied.
    if (err.code === 'EBUSY' || err.code === 'EPERM') { busy.push(n); continue }
    throw err
  }
  console.log(`till ${n} -> ${join(outDir, exeName)}`)
}

if (busy.length > 0) {
  console.error(`\nTill ${busy.join(', till ')} is running, so it still has the old exe. Close it and run: node src-tauri/build-tills.mjs ${busy.join(' ')}`)
  process.exit(1)
}
console.log(`\nBuilt once, copied to till ${tills.join(', till ')} under ${join(targetDir, 'tills')}.`)
