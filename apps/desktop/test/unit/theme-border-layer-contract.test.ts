import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync('src/renderer/styles.css', 'utf8')

/** Style rules of a stylesheet with the at-rule blocks enclosing each one. Enough for this file; not a CSS parser. */
function styleRules(css: string): { selector: string; body: string; within: string[] }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"|'[^']*'/g, '""')
  const rules: { selector: string; body: string; within: string[] }[] = []
  const stack: string[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '{') {
      stack.push(text.slice(start, index).trim())
      start = index + 1
    } else if (char === '}') {
      const head = stack.pop() ?? ''
      if (!head.startsWith('@')) rules.push({ selector: head, body: text.slice(start, index), within: [...stack] })
      start = index + 1
    } else if (char === ';' && (stack.at(-1) ?? '@').startsWith('@')) {
      // At top level or directly in an at-rule block, a statement (`@import …;`, a `@theme` token) ends here.
      start = index + 1
    }
  }
  return rules
}

describe('theme border color', () => {
  it('sets the default border color in the base layer, so border color utilities still apply', () => {
    // Tailwind v4 emits utilities in `@layer utilities`; an unlayered rule outranks every layered one whatever its
    // specificity, so an unlayered `* { border-color }` silently turned every `border-<color>` class into the default.
    const defaults = styleRules(styles).filter(
      (rule) => rule.selector.split(',').some((part) => part.trim() === '*') && /\bborder-color\s*:/.test(rule.body)
    )
    expect(defaults.length).toBeGreaterThan(0)
    for (const rule of defaults) expect(rule.within).toEqual(['@layer base'])
  })
})
