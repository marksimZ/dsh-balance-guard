/**
 * Deployment probe: verify that the running DSH GUI actually serves this
 * plugin's browser half and its state route.
 *
 * It reproduces the browser-session cookie from the Harness credential file
 * (the same signed cookie the page receives at `/`), fetches the index, asserts
 * the `dsh-balance-guard` boot entry exists, downloads the bundle the browser
 * will use, and then reads `/dsh-balance-guard/state` through the same
 * cookie. That is the difference between "the files are correct" and "the GUI
 * is running them".
 *
 * Read-only: it never changes the deployment.
 *
 * Usage: node scripts/verify-deployed.mjs [--url http://127.0.0.1:52259] [--home <DSH_HOME>]
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Read an `--name value` pair from argv. */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

const base = option('url') ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const home = option('home') ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.dsh')
const authority = new URL(base).host

/** base64url without padding, matching the Host's encoder. */
const b64 = value => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** The signing secret of the `client-connection/browser-session` grant record. */
function sessionSecret() {
  const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  const match = /client-connection\/browser-session:[\s\S]{0,400}?secret:\s*(\S+)/.exec(text)
  if (match === null) throw new Error(`no browser-session secret in ${home}/.credentials.yaml`)
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

/** Mint the same `v1.<body>.<sig>` cookie the Host issues at `/`. */
function sessionCookie() {
  const secret = sessionSecret()
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3_600_000 }
  const body = b64(Buffer.from(JSON.stringify(payload), 'utf8'))
  const name = 'dsh-auth-' + b64(createHash('sha256').update(authority).digest())
  return `${name}=v1.${body}.${b64(createHmac('sha256', secret).update(body).digest())}`
}

const cookie = sessionCookie()
const indexResponse = await fetch(base + '/', { headers: { cookie, accept: 'text/html' } })
if (!indexResponse.ok) throw new Error(`index fetch failed: HTTP ${indexResponse.status}`)
const html = await indexResponse.text()
console.log(`[verify] index: HTTP ${indexResponse.status}, ${html.length} bytes`)

const graphMatch = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})<\/script>/.exec(html)
if (graphMatch === null) throw new Error('no __DSH_BOOT__ graph in the served index')
const graph = JSON.parse(graphMatch[1])
console.log(`[verify] boot graph rev ${graph.rev}, ${graph.entries.length} entries`)

const entry = graph.entries.find(candidate => candidate.id === 'dsh-balance-guard')
if (entry === undefined) {
  console.error('[verify] dsh-balance-guard is NOT in the boot graph. Entries:')
  for (const candidate of graph.entries) console.error('  -', candidate.id)
  process.exit(1)
}
console.log('[verify] boot entry:', JSON.stringify(entry))

const bundleResponse = await fetch(new URL(entry.url, base), { headers: { cookie } })
const bundle = await bundleResponse.text()
if (!bundleResponse.ok) throw new Error(`bundle fetch failed: HTTP ${bundleResponse.status}`)
console.log(`[verify] bundle: HTTP ${bundleResponse.status}, ${bundle.length} bytes, ${bundleResponse.headers.get('content-type')}`)
for (const marker of ['__ModuleLoader__.load', "id: 'dsh-balance-guard'", 'shell.overlay', '.dsh-bg-rail', '.dsh-bg-panel', '--dsw-static-deepseek-500', 'data-tone']) {
  if (!bundle.includes(marker)) throw new Error(`served bundle is missing ${marker}`)
}
if (bundle.includes('dshbg-scroll')) throw new Error('served bundle still contains the removed wave animation')

// The state route is the actual data path; a 200 with a snapshot shape proves
// the Host half mounted, not just that the file was served.
const stateResponse = await fetch(base + '/dsh-balance-guard/state', { headers: { cookie, accept: 'application/json' } })
if (!stateResponse.ok) throw new Error(`state route failed: HTTP ${stateResponse.status}`)
const snapshot = await stateResponse.json()
if (typeof snapshot !== 'object' || snapshot === null) throw new Error('state route did not return a JSON object')
if (!['loading', 'signed-in', 'signed-out', 'unavailable'].includes(snapshot.account?.state)) {
  throw new Error(`unexpected account state: ${JSON.stringify(snapshot.account?.state)}`)
}
const hasAmount = typeof snapshot.account?.total === 'number'
const source = snapshot.account?.source === undefined ? '' : `, source=${snapshot.account.source}`
console.log('[verify] state route: account =', snapshot.account.state + source + (hasAmount ? ', amount present' : ', no amount'))
if (snapshot.task !== null && snapshot.task !== undefined) {
  console.log('[verify] state route: task =', snapshot.task.kind, snapshot.task.insufficient ? '(insufficient)' : '(ok)')
}

console.log('[verify] OK — the GUI is serving this plugin')
