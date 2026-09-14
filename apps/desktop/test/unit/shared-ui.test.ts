import { createElement as h } from 'react'
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button as SharedButton, Input as SharedInput, Checkbox, ComposerSurface, MenuSelectTrigger } from '@maestrly/ui'
import { Button } from '../../src/renderer/components/ui/button'
import { Input } from '../../src/renderer/components/ui/input'
import { SelectTrigger } from '../../src/renderer/components/ui/select'
it('keeps the original desktop imports as the exact shared components', () => {
  expect(Button).toBe(SharedButton)
  expect(Input).toBe(SharedInput)
  expect(SelectTrigger).toBe(MenuSelectTrigger)
})
it('preserves native control semantics and composer slots', () => {
  expect(renderToStaticMarkup(h(Button, { type: 'submit', disabled: true, variant: 'outline' }, 'Save'))).toContain('type="submit"')
  expect(renderToStaticMarkup(h(Input, { name: 'title', defaultValue: 'Draft' }))).toContain('value="Draft"')
  expect(renderToStaticMarkup(h(Checkbox, { 'aria-label': 'Consent', defaultChecked: true }))).toContain('type="checkbox"')
  expect(renderToStaticMarkup(h(ComposerSurface, null, h('span', null, 'Editor'), h(Button, null, 'Send')))).toContain('chat-composer-shell')
})
