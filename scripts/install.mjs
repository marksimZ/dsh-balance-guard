/**
 * Install the balance guard into a DSH profile's own patch layer.
 *
 * The profile's `cordis.patch.yml` is the user patch layer the running
 * launcher watches (`patchReload: live`), so appending the row here is what
 * makes the plugin load on the next index render — no restart, only a page
 * reload. The Desktop client runs the `desktop` profile; a plain `dsh web`
 * run uses `web`, which is why the profile is detected before it is written.
 *
 * Idempotent: an existing `balance-guard` row is reported and left alone.
 * Re-runnable with a different checkout path via `--host <file-url>`.
 *
 * Usage: node scripts/install.mjs [--home <DSH_HOME>] [--profile desktop|web] [--host <file-url>] [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')

/** Read an `--name value` pair from argv. */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

const flag = name => process.argv.includes(`--${name}`)

/** Absolute path as the loader's own resolver wants it. */
function pathToFileURLOf(absolute) {
  const posix = absolute.replaceAll('\\', '/')
  return `file:///${posix.replace(/^\/+/, '')}`
}

const home = option('home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
const profilesDir = join(home, 'profiles')

/** The Desktop client runs `desktop`; a standalone `dsh web` run uses `web`. */
function defaultProfile() {
  if (existsSync(join(profilesDir, 'desktop'))) return 'desktop'
  if (existsSync(join(profilesDir, 'web'))) return 'web'
  return 'web'
}

const profile = option('profile') ?? defaultProfile()
const patchPath = join(profilesDir, profile, 'cordis.patch.yml')
const hostEntry = option('host') ?? pathToFileURLOf(join(PACKAGE_DIR, 'src', 'index.ts'))

if (!existsSync(join(profilesDir, profile))) {
  console.error(`[install] no profile at ${join(profilesDir, profile)}`)
  console.error('[install] pass --home <DSH_HOME> or start the client once to create the profile')
  process.exit(1)
}

const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '# Your patch layer for this dsh profile.\n[]\n'

if (/^\s*-?\s*id:\s*balance-guard\s*$/m.test(existing) || existing.includes('dsh-balance-guard/src/index.ts')) {
  console.log(`[install] balance-guard is already present in ${patchPath}`)
  process.exit(0)
}

/**
 * Replace the empty document (`[]`) with one insert block, or append a new
 * insert block after existing rows. Keeping the file's own comments intact is
 * the point of not re-serializing it.
 */
function merged(text) {
  const block = [
    '',
    '# dsh-balance-guard: DSH account balance bar with per-task cost prediction.',
    '- insert:',
    '    - id: balance-guard',
    `      name: '${hostEntry}'`,
    '      config:',
    '        safetyRatio: 0.2',
    '        minReserveCny: 2',
    '        balanceTtlMs: 25000',
    '        balancePollMs: 30000',
    '        balanceTimeoutMs: 30000',
    '        runningPollHintMs: 1000',
    '        idlePollMs: 15000',
    '        cnyPerUsd: 7.2',
    '        assumedSteps: 8',
    '        assumedOutputTokens: 1200',
    '        assumedGrowthTokens: 4000',
    '        assumedCacheHit: 0.85',
    '        holidays: []',
    '        balanceLagCompensation: true',
    '        clientVersion: ""',
    '        credentialRef: DEEPSEEK_API_KEY',
    '        endpoint: https://api.deepseek.com/user/balance',
    '        timeoutMs: 10000',
    '        fallbackToApiKey: true',
    '',
  ].join('\n')
  const stripped = text.replace(/^\s*\[\s*\]\s*$/m, '')
  return `${stripped.replace(/\s*$/, '')}\n${block}`
}

const next = merged(existing)

if (flag('dry-run')) {
  console.log(`[install] would write ${patchPath}:\n`)
  console.log(next)
  process.exit(0)
}

writeFileSync(patchPath, next)
console.log(`[install] wrote ${patchPath}`)
console.log(`[install] profile: ${profile}`)
console.log(`[install] host half: ${hostEntry}`)
console.log('[install] the profile reloads this file live — reload the page to see the bar.')
