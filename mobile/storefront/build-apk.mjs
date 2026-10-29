/*
 * Builds the StoreFront by TRT Android app, start to finish:
 *
 *   1. the storefront, pointed at the shop's API (SHOP_API, default below);
 *   2. `cap sync`, which copies it into android/;
 *   3. Gradle, with the JDK that ships inside Android Studio.
 *
 *   node build-apk.mjs            a release APK, signed with android/keystore.properties
 *   node build-apk.mjs debug      a debug APK, signed with the debug key
 *
 * The APK lands in mobile/storefront/StoreFront[-debug].apk.
 */
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const debug = process.argv[2] === 'debug'
const api = process.env.SHOP_API ?? 'https://api-shop.thiruvengadam.me'

const javaHome = process.env.JAVA_HOME ?? 'C:\\Program Files\\Android\\Android Studio\\jbr'
const androidHome = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk')
const env = { ...process.env, SHOP_API: api, JAVA_HOME: javaHome, ANDROID_HOME: androidHome }
const run = (cmd, cwd) => execSync(cmd, { cwd, env, stdio: 'inherit' })

run('npx vite build apps/storefront', root)
run('npx cap sync android', here)

if (!debug && !existsSync(join(here, 'android', 'keystore.properties'))) {
  throw new Error('android/keystore.properties is missing; see mobile/storefront/README.md, or build with "debug"')
}
const task = debug ? 'assembleDebug' : 'assembleRelease'
run(`${process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew'} ${task} --console=plain`, join(here, 'android'))

const kind = debug ? 'debug' : 'release'
const out = join(here, 'android', 'app', 'build', 'outputs', 'apk', kind, `app-${kind}.apk`)
const dest = join(here, debug ? 'StoreFront-debug.apk' : 'StoreFront.apk')
copyFileSync(out, dest)
console.log(`\n${dest}`)
