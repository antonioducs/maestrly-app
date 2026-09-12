import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modelChipSource = readFileSync(
  new URL('../../src/renderer/components/chat/ChatModelChip.tsx', import.meta.url),
  'utf8'
)
const editorSource = readFileSync(
  new URL('../../src/renderer/components/chat/MentionEditor.tsx', import.meta.url),
  'utf8'
)
const composerSource = readFileSync(
  new URL('../../src/renderer/components/chat/ChatComposer.tsx', import.meta.url),
  'utf8'
)
const chatViewSource = readFileSync(new URL('../../src/renderer/components/chat/ChatView.tsx', import.meta.url), 'utf8')

describe('model shortcuts and composer focus contract', () => {
  it('exposes imperative handles to open the picker and focus the prompt', () => {
    expect(modelChipSource).toContain('export interface ChatModelChipHandle')
    expect(modelChipSource).toContain('open: () => {')
    expect(modelChipSource).toContain('setOpen(true)')
    expect(modelChipSource).toContain('focusSearch()')
    expect(editorSource).toContain('focus(): void')
    expect(editorSource).toContain('el.focus({ preventScroll: true })')
    expect(editorSource).toContain('function focusEditorAtEnd')
    expect(composerSource).toContain('export interface ChatComposerHandle')
    expect(composerSource).toContain('focus: () => editorRef.current?.focus()')
  })

  it('restores focus when configuration allows the search to mount late', () => {
    expect(modelChipSource).toContain('if (!open || !config) return')
    expect(modelChipSource).toContain('focusSearch()\n  }, [config, focusSearch, open])')
  })

  it('resets and navigates the highlighted result independently of the persisted selection', () => {
    expect(modelChipSource).toContain('const [activeIndex, setActiveIndex] = useState(0)')
    expect(modelChipSource).toContain('useEffect(() => setActiveIndex(0), [query])')
    expect(modelChipSource).toContain("e.key === 'ArrowDown'")
    expect(modelChipSource).toContain("e.key === 'ArrowUp'")
    expect(modelChipSource).toContain(
      'const item = filtered[filtered.length > 0 ? Math.min(activeIndex, filtered.length - 1) : -1]'
    )
    expect(modelChipSource).toContain('filtered.length > 0')
    expect(modelChipSource).toContain('onMouseEnter={() => setActiveIndex(index)}')
    expect(modelChipSource).toContain('const active = sel?.providerId === r.providerId && sel?.modelId === r.modelId')
    expect(modelChipSource).toContain('const highlighted = index === activeIndex')
    expect(modelChipSource).toContain('aria-selected={highlighted}')
  })

  it('keeps the highlighted result visible during navigation', () => {
    expect(modelChipSource).toContain('const optionRefs = useRef<Array<HTMLButtonElement | null>>([])')
    expect(modelChipSource).toContain(
      "if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })"
    )
    expect(modelChipSource).toContain('optionRefs.current[index] = node')
  })

  it('escapes overflow and reapplies the hidden-model filter to the cache', () => {
    expect(modelChipSource).toContain('avoidOverflow = false')
    expect(modelChipSource).toContain("position: 'fixed'")
    expect(modelChipSource).toContain("window.addEventListener('scroll', reposition, true)")
    expect(modelChipSource).toContain('chatHiddenModels()')
    expect(modelChipSource).toContain('!(hiddenModels[r.providerId] ?? []).includes(r.modelId)')
  })

  it('connects refs in ChatView and restores focus after an accepted selection', () => {
    expect(chatViewSource).toContain('const composerRef = useRef<ChatComposerHandle>(null)')
    expect(chatViewSource).toContain('const modelChipRef = useRef<ChatModelChipHandle>(null)')
    expect(chatViewSource).toContain('ref={composerRef}')
    expect(chatViewSource).toContain('ref={modelChipRef}')
    expect(chatViewSource).toContain('requestAnimationFrame(() => composerRef.current?.focus())')
    expect(chatViewSource).toContain('!e.repeat')
    expect(chatViewSource).toContain('modelChipRef.current.open()')
  })
})
