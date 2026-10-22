/**
 * Publish this plugin to its GitHub repository through the REST Contents API.
 *
 * Why not `git push`: every file lands as a content-addressed API call, so the
 * publish needs no credential helper, no remote URL containing the token, and
 * leaves nothing behind in any repository config. It is idempotent — an
 * existing path is updated against its current blob SHA, and an unchanged file
 * is skipped entirely.
 *
 * The repository is created on first run when it does not exist yet.
 *
 * Usage: node scripts/publish.mjs [--repo <owner>/<name>] [--private] [--dry-run]
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')
const WORKSPACE = resolve(PACKAGE_DIR, '..')
const API = 'https://api.github.com'

/** Read a `--name value` pair from argv. */
function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback
}

/** Repository to publish into. */
const REPO = option('repo', 'marksimZ/dsh-balance-guard')
const DRY_RUN = process.argv.includes('--dry-run')
const PRIVATE = process.argv.includes('--private')

/** One-line pitch GitHub shows beside the repository name. */
const DESCRIPTION = 'DSH plugin: your DeepSeek account balance as a colour-banded bar on the right edge, with per-turn cost prediction and a quiet low-balance warning.'

/** Discovery topics. */
const TOPICS = [
  'deepseek-harness',
  'dsh',
  'dsh-plugin',
  'cordis',
  'cordis-plugin',
  'balance',
  'cost-prediction',
  'web-ui',
  'typescript',
  'plugin',
]

/**
 * Files to publish, in commit order: the README lands last so it never
 * documents code that is not there yet.
 */
const FILES = [
  { from: '.gitignore', to: '.gitignore', message: 'Add repository ignore rules' },
  { from: 'LICENSE', to: 'LICENSE', message: 'Add MIT license' },
  { from: 'package.json', to: 'package.json', message: 'Add plugin manifest with the dsh.client declaration' },
  { from: 'cordis.patch.yml', to: 'cordis.patch.yml', message: 'Add the loader overlay row' },
  { from: 'src/policy.js', to: 'src/policy.js', message: 'Add the pure policy: bands, prices, estimator, verdict' },
  { from: 'src/index.ts', to: 'src/index.ts', message: 'Add host half: account balance, per-turn folding, snapshot route' },
  { from: 'src/client.js', to: 'src/client.js', message: 'Add browser half: rail, chip, warning badge and preview/pinned panel' },
  { from: 'scripts/policy-spec.mjs', to: 'scripts/policy-spec.mjs', message: 'Add the policy spec: bands, calendar, estimator arithmetic' },
  { from: 'scripts/client-spec.mjs', to: 'scripts/client-spec.mjs', message: 'Add the snapshot-to-panel spec' },
  { from: 'scripts/client-smoke.mjs', to: 'scripts/client-smoke.mjs', message: 'Add the bundle-load smoke test' },
  { from: 'scripts/host-smoke.mjs', to: 'scripts/host-smoke.mjs', message: 'Add the host smoke test over the real state route' },
  { from: 'scripts/theme-tokens.mjs', to: 'scripts/theme-tokens.mjs', message: 'Guard theme-token references against silent fallback' },
  { from: 'scripts/visual-tokens.mjs', to: 'scripts/visual-tokens.mjs', message: 'Guard the visual layer: tokens only, no raw colours, no infinite animation' },
  { from: 'scripts/install.mjs', to: 'scripts/install.mjs', message: 'Add the profile installer' },
  { from: 'scripts/verify-deployed.mjs', to: 'scripts/verify-deployed.mjs', message: 'Add the deployed-GUI verification probe' },
  { from: 'scripts/publish.mjs', to: 'scripts/publish.mjs', message: 'Add the publisher' },
  { from: 'DESIGN.md', to: 'DESIGN.md', message: 'Document the data model, price catalog and estimator' },
  { from: 'REDESIGN.md', to: 'REDESIGN.md', message: 'Document the v0.4 visual redesign and its guards' },
  { from: 'README.md', to: 'README.md', message: 'Document the plugin: install, bands, prediction, configuration, tests' },
]

/** Every place a token file may live, in priority order. */
const TOKEN_CANDIDATES = [
  process.env.GITHUB_TOKEN_FILE,
  join(PACKAGE_DIR, 'githubtoken.txt'),
  join(WORKSPACE, 'githubtoken.txt'),
  join(process.env.USERPROFILE ?? homedir(), 'githubtoken.txt'),
].filter(candidate => typeof candidate === 'string' && candidate.length > 0)

