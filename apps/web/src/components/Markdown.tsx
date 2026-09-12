import { lazy, Suspense, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { t, useLocale } from '../i18n/index.js'
const RichMarkdown = lazy(() => import('./RichMarkdown.js').then((module) => ({ default: module.RichMarkdown })))

export function Markdown({ value }: { value: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt}</span>,
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  )
}
export function MarkdownEditor({
  value,
  onChange,
  label,
  rich = false,
  resetKey=0,
}: {
  value: string
  onChange(value: string): void
  label: string
  rich?: boolean
  resetKey?: number
}) {
  useLocale()
  const [mode, setMode] = useState(rich ? 'rich' : 'write')
  const input = useRef<HTMLTextAreaElement>(null)
  function insert(before: string, after = '') {
    const start = input.current?.selectionStart ?? value.length,
      end = input.current?.selectionEnd ?? start
    onChange(value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end))
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(start + before.length, end + before.length)
    })
  }
  return (
    <div className="markdown-editor">
      <div className="editor-tabs" role="group" aria-label={label}>
        {rich ? (
          <button type="button" aria-pressed={mode === 'rich'} onClick={() => setMode('rich')}>
            {t('Rich text')}
          </button>
        ) : null}
        <button type="button" aria-pressed={mode === 'write'} onClick={() => setMode('write')}>
          {t('Write')}
        </button>
        <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
          {t('Preview')}
        </button>
      </div>
      {mode === 'preview' ? (
        <Markdown value={value || t('Nothing to preview.')} />
      ) : mode === 'rich' ? (
        <Suspense fallback={<p>{t('Loading editor…')}</p>}>
          <RichMarkdown key={resetKey} value={value} onChange={onChange} label={label} />
        </Suspense>
      ) : (
        <>
          <div className="markdown-tools">
            <button type="button" onClick={() => insert('**', '**')} aria-label={t('Bold')}>
              <b>B</b>
            </button>
            <button type="button" onClick={() => insert('*', '*')} aria-label={t('Italic')}>
              <i>I</i>
            </button>
            <button type="button" onClick={() => insert('\n## ')}>
              {t('Heading')}
            </button>
            <button type="button" onClick={() => insert('\n- ')}>
              {t('List')}
            </button>
            <button type="button" onClick={() => insert('\n- [ ] ')}>
              {t('Checklist')}
            </button>
            <button type="button" onClick={() => insert('[', '](https://)')}>
              {t('Link')}
            </button>
            <button type="button" onClick={() => insert('\n```\n', '\n```\n')}>
              {t('Code')}
            </button>
          </div>
          <textarea
            ref={input}
            aria-label={label}
            value={value}
            rows={rich ? 10 : 4}
            maxLength={100000}
            onChange={(e) => onChange(e.target.value)}
          />
        </>
      )}
    </div>
  )
}
