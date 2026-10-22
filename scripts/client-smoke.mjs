/**
 * Client smoke — prove the bundle loads through the real transport contract
 * and mounts into `shell.overlay` without a bundler or a DOM.
 *
 * The spec test covers the projection math; this one covers the wiring a
 * browser would otherwise reveal only at runtime: the registration id, the
 * `require('react')` hand-off, the stylesheet installation and the slot
 * injection.
 *
 * Usage: node scripts/client-smoke.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(resolve(HERE, '..'), 'src', 'client.js')

const registrations = []
globalThis.window = { __ModuleLoader__: { load: registration => registrations.push(registration) } }

/** Captured style tags, so we can assert the bundle installs exactly one. */
const tags = []
globalThis.document = {
  hidden: false,
  head: { appendChild: tag => { tags.push(tag); return tag } },
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  querySelector: () => null,
}

await import(`${pathToFileURL(BUNDLE).href}?t=${Date.now()}`)
if (registrations.length !== 1) throw new Error(`expected one registration, got ${registrations.length}`)
console.log('[client-smoke] bundle registered:', registrations[0].id)

const module = registrations[0].factory(name => {
  if (name !== 'react') throw new Error(`unexpected shared module: ${name}`)
  return {
    createElement: () => ({}),
    Fragment: 'fragment',
    useState: () => [null, () => {}],
    useEffect: () => {},
    useCallback: callback => callback,
    useRef: value => ({ current: value }),
  }
})
console.log('[client-smoke] module name:', module.name)

const injected = []
const registered = []
const effects = []
const ctx = {
  effect(body) {
    const dispose = body()
    effects.push(dispose)
    return () => {}
  },
  slots: {
    inject(name, factory) {
      injected.push(name)
      factory()
      return () => {}
    },
    register(registration) {
      registered.push(registration)
      return () => {}
    },
  },
  logger: { warn: () => {}, error: () => {} },
}

module.apply(ctx)

if (injected.length !== 1 || injected[0] !== 'shell.overlay') throw new Error(`unexpected inject: ${JSON.stringify(injected)}`)
if (registered.length !== 1) throw new Error(`expected one overlay registration, got ${registered.length}`)
if (registered[0].id !== 'balance-guard') throw new Error(`unexpected overlay id: ${registered[0].id}`)
if (registered[0].name !== 'shell.overlay') throw new Error(`unexpected slot: ${registered[0].name}`)
if (tags.length !== 1) throw new Error(`expected one stylesheet tag, got ${tags.length}`)
if (!String(tags[0].textContent).includes('.dsh-bg-rail')) throw new Error('stylesheet is missing the rail rule')
if (!String(tags[0].textContent).includes('.dsh-bg-panel')) throw new Error('stylesheet is missing the panel rule')
if (!Array.isArray(module.inject) || !module.inject.includes('slots')) throw new Error('module does not inject slots')
for (const dispose of effects) if (typeof dispose === 'function') dispose()

console.log('[client-smoke] overlay registration:', registered[0].name, registered[0].id, 'order', registered[0].order)
console.log('[client-smoke] stylesheet bytes:', tags[0].textContent.length)
console.log('[client-smoke] OK')
