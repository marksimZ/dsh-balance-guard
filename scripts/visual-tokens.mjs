/**
 * Visual-token guard — keeps the redesign honest.
 *
 * v0.4 maps the whole visual layer onto the shipped `--dsw-*` design system.
 * This check enforces the parts a reviewer would otherwise police by eye:
 *
 *   1. no raw colours (`#hex`, `rgb()`, `hsl()`) anywhere in the stylesheet;
 *   2. radii only from `--dsw-radius-*` (plus pill `999px` and `50%`);
 *   3. font sizes only from the shipped type scale (11/12/13/16);
 *   4. no infinite animation (the wave is gone);
 *   5. the overlay stays at `z-index: 20`, below shell toasts and modals.
 *
 * Usage: node scripts/visual-tokens.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(resolve(HERE, '..'), 'src', 'client.js')
const source = readFileSync(CLIENT, 'utf8')

const stylesMatch = /const STYLES = `([\s\S]*?)`\n/.exec(source)
if (stylesMatch === null) throw new Error('could not locate the STYLES template in src/client.js')
const css = stylesMatch[1]
console.log(`[visual] stylesheet: ${css.length} bytes`)

let checks = 0
const failures = []

function assert(label, condition, detail) {
  checks += 1
  if (!condition) failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
}

// 1. Colours must be tokens (or color-mix over tokens).
const rawHex = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(match => match[0])
assert('no raw hex colours', rawHex.length === 0, rawHex.slice(0, 5).join(', '))
const rawRgb = [...css.matchAll(/\brgba?\s*\(/g)].map(match => match[0])
assert('no raw rgb() colours', rawRgb.length === 0, rawRgb.slice(0, 5).join(', '))
const rawHsl = [...css.matchAll(/\bhsla?\s*\(/g)].map(match => match[0])
assert('no raw hsl() colours', rawHsl.length === 0, rawHsl.slice(0, 5).join(', '))

// Every background paint either references a token or is a gradient of tokens.
const colorDeclarations = [...css.matchAll(/(?:background|background-color|color|box-shadow)\s*:\s*([^;}]+)/g)]
  .map(match => match[1].trim())
  .filter(value => !/^(none|transparent|inherit)$/.test(value))
for (const value of colorDeclarations) {
  assert('colour declaration uses tokens', value.includes('var(--dsw-') || value.includes('color-mix('), value)
}

// 2. Radii come from the theme scale.
const radii = [...css.matchAll(/border-radius\s*:\s*([^;}]+)/g)].map(match => match[1].trim())
for (const value of radii) {
  assert('radius uses the theme scale', /^(999px|50%|var\(--dsw-radius-[a-z]+\))$/.test(value), value)
}

// 3. Font sizes come from the shipped type scale (11 / 12 / 13 / 16).
const fontSizes = [...css.matchAll(/font-size\s*:\s*([^;}]+)/g)].map(match => match[1].trim())
for (const value of fontSizes) {
  assert('font size is part of the type scale', /^(11px|12px|13px|16px|var\(--dsw-font-[a-z0-9-]+\))$/.test(value), value)
}

// 4. The wave animation is gone; motion is transition-only.
assert('no @keyframes', !/@keyframes/.test(css))
assert('no infinite animation', !/animation\s*:\s*[^;]*infinite/.test(css))
assert('no glow layer', !/dsh-bg-glow/.test(css))
assert('reduced motion is honoured', css.includes('prefers-reduced-motion'))

// 5. Layering stays below shell toasts and modals.
const zIndexes = [...css.matchAll(/z-index\s*:\s*([0-9]+)/g)].map(match => match[1])
for (const value of zIndexes) assert('z-index stays at 20', value === '20', value)

// 6. The four product bands must reference the theme's static palette.
for (const band of ['red', 'amber', 'green', 'deepseek']) {
  assert(`band palette ${band} is used`, css.includes(`--dsw-static-${band}-`))
}

// 7. The chip stays horizontal (the old vertical value chip was a regression).
assert('value chip is horizontal', !/writing-mode\s*:\s*vertical/.test(css))

if (failures.length > 0) {
  console.error(`\n[visual] ${failures.length} of ${checks} checks failed:`)
  for (const failure of failures) console.error('  -', failure)
  process.exit(1)
}
console.log(`[visual] ${checks} checks passed`)
console.log('[visual] OK')