/** The token, from the environment or the first readable token file. Never logged. */
function token() {
  const fromEnv = process.env.GITHUB_TOKEN
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim()
  for (const candidate of TOKEN_CANDIDATES) {
    try {
      const value = readFileSync(candidate, 'utf8').trim()
      if (value.length > 0) return value
    } catch {
      // Not there; try the next location.
    }
  }
  throw new Error(`no GitHub token: set GITHUB_TOKEN, or place one at ${TOKEN_CANDIDATES.join(' | ')}`)
}

/** One GitHub REST call; the token travels only in the Authorization header. */
async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-balance-guard-publisher',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })
  const text = await response.text()
  let payload
  try { payload = text.length === 0 ? undefined : JSON.parse(text) } catch { payload = text }
  return { status: response.status, ok: response.ok, payload }
}

/** Error text with anything token-shaped removed. */
function clean(payload) {
  const value = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return value.replaceAll(/gh[pousr]_[A-Za-z0-9]+/g, '<redacted>').slice(0, 700)
}

const [owner, repoName] = REPO.split('/')
if (owner === undefined || repoName === undefined) throw new Error(`--repo must be <owner>/<name>, got ${REPO}`)

console.log(`[publish] repository: ${REPO}${DRY_RUN ? ' (dry run)' : ''}`)

if (!DRY_RUN) {
  let meta = await api(`/repos/${REPO}`)
  if (meta.status === 404) {
    const me = await api('/user')
    if (!me.ok) throw new Error(`cannot identify the token owner: HTTP ${me.status} ${clean(me.payload)}`)
    const path = me.payload.login === owner ? '/user/repos' : `/orgs/${owner}/repos`
    const created = await api(path, {
      method: 'POST',
      body: JSON.stringify({ name: repoName, description: DESCRIPTION, private: PRIVATE, has_issues: true, has_wiki: false, has_projects: false, auto_init: false }),
    })
    if (!created.ok) throw new Error(`cannot create ${REPO}: HTTP ${created.status} ${clean(created.payload)}`)
    console.log(`[publish] created ${created.payload.full_name} (private=${created.payload.private})`)
    meta = { ok: true, payload: created.payload }
  } else if (!meta.ok) {
    throw new Error(`cannot read ${REPO}: HTTP ${meta.status} ${clean(meta.payload)}`)
  } else {
    console.log(`[publish] found repository (private=${meta.payload.private})`)
  }
  const branch = meta.payload.default_branch ?? 'main'

  if (meta.payload.description !== DESCRIPTION) {
    const patched = await api(`/repos/${REPO}`, { method: 'PATCH', body: JSON.stringify({ description: DESCRIPTION }) })
    if (!patched.ok) throw new Error(`description update failed: HTTP ${patched.status} ${clean(patched.payload)}`)
    console.log('[publish] description set')
  }
  const topics = await api(`/repos/${REPO}/topics`, { method: 'PUT', body: JSON.stringify({ names: TOPICS }) })
  if (!topics.ok) throw new Error(`topics update failed: HTTP ${topics.status} ${clean(topics.payload)}`)
  console.log(`[publish] topics: ${(topics.payload.names ?? []).join(', ')}`)

  let uploaded = 0
  let skipped = 0
  for (const file of FILES) {
    const local = join(PACKAGE_DIR, file.from)
    statSync(local)
    const bytes = readFileSync(local)
    const current = await api(`/repos/${REPO}/contents/${file.to}?ref=${branch}`)
    if (!current.ok && current.status !== 404) {
      throw new Error(`cannot read ${file.to}: HTTP ${current.status} ${clean(current.payload)}`)
    }
    if (current.ok && String(current.payload.content ?? '').replaceAll('\n', '') === bytes.toString('base64')) {
      skipped += 1
      console.log(`[publish] = ${file.to} (already current)`)
      continue
    }
    console.log(`[publish] ${current.ok ? 'update' : 'create'} ${file.to} (${bytes.length} bytes)`)
    const put = await api(`/repos/${REPO}/contents/${file.to}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: file.message,
        content: bytes.toString('base64'),
        ...(current.ok ? { sha: current.payload.sha } : {}),
        branch,
      }),
    })
    if (!put.ok) throw new Error(`upload of ${file.to} failed: HTTP ${put.status} ${clean(put.payload)}`)
    uploaded += 1
  }
  console.log(`\n[publish] ${uploaded} uploaded, ${skipped} already current`)
} else {
  for (const file of FILES) {
    const local = join(PACKAGE_DIR, file.from)
    statSync(local)
    console.log(`[publish] would upload ${file.to}`)
  }
}

console.log(`[publish] https://github.com/${REPO}`)
