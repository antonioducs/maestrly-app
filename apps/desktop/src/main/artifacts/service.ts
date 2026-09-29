/**
 * Desktop side of artifacts: agent scope, the owner's views and actions, and settings. Storage and HTTP stay in the
 * artifact host utility process; this service only talks to its admin interface.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  type ArtifactAdmin,
  type ArtifactDetail,
  type ArtifactFileInfo,
  ArtifactHostError,
  type ArtifactSummary,
  type BundleFile,
  isTextPath,
  MAX_TEXT_READ_BYTES,
  readBundleDirectory,
  type TextEdit,
} from '@maestrly/artifact-host'
import type { ArtifactDetailView, ArtifactHostStatus, ArtifactListItem, ArtifactSettings } from '../../shared/artifacts'
import type { Conversation } from '../../shared/conversation'
import type { ArtifactHostProcess } from './host-process'

export type ToolBundleInput = { files?: BundleFile[]; directory?: string }

export type ArtifactChange =
  | { kind: 'edits'; edits: TextEdit[] }
  | { kind: 'files'; files: BundleFile[]; delete: string[] }
  | { kind: 'directory'; directory: string }

export interface ArtifactsServiceDeps {
  host: Pick<ArtifactHostProcess, 'ensureStarted' | 'status' | 'stop' | 'restart'>
  settings: () => ArtifactSettings
  saveSettings: (input: unknown) => ArtifactSettings
  getConversation: (id: string) => Conversation | undefined
  /** Resolves a folder relative to the conversation's files, refusing anything outside them. */
  resolveDirectory: (conversation: Conversation, relative: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
  openInDrawer: (convId: string, url: string, activate: boolean) => void
  emitStatus: (status: ArtifactHostStatus) => void
}

const LOCAL_OWNER = { kind: 'local', id: 'local' } as const
const notFound = (message = 'Artifact not found') => new ArtifactHostError('not_found', message)

export class ArtifactsService {
  constructor(private readonly deps: ArtifactsServiceDeps) {}

  private admin(): Promise<ArtifactAdmin> {
    return this.deps.host.ensureStarted()
  }

  private conversation(convId: string): Conversation {
    const conversation = this.deps.getConversation(convId)
    if (!conversation) throw notFound('Conversation not found')
    return conversation
  }

  /** Agents reach their own project's artifacts, or their own conversation's when it is standalone. */
  private inScope(conversation: Conversation, artifact: ArtifactSummary): boolean {
    if (artifact.ownerKind !== 'local') return false
    if (conversation.scope === 'standalone') return artifact.conversationId === conversation.id
    return artifact.workspaceId === conversation.workspaceId
  }

  private async scoped(admin: ArtifactAdmin, conversation: Conversation, id: string): Promise<ArtifactDetail> {
    const artifact = await admin.get(id)
    // Out-of-scope artifacts are reported exactly like missing ones.
    if (!artifact || !this.inScope(conversation, artifact)) throw notFound()
    return artifact
  }

  private async bundle(conversation: Conversation, input: ToolBundleInput) {
    if (input.directory !== undefined)
      return readBundleDirectory(await this.deps.resolveDirectory(conversation, input.directory))
    return { files: input.files ?? [], skipped: [] as string[] }
  }

  async create(
    convId: string,
    input: { title: string; description?: string; entry?: string } & ToolBundleInput
  ): Promise<{ detail: ArtifactDetail; skipped: string[] }> {
    const conversation = this.conversation(convId)
    const { files, skipped } = await this.bundle(conversation, input)
    const admin = await this.admin()
    const detail = await admin.create({
      title: input.title,
      description: input.description,
      entry: input.entry,
      owner: LOCAL_OWNER,
      origin: {
        workspaceId: conversation.scope === 'project' ? conversation.workspaceId : null,
        conversationId: conversation.id,
        conversationTitle: conversation.name,
      },
      createdBy: 'agent',
      files,
    })
    return { detail, skipped }
  }

  async update(
    convId: string,
    input: { id: string; baseVersion: number; summary?: string; entry?: string; change: ArtifactChange }
  ): Promise<{ detail: ArtifactDetail; skipped: string[] }> {
    const conversation = this.conversation(convId)
    const admin = await this.admin()
    await this.scoped(admin, conversation, input.id)
    let skipped: string[] = []
    let change: Exclude<ArtifactChange, { kind: 'directory' }> | { kind: 'replace'; files: BundleFile[] }
    if (input.change.kind === 'directory') {
      const bundle = await this.bundle(conversation, { directory: input.change.directory })
      change = { kind: 'replace', files: bundle.files }
      skipped = bundle.skipped
    } else {
      change = input.change
    }
    const detail = await admin.update({
      id: input.id,
      baseVersion: input.baseVersion,
      summary: input.summary,
      entry: input.entry,
      createdBy: 'agent',
      conversationTitle: conversation.name,
      change,
    })
    return { detail, skipped }
  }

  async getForConversation(convId: string, id: string): Promise<ArtifactDetail> {
    return this.scoped(await this.admin(), this.conversation(convId), id)
  }

  async listFilesForConversation(convId: string, id: string, version?: number): Promise<ArtifactFileInfo[]> {
    const admin = await this.admin()
    await this.scoped(admin, this.conversation(convId), id)
    return admin.listFiles(id, version)
  }

