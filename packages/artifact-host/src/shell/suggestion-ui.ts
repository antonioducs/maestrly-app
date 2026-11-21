// Shared DOM builders for token color swatches, change rows, and suggestion cards across Tokens and Comments.
import {
  type DescribedSuggestionChange,
  type DescribedTokenChange,
  formatChangeName,
  formatDisplayTokenValue,
  normalizeColorHex,
  themeDisplayName,
} from './design-ui-model.js'
import { h } from './dom.js'
import { plural, type Translate } from './i18n.js'
import { icon } from './icons.js'

let canvasContext: CanvasRenderingContext2D | null | undefined

/** Resolves any opaque CSS color to `#RRGGBB` using a cached 2D canvas, or returns `null` when transparent/invalid. */
export function resolveColorHex(value: string): string | null {
  const simple = normalizeColorHex(value)
  if (simple) return simple
  if (typeof CSS === 'undefined' || !CSS.supports('color', value)) return null
  if (canvasContext === undefined) {
    canvasContext = document.createElement('canvas').getContext('2d')
  }
  if (!canvasContext) return null
  canvasContext.fillStyle = '#000000'
  canvasContext.fillStyle = value
  const out = canvasContext.fillStyle
  return /^#[0-9a-f]{6}$/i.test(out) ? out.toUpperCase() : null
}

/** Formats a token value for display, turning opaque colors into `#RRGGBB` like the prototype. */
export function displayTokenValue(value: string, kind: DescribedTokenChange['kind']): string {
  if (kind !== 'color') return value
  return resolveColorHex(value) ?? formatDisplayTokenValue(value, kind)
}

/** A 12px color chip, or a checkerboard tile when the color is transparent. */
export function swatchElement(value: string): HTMLElement {
  const hex = resolveColorHex(value)
  const el = h('span', { class: `swatch${hex ? '' : ' is-clear'}`, 'aria-hidden': 'true' })
  if (hex) el.style.setProperty('--swatch', value)
  return el
}

/** A change's token name, with a theme tag when it targets a non-default theme block. */
export function changeLabelElement(t: Translate, change: Pick<DescribedTokenChange, 'name' | 'theme'>): HTMLElement {
  return h(
    'span',
    { class: 'change-name', title: formatChangeName(t, change.name, change.theme) },
    change.name,
    change.theme && h('span', { class: 'theme-tag' }, themeDisplayName(t, change.theme))
  )
}

/** Shows `from -> to` (or only `to` inside save dialogs) with optional color swatches. */
export function changeValuesElement(change: DescribedTokenChange, withFrom = true): HTMLElement {
  return h(
    'span',
    { class: 'change-values' },
    withFrom &&
      h(
        'span',
        { class: 'change-from' },
        change.kind === 'color' && swatchElement(change.from),
        h('span', { class: 'value-text' }, displayTokenValue(change.from, change.kind))
      ),
    withFrom && icon('arrow', 12),
    h(
      'span',
      { class: 'change-to' },
      change.kind === 'color' && swatchElement(change.to),
      h('span', { class: 'value-text' }, displayTokenValue(change.to, change.kind))
    )
  )
}

export interface SuggestionBlockOptions {
  t: Translate
  changes: readonly DescribedSuggestionChange[]
  appliedVersion: number | null
  draft?: boolean
  previewing?: boolean
  canApply?: boolean
  onTogglePreview?: () => void
  onApply?: () => void
  onEditInTokens?: () => void
}

/** Renders the structured token-changes block shown inside a suggest draft card or a comment thread. */
export function suggestionBlockElement(options: SuggestionBlockOptions): HTMLElement {
  const { t, changes, appliedVersion, draft = false } = options
  const applied = appliedVersion !== null
  const hasStale = !draft && !applied && changes.some((change) => change.stale)
  return h(
    'div',
    { class: `suggestion${applied ? ' is-applied' : ''}` },
    h(
      'div',
      { class: 'suggestion-head' },
      icon(applied ? 'check' : 'tokens', 14),
      applied
        ? t('suggestionApplied', { n: appliedVersion })
        : plural(t, changes.length, 'suggestionOne', 'suggestionMany')
    ),
    h(
      'ul',
      { class: 'suggestion-list' },
      changes.map((change) =>
        h(
          'li',
          {},
          changeLabelElement(t, change),
          changeValuesElement(change),
          !draft &&
            !applied &&
            change.stale &&
            h(
              'span',
              { class: 'suggestion-stale' },
              t('suggestionStale', { value: displayTokenValue(change.now, change.kind) })
            )
        )
      )
    ),
    !draft &&
      !applied &&
      h(
        'div',
        { class: 'suggestion-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'button small',
            'aria-pressed': String(Boolean(options.previewing)),
            onclick: () => options.onTogglePreview?.(),
          },
          icon('eye', 13),
          t('suggestionPreview')
        ),
        options.canApply &&
          (hasStale
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'button small primary',
                  onclick: () => options.onEditInTokens?.(),
                },
                icon('tokens', 13),
                t('suggestionEdit')
              )
            : h(
                'button',
                {
                  type: 'button',
                  class: 'button small primary',
                  onclick: () => options.onApply?.(),
                },
                t('suggestionApply')
              ))
      )
  )
}
