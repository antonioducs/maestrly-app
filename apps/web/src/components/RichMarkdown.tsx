import { useEffect, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import { t, errorText } from '../i18n/index.js'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'

export function RichMarkdown({
  value,
  onChange,
  label,
}: {
  value: string
  onChange(value: string): void
  label: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const change = useRef(onChange)
  change.current = onChange
  const initial = useRef(value)
  initial.current = value
  const [error, setError] = useState('')
  useEffect(() => {
    const container = document.createElement('div')
    root.current!.append(container)
    let alive = true,
      ready = false,
      touched = false
    for (const type of ['keydown', 'paste', 'drop', 'pointerdown', 'input'])
      container.addEventListener(type, () => {
        touched = true
      })
    const editor = new Crepe({
      root: container,
      defaultValue: initial.current,
      features: {
        [Crepe.Feature.ImageBlock]: false,
        [Crepe.Feature.Latex]: false,
        [Crepe.Feature.BlockEdit]: false,
        [Crepe.Feature.LinkTooltip]: false,
        [Crepe.Feature.Table]: false,
      },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: { text: t('Write a description…') },
        [Crepe.Feature.CodeMirror]: {
          searchPlaceholder: t('Search language'),
          copyText: t('Copy'),
          noResultText: t('No result'),
          previewToggleText: (preview) => t(preview ? 'Edit' : 'Hide'),
        },
      },
    })
    editor.on((listener) =>
      listener.markdownUpdated((_ctx, markdown) => {
        if (ready && alive && touched) change.current(markdown)
      })
    )
    const created = editor
      .create()
      .then(() => {
        if (alive) {
          ready = true
          const input = container.querySelector('[contenteditable]')
          input?.setAttribute('role', 'textbox')
          input?.setAttribute('aria-label', label)
          input?.setAttribute('aria-multiline', 'true')
        }
      })
      .catch((error) => {
        if (alive) setError(error instanceof Error ? error.message : 'Editor could not load.')
      })
    return () => {
      alive = false
      void created.then(() => editor.destroy()).finally(() => container.remove())
    }
  }, [label])
  return (
    <div
      className="rich-markdown"
      ref={root}
      onClickCapture={(e) => {
        if ((e.target as Element).closest('a')) e.preventDefault()
      }}
    >
      {error ? <p role="alert">{errorText(error)}</p> : null}
    </div>
  )
}
