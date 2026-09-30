import { ArtifactHostError, type BundleFile, MAX_INLINE_BYTES } from '@maestrly/artifact-host'
import { z } from 'zod'
import { getArtifactsService } from '../../artifacts'
import type { ArtifactChange, ArtifactsService } from '../../artifacts/service'
import { RepositoryScopeError } from '../../repository-scope'
import { err, type McpToolContext, ok } from './context'

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const encoder = new TextEncoder()

type InlineFile = { path: string; content: string; encoding?: 'utf8' | 'base64' }

/**
 * Artifacts: versioned web pages the agent publishes for the user. Agents create, update, read and open them within
 * their scope; sharing and deletion stay with the owner in the app.
 */
export function registerArtifactTools(
  ctx: McpToolContext,
  resolveService: () => ArtifactsService = getArtifactsService
): void {
  const { server, convId, t, workerScope } = ctx

  const inlineFile = z.object({
    path: z.string().describe(t('tools.artifact_create.params.filePath')),
    content: z.string().describe(t('tools.artifact_create.params.fileContent')),
    encoding: z.enum(['utf8', 'base64']).optional().describe(t('tools.artifact_create.params.fileEncoding')),
  })

  function decode(files: readonly InlineFile[]): { files: BundleFile[] } | { error: string } {
    const decoded: BundleFile[] = []
    let total = 0
    for (const file of files) {
      let bytes: Uint8Array
      if (file.encoding === 'base64') {
        if (file.content.length % 4 !== 0 || !BASE64.test(file.content))
          return { error: t('errors.artifacts.invalidEncoding', { path: file.path }) }
        bytes = new Uint8Array(Buffer.from(file.content, 'base64'))
      } else {
        bytes = encoder.encode(file.content)
      }
      total += bytes.byteLength
      if (total > MAX_INLINE_BYTES) return { error: t('errors.artifacts.inlineTooLarge') }
      decoded.push({ path: file.path, bytes })
    }
    return { files: decoded }
  }

  function failure(error: unknown) {
    if (error instanceof RepositoryScopeError)
      return err(t('errors.artifacts.directoryRefused', { message: error.message }))
    if (!(error instanceof ArtifactHostError)) {
      console.error('[artifacts] tool failed:', error instanceof Error ? error.message : String(error))
      return err(t('errors.artifacts.internal'))
    }
    if (error.code === 'host_unavailable') {
      const reason = error.details?.reason
      if (reason === 'disabled') return err(t('errors.artifacts.hostDisabled'))
      if (reason === 'port_in_use')
        return err(t('errors.artifacts.portInUse', { port: resolveService().getSettings().port }))
      return err(t('errors.artifacts.hostUnavailable'))
    }
    return err(t(`errors.artifacts.${error.code}`, { ...error.details, message: error.message }))
  }

  const published = (result: { detail: { id: string; title: string; currentVersion: number }; skipped: string[] }) =>
    ok(
      JSON.stringify({
        ok: true,
        artifact: { id: result.detail.id, title: result.detail.title, version: result.detail.currentVersion },
        skipped: result.skipped,
        note: t('returns.artifacts.note'),
      })
    )

  server.registerTool(
    'artifact_create',
    {
      title: t('tools.artifact_create.title'),
      description: t('tools.artifact_create.description'),
      inputSchema: {
        title: z.string().describe(t('tools.artifact_create.params.title')),
        description: z.string().optional().describe(t('tools.artifact_create.params.description')),
        files: z.array(inlineFile).optional().describe(t('tools.artifact_create.params.files')),
        directory: z.string().optional().describe(t('tools.artifact_create.params.directory')),
        entry: z.string().optional().describe(t('tools.artifact_create.params.entry')),
      },
    },
    async ({ title, description, files, directory, entry }) => {
      if ((files === undefined) === (directory === undefined)) return err(t('errors.artifacts.inputConflict'))
      try {
        if (files) {
          const decoded = decode(files)
          if ('error' in decoded) return err(decoded.error)
          return published(await resolveService().create(convId, { title, description, entry, files: decoded.files }))
        }
        return published(await resolveService().create(convId, { title, description, entry, directory }))
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'artifact_update',
    {
      title: t('tools.artifact_update.title'),
      description: t('tools.artifact_update.description'),
      inputSchema: {
        id: z.string().describe(t('tools.artifact_update.params.id')),
        baseVersion: z.number().int().describe(t('tools.artifact_update.params.baseVersion')),
        summary: z.string().optional().describe(t('tools.artifact_update.params.summary')),
        edits: z
          .array(
            z.object({
              path: z.string(),
              oldText: z.string().describe(t('tools.artifact_update.params.oldText')),
              newText: z.string(),
            })
          )
          .optional()
          .describe(t('tools.artifact_update.params.edits')),
        files: z.array(inlineFile).optional().describe(t('tools.artifact_update.params.files')),
        delete: z.array(z.string()).optional().describe(t('tools.artifact_update.params.delete')),
        directory: z.string().optional().describe(t('tools.artifact_update.params.directory')),
        entry: z.string().optional().describe(t('tools.artifact_update.params.entry')),
      },
    },
    async ({ id, baseVersion, summary, edits, files, delete: remove, directory, entry }) => {
      const modes = [edits !== undefined, files !== undefined || remove !== undefined, directory !== undefined]
      if (modes.filter(Boolean).length !== 1) return err(t('errors.artifacts.inputConflict'))
      let change: ArtifactChange
      if (edits) change = { kind: 'edits', edits }
      else if (directory !== undefined) change = { kind: 'directory', directory }
      else {
        const decoded = decode(files ?? [])
        if ('error' in decoded) return err(decoded.error)
        change = { kind: 'files', files: decoded.files, delete: remove ?? [] }
      }
      try {
        return published(await resolveService().update(convId, { id, baseVersion, summary, entry, change }))
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'artifact_get',
    {
      title: t('tools.artifact_get.title'),
      description: t('tools.artifact_get.description'),
      inputSchema: {
        id: z.string().describe(t('tools.artifact_get.params.id')),
        version: z.number().int().optional().describe(t('tools.artifact_get.params.version')),
        path: z.string().optional().describe(t('tools.artifact_get.params.path')),
      },
    },
    async ({ id, version, path }) => {
      try {
        const service = resolveService()
        const detail = await service.getForConversation(convId, id)
        const number = version ?? detail.currentVersion
        if (path !== undefined) {
          const file = await service.readTextForConversation(convId, id, number, path)
          return ok(JSON.stringify({ path, version: number, truncated: file.truncated, content: file.text }))
        }
        const files = await service.listFilesForConversation(convId, id, number)
        return ok(
          JSON.stringify(
            {
              id: detail.id,
              title: detail.title,
              description: detail.description,
              currentVersion: detail.currentVersion,
              version: number,
              versions: detail.versions.map((v) => ({ number: v.number, summary: v.summary, createdAt: v.createdAt })),
              files: files.map((file) => ({ path: file.path, bytes: file.bytes, text: file.text })),
            },
            null,
            2
          )
        )
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'artifact_list',
    {
      title: t('tools.artifact_list.title'),
      description: t('tools.artifact_list.description'),
      inputSchema: {
        scope: z.enum(['conversation', 'project']).optional().describe(t('tools.artifact_list.params.scope')),
      },
    },
    async ({ scope }) => {
      try {
        const artifacts = await resolveService().listForConversation(convId, scope ?? 'conversation')
        return ok(
          JSON.stringify(
            {
              artifacts: artifacts.map((artifact) => ({
                id: artifact.id,
                title: artifact.title,
                currentVersion: artifact.currentVersion,
                conversationId: artifact.conversationId,
                updatedAt: artifact.updatedAt,
              })),
            },
            null,
            2
          )
        )
      } catch (error) {
        return failure(error)
      }
    }
  )

  server.registerTool(
    'artifact_open',
    {
      title: t('tools.artifact_open.title'),
      description: t('tools.artifact_open.description'),
      inputSchema: {
        id: z.string().describe(t('tools.artifact_open.params.id')),
        version: z.number().int().optional().describe(t('tools.artifact_open.params.version')),
      },
    },
    async ({ id, version }) => {
      try {
        // A delegated worker opens the tab without taking the drawer's focus from the user.
        const detail = await resolveService().openInConversation(convId, id, version, {
          checkScope: true,
          activate: !workerScope,
        })
        return ok(t('returns.artifacts.opened', { title: detail.title, version: version ?? detail.currentVersion }))
      } catch (error) {
        return failure(error)
      }
    }
  )
}
