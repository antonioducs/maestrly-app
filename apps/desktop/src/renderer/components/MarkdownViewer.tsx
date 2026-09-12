import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components, Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { FileCode, Folder, MessageSquare, MessageSquarePlus } from 'lucide-react'
import { MermaidBlock } from '@/components/MermaidBlock'
import { i18n } from '@/lib/i18n'
import { rehypeChatMentions, rehypeMarkdownSearchHighlight } from '@/lib/markdown-search-highlight'
import { cn } from '@/lib/utils'
import { parseLocalFileReference } from '../../shared/file-reference'

export interface CommentCtx {
  comments: Record<number, string>
  editingLine: number | null
  onAddOrEdit: (line: number) => void
  onSave: (line: number, text: string) => void
  onCancel: () => void
  onRemove: (line: number) => void
}

export type OpenFileReference = (path: string, startLine?: number, endLine?: number) => void

const MarkdownLinkContext = createContext(false)

function markdownUrlTransform(value: string, key: string): string {
  return key === 'href' && parseLocalFileReference(value) ? value : defaultUrlTransform(value)
}

interface Props {
  markdown: string
  onOpenFile?: OpenFileReference

  onOpenMention?: OpenFileReference

  ctx?: CommentCtx

  searchQuery?: string

  currentSearchMatch?: boolean
}

export const MarkdownViewer = memo(function MarkdownViewer({
  markdown,
  onOpenFile,
  onOpenMention,
  ctx,
  searchQuery,
  currentSearchMatch,
}: Props) {
  const components = useMemo<Components>(
    () => buildComponents(onOpenFile, ctx, onOpenMention),
    [onOpenFile, ctx, onOpenMention]
  )
  const rehypePlugins = useMemo<NonNullable<Options['rehypePlugins']>>(
    () => [
      [rehypeHighlight, { detect: true, ignoreMissing: true }],
      ...(onOpenMention ? [rehypeChatMentions] : []),
      [rehypeMarkdownSearchHighlight, { query: searchQuery, current: currentSearchMatch }],
    ],
    [onOpenMention, searchQuery, currentSearchMatch]
  )
  return (
    <div className="dark-glass-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={markdownUrlTransform}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  )
})

/* eslint-disable @typescript-eslint/no-explicit-any */

function hastText(node: any): string {
  if (!node) return ''
  if (typeof node.value === 'string') return node.value
  if (Array.isArray(node.children)) return node.children.map(hastText).join('')
  return ''
}
function buildComponents(
  onOpenFile?: OpenFileReference,
  ctx?: CommentCtx,
  onOpenMention?: OpenFileReference
): Components {
  const lineOf = (node: any): number | undefined => node?.position?.start?.line
  const onOpenReference = onOpenFile ?? onOpenMention

  const sibling =
    (Tag: any) =>
    ({ node, children }: any) => {
      const line = lineOf(node)
      if (!ctx || !line) return <Tag>{children}</Tag>
      return (
        <>
          <Tag className="group/cm relative">
            {children}
            <CommentAffordance line={line} ctx={ctx} />
          </Tag>
          <CommentBox line={line} ctx={ctx} />
        </>
      )
    }

  const child =
    (Tag: any) =>
    ({ node, children }: any) => {
      const line = lineOf(node)
      if (!ctx || !line) return <Tag>{children}</Tag>
      return (
        <Tag className="group/cm relative">
          {children}
          <CommentAffordance line={line} ctx={ctx} />
          <CommentBox line={line} ctx={ctx} />
        </Tag>
      )
    }

  return {
    button: ({ node, children, ...props }: any) => {
      const path = node?.properties?.dataMentionPath
      if (typeof path !== 'string') return <button {...props}>{children}</button>
      const startLine = Number(node.properties.dataMentionStartLine) || undefined
      const endLine = Number(node.properties.dataMentionEndLine) || undefined
      const isDir = node.properties.dataMentionDirectory === true
      const base = path.split('/').pop() || path
      const label = startLine ? `${base}:L${startLine}${endLine && endLine !== startLine ? '-' + endLine : ''}` : base
      return (
        <button
          type="button"
          onClick={() => (onOpenMention ?? onOpenFile)?.(path, startLine, endLine)}
          title={i18n.t('chat:messages.openMention', { path })}
          className="chat-mention-chip mx-0.5 inline-flex items-center gap-1 rounded-md border border-sky-400/20 bg-sky-400/[0.08] px-1.5 py-0.5 align-middle text-[13px] text-sky-300 hover:bg-sky-400/[0.16]"
        >
          {isDir ? <Folder className="h-3 w-3 shrink-0" /> : <FileCode className="h-3 w-3 shrink-0" />}
          <span className="max-w-[220px] truncate">{label}</span>
        </button>
      )
    },

    a: ({ href, children }: any) => {
      const url = typeof href === 'string' ? href : ''
      const reference = parseLocalFileReference(url)
      return (
        <MarkdownLinkContext.Provider value>
          <a
            href={url || undefined}
            onClick={(e) => {
              e.preventDefault()
              if (reference) {
                onOpenReference?.(reference.filePath, reference.startLine, reference.endLine)
              } else if (url) {
                void window.api.openExternalUrl(url)
              }
            }}
            title={reference ? i18n.t('ui:markdownViewer.openInVsCode', { path: reference.filePath }) : undefined}
            className="cursor-pointer"
          >
            {children}
          </a>
        </MarkdownLinkContext.Provider>
      )
    },
    p: sibling('p'),
    h1: sibling('h1'),
    h2: sibling('h2'),
    h3: sibling('h3'),
    h4: sibling('h4'),
    li: child('li'),
    blockquote: child('blockquote'),

    pre: ({ node, children }: any) => {
      const codeNode = node?.children?.find((c: any) => c?.tagName === 'code')
      const cls = Array.isArray(codeNode?.properties?.className)
        ? codeNode.properties.className.join(' ')
        : String(codeNode?.properties?.className ?? '')
      if (/\blanguage-mermaid\b/.test(cls)) return <MermaidBlock code={hastText(codeNode)} />
      return <pre>{children}</pre>
    },
    code: ({ className, children }: any) => (
      <InlineCode className={className} onOpenReference={onOpenReference}>
        {children}
      </InlineCode>
    ),
  }
}

function InlineCode({
  className,
  children,
  onOpenReference,
}: {
  className?: string
  children: unknown
  onOpenReference?: OpenFileReference
}) {
  const insideLink = useContext(MarkdownLinkContext)
  const text = String(children ?? '')
  const reference = !className && !insideLink ? parseLocalFileReference(text) : null
  if (reference && onOpenReference) {
    return (
      <button
        type="button"
        onClick={() => onOpenReference(reference.filePath, reference.startLine, reference.endLine)}
        title={i18n.t('ui:markdownViewer.openInVsCode', { path: reference.filePath })}
        className="cursor-pointer rounded bg-primary/10 px-1 font-mono text-[0.86em] text-primary transition-colors hover:bg-primary/20"
      >
        {text}
      </button>
    )
  }
  return <code className={className}>{children as ReactNode}</code>
}

function CommentAffordance({ line, ctx }: { line: number; ctx: CommentCtx }) {
  const { t } = useTranslation('ui')
  const has = !!ctx.comments[line]
  return (
    <span
      role="button"
      title={has ? t('markdownViewer.editComment') : t('markdownViewer.commentHere')}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        ctx.onAddOrEdit(line)
      }}
      className={cn(
        'ml-1.5 inline-flex translate-y-px cursor-pointer items-center align-middle text-primary transition-opacity',
        has ? 'opacity-80' : 'opacity-0 group-hover/cm:opacity-60 hover:!opacity-100'
      )}
    >
      {has ? <MessageSquare className="size-3" /> : <MessageSquarePlus className="size-3" />}
    </span>
  )
}

