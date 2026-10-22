/**
 * Theme-token guard.
 *
 * A CSS custom property that does not exist fails **silently**: the
 * declaration is dropped and the hardcoded fallback paints instead, so a typo
 * looks like a deliberate style choice. The previous balance plugin shipped
 * exactly that bug — four `--dsw-*` names were never declared by ui-theme and
 * the hover card rendered as a washed-out grey.
 *
 * This check captures the stylesheet the bundle actually installs, then proves
 * every `--dsw-*` reference is declared by the shipped theme. It reads the
 * theme declarations out of the installed app bundle (`--asar`, `$DSH_ASAR`,
 * or the default Electron install); when that file is unavailable it degrades
 * to a strict allowlist of names verified against the same theme rather than
 * passing vacuously.
 *
 * Usage: node scripts/theme-tokens.mjs [--asar <path to app.asar>]
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(resolve(HERE, '..'), 'src', 'client.js')

/** Read an `--name value` pair from argv. */
function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined
}

/** Names that once appeared in a plugin here and are NOT theme tokens. */
const KNOWN_INVALID = [
  '--dsw-alias-bg-elevated',
  '--dsw-alias-text-primary',
  '--dsw-alias-text-secondary',
  '--dsw-alias-border-subtle',
]

/** Fallback allowlist, verified against the shipped ui-theme sheets. */
const VERIFIED = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-border-l2',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-link',
  '--dsw-alias-state-error-primary',
  '--dsw-elevation-panel',
  '--dsw-elevation-prominent',
])

const ASAR = option('asar') ?? process.env.DSH_ASAR ?? 'E:\\dsh\\resources\\app.asar'

/** Capture the stylesheet the bundle installs, through the module contract. */
async function installedStylesheet() {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load: registration => registrations.push(registration) } }
  globalThis.document = {
    hidden: false,
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, textContent: '' }),
    querySelector: () => null,
  }
  await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}`)
  const module = registrations[0].factory(() => ({
    createElement: () => ({}),
    Fragment: 'fragment',
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: callback => callback,
    useRef: value => ({ current: value }),
  }))
  const tags = []
  globalThis.document.head.appendChild = tag => { tags.push(tag) }
  module.apply({
    effect: body => { body(); return () => {} },
    slots: { inject: () => () => {}, register: () => () => {} },
    logger: { warn: () => {}, error: () => {} },
  })
  if (tags.length !== 1) throw new Error(`expected one stylesheet, captured ${tags.length}`)
  return tags[0].textContent
}

/** Names the shipped theme declares, read from the installed app bundle. */
function declaredTokens() {
  if (!existsSync(ASAR)) return new Set()
  const size = statSync(ASAR).size
  if (size > 900 * 1024 * 1024) return new Set()
  const text = readFileSync(ASAR, 'utf8')
  const names = new Set()
  for (const match of text.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) names.add(match[1])
  console.log(`[tokens] theme source: ${ASAR} (${names.size} declared properties, ${(size / 1024 / 1024).toFixed(0)} MB)`)
  return names
}

const css = await installedStylesheet()
const referenced = [...new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(match => match[1]))].sort()
const declared = declaredTokens()

console.log(`[tokens] stylesheet references ${referenced.length} custom properties`)
if (referenced.length === 0) throw new Error('stylesheet references no custom properties — did the CSS move?')

const problems = []
for (const token of referenced) {
  const selfDeclared = new RegExp(`^\\s*${token}\\s*:`, 'm').test(css)
  if (selfDeclared) continue
  if (KNOWN_INVALID.includes(token)) {
    problems.push(`${token} (known-invalid theme token)`)
    continue
  }
  if (declared.size === 0) {
    if (!VERIFIED.has(token)) problems.push(`${token} (not in the verified allowlist)`)
    continue
  }
  if (!declared.has(token)) problems.push(`${token} (not declared by the shipped theme)`)
}

if (problems.length > 0) {
  console.error(`\n[tokens] ${problems.length} unresolved theme reference(s):`)
  for (const problem of problems) console.error('  -', problem)
  process.exit(1)
}

// The amount chip must read horizontally; a vertical writing mode was the old design.
if (/\.dsh-bg-label[^}]*writing-mode\s*:\s*vertical/.test(css)) {
  console.error('[tokens] the amount chip must not use a vertical writing mode')
  process.exit(1)
}

// Product rules that must survive a refactor of the stylesheet.
for (const tone of ['red', 'orange', 'green', 'blue']) {
  if (!css.includes(`[data-tone='${tone}']`)) throw new Error(`stylesheet lost the ${tone} tone`)
}
if (!css.includes('.dsh-bg-marker')) throw new Error('stylesheet lost the warning marker')
if (!css.includes('.dsh-bg-link')) throw new Error('stylesheet lost the top-up link')

console.log('[tokens] every reference resolves')
console.log('[tokens] amount chip is horizontal')
console.log('[tokens] OK')
