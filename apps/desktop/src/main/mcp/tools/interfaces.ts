import { z } from 'zod'
import {
  GENUI_PREVIEW_TOOL,
  GENUI_WIDGET_FENCE,
  GENUI_WIDGET_MAX_CHARS,
  GENUI_WIDGET_MAX_HEIGHT,
  genUiWidgetHash,
} from '../../../shared/genui-widget'
import {
  GENUI_PREVIEW_MAX_WIDTH,
  GENUI_PREVIEW_MIN_WIDTH,
  GenUiPreviewError,
  renderGenUiPreview,
} from '../../genui-preview'
import { err, type McpToolContext } from './context'

/** `preview_interface`: renders an ```inline-html block offscreen and shows the model what the person would see. */
export function registerInterfaceTools({ server, t }: McpToolContext): void {
  server.registerTool(
    GENUI_PREVIEW_TOOL,
    {
      title: t('tools.preview_interface.title'),
      description: t('tools.preview_interface.description'),
      inputSchema: {
        html: z.string().min(1).max(GENUI_WIDGET_MAX_CHARS).describe(t('tools.preview_interface.params.html')),
        width: z
          .number()
          .int()
          .min(GENUI_PREVIEW_MIN_WIDTH)
          .max(GENUI_PREVIEW_MAX_WIDTH)
          .optional()
          .describe(t('tools.preview_interface.params.width')),
      },
    },
    async ({ html, width }, extra) => {
      try {
        const preview = await renderGenUiPreview({ html, width, signal: extra.signal })
        const id = genUiWidgetHash(html)
        const lines = [t('returns.interfaces.rendered', { id, width: preview.width, height: preview.height })]
        if (preview.capped) lines.push(t('returns.interfaces.capped', { max: GENUI_WIDGET_MAX_HEIGHT }))
        if (preview.timedOut) lines.push(t('returns.interfaces.timedOut'))
        if (preview.issues.length) {
          lines.push(t('returns.interfaces.issues'))
          for (const issue of preview.issues)
            lines.push(`- ${t(`returns.interfaces.kinds.${issue.kind}`)}${issue.detail ? `: ${issue.detail}` : ''}`)
        } else lines.push(t('returns.interfaces.noIssues'))
        lines.push(t('returns.interfaces.show', { block: `\`\`\`${GENUI_WIDGET_FENCE} preview=${id}\n\`\`\`` }))
        return {
          content: [
            ...preview.images.map((image) => ({
              type: 'image' as const,
              data: image.toString('base64'),
              mimeType: 'image/png',
            })),
            { type: 'text' as const, text: lines.join('\n') },
          ],
        }
      } catch (error) {
        if (extra.signal.aborted) throw error
        const reason = error instanceof GenUiPreviewError ? error.code : error instanceof Error ? error.message : ''
        return err(t('errors.interfacePreview', { reason: reason.slice(0, 200) }))
      }
    }
  )
}