function CommentBox({ line, ctx }: { line: number; ctx: CommentCtx }) {
  const { t } = useTranslation('ui')
  const editing = ctx.editingLine === line
  const comment = ctx.comments[line]
  if (!editing && !comment) return null

  if (editing) {
    return (
      <CommentEditor
        key={line}
        initial={comment ?? ''}
        onSave={(value) => ctx.onSave(line, value)}
        onCancel={ctx.onCancel}
      />
    )
  }

  return (
    <div className="my-1.5 flex items-start gap-2 rounded-md border-l-2 border-primary/50 bg-primary/[0.07] px-2 py-1 font-sans text-xs">
      <span className="min-w-0 flex-1 text-foreground/80">{comment}</span>
      <button onClick={() => ctx.onAddOrEdit(line)} className="shrink-0 text-muted-foreground hover:text-foreground">
        {t('markdownViewer.edit')}
      </button>
      <button onClick={() => ctx.onRemove(line)} className="shrink-0 text-muted-foreground hover:text-destructive">
        {t('markdownViewer.remove')}
      </button>
    </div>
  )
}

function CommentEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('ui')
  const [draft, setDraft] = useState(initial)
  return (
    <div className="my-1.5 font-sans">
      <textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(draft)
          if (e.key === 'Escape') onCancel()
        }}
        placeholder={t('markdownViewer.editorPlaceholder')}
        className="h-16 w-full resize-none rounded-md border border-input bg-black/20 px-2 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
      />
      <div className="mt-1 flex gap-1.5">
        <button
          onClick={() => onSave(draft)}
          className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:brightness-110"
        >
          {t('common.save')}
        </button>
        <button
          onClick={onCancel}
          className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}