  async readTextForConversation(
    convId: string,
    id: string,
    version: number,
    filePath: string
  ): Promise<{ text: string; truncated: boolean }> {
    const admin = await this.admin()
    await this.scoped(admin, this.conversation(convId), id)
    if (!isTextPath(filePath))
      throw new ArtifactHostError('edit_binary', `${filePath} is not a text file`, { path: filePath })
    const file = await admin.readFile(id, version, filePath)
    if (!file) throw notFound(`${filePath} is not in version ${version}`)
    const truncated = file.bytes.byteLength > MAX_TEXT_READ_BYTES
    const bytes = truncated ? file.bytes.subarray(0, MAX_TEXT_READ_BYTES) : file.bytes
    return { text: new TextDecoder().decode(bytes), truncated }
  }

  async listForConversation(convId: string, scope: 'conversation' | 'project'): Promise<ArtifactSummary[]> {
    const conversation = this.conversation(convId)
    const admin = await this.admin()
    if (conversation.scope === 'standalone' || scope === 'conversation')
      return admin.list({ ownerKind: 'local', conversationId: conversation.id })
    return admin.list({ ownerKind: 'local', workspaceId: conversation.workspaceId })
  }

  private toListItem(artifact: ArtifactSummary): ArtifactListItem {
    const conversation = artifact.conversationId ? this.deps.getConversation(artifact.conversationId) : undefined
    return {
      id: artifact.id,
      title: artifact.title,
      description: artifact.description,
      currentVersion: artifact.currentVersion,
      versionCount: artifact.versionCount,
      visibility: artifact.visibility,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      host: 'local',
      conversation: artifact.conversationId
        ? {
            id: artifact.conversationId,
            title: conversation?.name ?? artifact.conversationTitle,
            exists: conversation !== undefined,
          }
        : null,
    }
  }

  async listAll(): Promise<ArtifactListItem[]> {
    return (await (await this.admin()).list()).map((artifact) => this.toListItem(artifact))
  }

  async detail(id: string): Promise<ArtifactDetailView | null> {
    const artifact = await (await this.admin()).get(id)
    if (!artifact) return null
    return {
      ...this.toListItem(artifact),
      versions: artifact.versions.map((version) => ({
        number: version.number,
        summary: version.summary,
        createdAt: version.createdAt,
        fileCount: version.fileCount,
        totalBytes: version.totalBytes,
      })),
    }
  }

  async remove(id: string): Promise<boolean> {
    return (await this.admin()).delete(id)
  }

  /** The owner's URL: the single-use ticket travels in the fragment, which never reaches a server log. */
  private async ownerUrl(admin: ArtifactAdmin, id: string, version?: number): Promise<string> {
    const { ticket } = await admin.mintOwnerTicket(id)
    const port = this.deps.host.status().port
    return `http://127.0.0.1:${port}/a/${id}#o=${ticket}${version ? `&v=${version}` : ''}`
  }

  async openExternal(id: string, version?: number): Promise<void> {
    await this.deps.openExternal(await this.ownerUrl(await this.admin(), id, version))
  }

  async openInConversation(
    convId: string,
    id: string,
    version?: number,
    options: { checkScope?: boolean; activate?: boolean } = {}
  ): Promise<ArtifactDetail> {
    const conversation = this.conversation(convId)
    const admin = await this.admin()
    const artifact = options.checkScope ? await this.scoped(admin, conversation, id) : await admin.get(id)
    if (!artifact) throw notFound()
    this.deps.openInDrawer(conversation.id, await this.ownerUrl(admin, id, version), options.activate ?? true)
    return artifact
  }

  async status(): Promise<ArtifactHostStatus> {
    const status = this.deps.host.status()
    if (status.state !== 'running') return status
    try {
      return { ...status, ...(await (await this.admin()).status()) }
    } catch {
      return this.deps.host.status()
    }
  }

  getSettings(): ArtifactSettings {
    return this.deps.settings()
  }

  async setSettings(input: unknown): Promise<ArtifactSettings> {
    const before = this.deps.settings()
    const after = this.deps.saveSettings(input)
    const state = this.deps.host.status().state
    const changed = before.port !== after.port || before.quotaGb !== after.quotaGb
    if (!after.hostEnabled) await this.deps.host.stop()
    else if ((changed && state !== 'stopped') || (!before.hostEnabled && after.hostEnabled))
      await this.deps.host.restart()
    this.deps.emitStatus(await this.status())
    return after
  }

  /** Starts the host, clearing a crash or busy-port state. */
  async start(): Promise<ArtifactHostStatus> {
    if (this.deps.host.status().state === 'error') await this.deps.host.restart()
    else await this.admin().catch(() => {})
    const status = await this.status()
    this.deps.emitStatus(status)
    return status
  }

  /** Writes a consistent database snapshot to `<targetDir>/artifacts.sqlite` for a data export. */
  async prepareExport(targetDir: string): Promise<boolean> {
    await mkdir(targetDir, { recursive: true, mode: 0o700 })
    await (await this.admin()).snapshot(path.join(targetDir, 'artifacts.sqlite'))
    return true
  }
}
