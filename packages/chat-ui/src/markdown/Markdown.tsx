import { memo, useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components, Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '@maestrly/ui'
import { useChatUi } from '../provider'
import { MermaidBlock } from './MermaidBlock'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function hastText(node: any): string {
  if (!node) return ''
  if (typeof node.value === 'string') return node.value
  if (Array.isArray(node.children)) return node.children.map(hastText).join('')
  return ''
}

/** `pre` renderer shared by both applications: a mermaid fence becomes a diagram, anything else stays code. */
export function markdownPre({ node, children }: any) {
  const codeNode = node?.children?.find((c: any) => c?.tagName === 'code')
  const cls = Array.isArray(codeNode?.properties?.className)
    ? codeNode.properties.className.join(' ')
    : String(codeNode?.properties?.className ?? '')
  if (/\blanguage-mermaid\b/.test(cls)) return <MermaidBlock code={hastText(codeNode)} />
  return <pre>{children}</pre>
}

export const MARKDOWN_HIGHLIGHT: NonNullable<Options['rehypePlugins']>[number] = [rehypeHighlight, { detect: true, ignoreMissing: true }]

export interface MarkdownProps {
  text: string
  className?: string
  /** Extra renderers layered over the shared ones; a host application adds mentions or comments here. */
  components?: Components
  /** Extra rehype plugins appended after highlighting. */
  rehypePlugins?: NonNullable<Options['rehypePlugins']>
  urlTransform?: Options['urlTransform']
  /** false renders images as their alt text: an application that must never fetch remote bytes passes it. */
  allowImages?: boolean
}

/**
 * Rendered Markdown as the chat shows it: GFM, highlighted code, Mermaid diagrams and links that
 * leave the application only through the injected `openExternal`, never through the webview.
 */
export const Markdown = memo(function Markdown({ text, className, components, rehypePlugins, urlTransform, allowImages = true }: MarkdownProps) {
  const { openExternal } = useChatUi()
  const merged = useMemo<Components>(
    () => ({
      ...(allowImages ? {} : { img: ({ alt }: any) => <span className="text-muted-foreground">{alt ? `[${alt}]` : ''}</span> }),
      a: ({ href, children }: any) => {
        const url = typeof href === 'string' ? href : ''
        return (
          <a
            href={url || undefined}
            className="cursor-pointer"
            onClick={(event) => {
              event.preventDefault()
              if (url) openExternal(url)
            }}
          >
            {children}
          </a>
        )
      },
      pre: markdownPre,
      ...components,
    }),
    [components, openExternal, allowImages]
  )
  const plugins = useMemo<NonNullable<Options['rehypePlugins']>>(() => [MARKDOWN_HIGHLIGHT, ...(rehypePlugins ?? [])], [rehypePlugins])
  return (
    <div className={cn('dark-glass-prose', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={plugins} components={merged} urlTransform={urlTransform ?? defaultUrlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
