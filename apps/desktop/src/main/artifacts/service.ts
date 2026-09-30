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
  type CommentView,
  isTextPath,
  MAX_TEXT_READ_BYTES,
  readBundleDirectory,
  type TextEdit,
} from '@maestrly/artifact-host'
import type {
  ArtifactCommentView,
  ArtifactDetailView,
  ArtifactEventView,
  ArtifactHostStatus,
  ArtifactListItem,
  ArtifactRemoveResult,
  ArtifactSettings,
  ArtifactSharingPatch,
  ArtifactSharingView,
  ArtifactThumbnailView,
} from '../../shared/artifacts'
import type { Conversation } from '../../shared/conversation'
import type { ArtifactHostProcess } from './host-process'
import type { InviteVault } from './invite-vault'

export type ToolBundleInput = { files?: BundleFile[]; directory?: string }

export type ArtifactChange =
  | { kind: 'edits'; edits: TextEdit[] }
  | { kind: 'files'; files: BundleFile[]; delete: string[] }
  | { kind: 'directory'; directory: string }

export interface ArtifactsServiceDeps {
  host: Pick<ArtifactHostProcess, 'ensureStarted' | 'status' | 'stop' | 'restart'>
  /** The tokens of personal links, kept so the owner can copy a link again. */
  vault: InviteVault
  settings: () => ArtifactSettings
  saveSettings: (input: unknown) => ArtifactSettings
  getConversation: (id: string) => Conversation | undefined
  /** The name of a project, or undefined once it was removed. */
  workspaceName: (id: string) => string | undefined
  /** Resolves a folder relative to the conversation's files, refusing anything outside them. */
  resolveDirectory: (conversation: Conversation, relative: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
  openInDrawer: (convId: string, url: string, activate: boolean) => void
  emitStatus: (status: ArtifactHostStatus) => void
  /** Asks for a preview image of a version; the capture runs later and may not happen. */
  requestThumbnail?: (id: string, version: number) => void
}

const LOCAL_OWNER = { kind: 'local', id: 'local' } as const
/** Pages of 200 comments: more than an artifact's 2,000 comments need. */
const MAX_COMMENT_PAGES = 20

/** What the app shows of a comment: the author's internal ID stays in the host. */
const toCommentView = (comment: CommentView): ArtifactCommentView => ({
  id: comment.id,
  version: comment.version,
  parentId: comment.parentId,
  author: { kind: comment.author.kind, name: comment.author.name, verified: comment.author.verified },
  body: comment.body,
  place: comment.anchor?.quote ? 'passage' : comment.anchor?.point ? 'spot' : 'page',
  quote: comment.anchor?.quote?.exact ?? null,
  status: comment.status,
  createdAt: comment.createdAt,
})
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
    this.deps.requestThumbnail?.(detail.id, detail.currentVersion)
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
    this.deps.requestThumbnail?.(detail.id, detail.currentVersion)
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

  /**
   * What people wrote on an artifact, for an agent. The caller hands it to the model as untrusted data: a comment is
   * feedback from someone outside the conversation, never an instruction.
   */
  async commentsForConversation(
    convId: string,
    id: string,
    filter: { status?: 'open' | 'all'; version?: number; cursor?: string }
  ): Promise<{ comments: CommentView[]; nextCursor: string | null; currentVersion: number }> {
    const admin = await this.admin()
    const artifact = await this.scoped(admin, this.conversation(convId), id)
    const page = await admin.listComments(id, {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.version === undefined ? {} : { version: filter.version }),
      ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
    })
    return { ...page, currentVersion: artifact.currentVersion }
  }

  /** An agent's reply, stored as written by the owner's agent. */
  async replyForConversation(convId: string, id: string, commentId: string, body: string): Promise<CommentView> {
    const admin = await this.admin()
    await this.scoped(admin, this.conversation(convId), id)
    return admin.addComment(id, { author: 'agent', body, parentId: commentId })
  }

  async resolveForConversation(convId: string, id: string, commentId: string): Promise<void> {
    const admin = await this.admin()
    await this.scoped(admin, this.conversation(convId), id)
    await admin.setCommentResolved(id, commentId, true)
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
      project: artifact.workspaceId
        ? { id: artifact.workspaceId, name: this.deps.workspaceName(artifact.workspaceId) ?? null }
        : null,
      storageBytes: artifact.storageBytes,
      thumbnailVersion: artifact.thumbnailVersion,
      unseenEvents: artifact.unseenEvents,
      pendingRequests: artifact.pendingRequests,
      openComments: artifact.openComments,
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
    const items = (await (await this.admin()).list()).map((artifact) => this.toListItem(artifact))
    // Artifacts published before thumbnails existed, or whose capture failed, get one once they are listed.
    for (const item of items)
      if (item.thumbnailVersion !== item.currentVersion) this.deps.requestThumbnail?.(item.id, item.currentVersion)
    return items
  }

  async thumbnail(id: string, version?: number): Promise<ArtifactThumbnailView | null> {
    const image = await (await this.admin()).getThumbnail(id, version)
    if (!image) return null
    return {
      version: image.version,
      dataUrl: `data:${image.contentType};base64,${Buffer.from(image.bytes).toString('base64')}`,
    }
  }

  /**
   * The owner view of one version, for the thumbnail capture; its ticket works once and within a minute. It asks for
   * the page alone, so comment pins stay out of the preview.
   */
  async thumbnailSourceUrl(id: string, version: number): Promise<string> {
    return this.ownerUrl(await this.admin(), id, version, true)
  }

  async saveThumbnail(id: string, version: number, image: Uint8Array): Promise<void> {
    await (await this.admin()).setThumbnail(id, version, image)
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

  async remove(id: string): Promise<ArtifactRemoveResult> {
    const admin = await this.admin()
    const before = (await admin.status()).storageBytes
    // The personal links die with the artifact; their tokens must not outlive it.
    const people = await admin.getSharing(id).then(
      (sharing) => sharing.people,
      () => []
    )
    const removed = await admin.delete(id)
    if (removed) for (const person of people) this.deps.vault.remove(person.id)
    const after = (await admin.status()).storageBytes
    return { removed, freedBytes: Math.max(0, before - after) }
  }

  private localBase(): string {
    return `http://127.0.0.1:${this.deps.host.status().port}`
  }

  /** A personal link. The token travels in the fragment, which never reaches a server log. */
  private inviteUrl(id: string, token: string): string {
    return `${this.deps.settings().publicAddress || this.localBase()}/a/${id}#i=${token}`
  }

  private async sharingView(admin: ArtifactAdmin, id: string): Promise<ArtifactSharingView> {
    return this.toSharingView(await admin.getSharing(id))
  }

  private toSharingView(sharing: Awaited<ReturnType<ArtifactAdmin['getSharing']>>): ArtifactSharingView {
    return {
      visibility: sharing.visibility,
      linkExpiresAt: sharing.linkExpiresAt,
      hasAccessCode: sharing.hasAccessCode,
      commentsEnabled: sharing.commentsEnabled,
      people: sharing.people.map((person) => ({
        id: person.id,
        kind: person.kind,
        name: person.name,
        createdAt: person.createdAt,
        inviteExpiresAt: person.inviteExpiresAt,
        linkAvailable: person.kind === 'invited' && this.deps.vault.get(person.id) !== null,
        devices: person.devices,
      })),
      requests: sharing.requests,
      publicBase: this.deps.settings().publicAddress || null,
      localBase: this.localBase(),
    }
  }

  /** Who can open an artifact. Only the owner's interface reaches this and the operations below, never an agent. */
  async sharing(id: string): Promise<ArtifactSharingView> {
    return this.sharingView(await this.admin(), id)
  }

  async setSharing(id: string, patch: ArtifactSharingPatch): Promise<ArtifactSharingView> {
    return this.toSharingView(await (await this.admin()).setSharing(id, patch))
  }

  async createInvite(id: string, name: string): Promise<{ principalId: string; link: string }> {
    const { principalId, token } = await (await this.admin()).createInvite(id, { name })
    this.deps.vault.save(principalId, token)
    return { principalId, link: this.inviteUrl(id, token) }
  }

  /** The person's link again, or null when its token is no longer stored and the link can only be reset. */
  async inviteLink(id: string, principalId: string): Promise<string | null> {
    const { people } = await (await this.admin()).getSharing(id)
    const person = people.find((candidate) => candidate.id === principalId)
    if (person?.kind !== 'invited') return null
    const token = this.deps.vault.get(principalId)
    return token ? this.inviteUrl(id, token) : null
  }

  async resetInvite(id: string, principalId: string): Promise<string> {
    const { token } = await (await this.admin()).resetInvite(id, principalId)
    this.deps.vault.save(principalId, token)
    return this.inviteUrl(id, token)
  }

  async revokePerson(id: string, principalId: string): Promise<void> {
    await (await this.admin()).revokePerson(id, principalId)
    this.deps.vault.remove(principalId)
  }

  async revokeDevice(id: string, sessionId: string): Promise<void> {
    await (await this.admin()).revokeDevice(id, sessionId)
  }

  async revokeAllSessions(id: string): Promise<void> {
    await (await this.admin()).revokeAllSessions(id)
  }

  async decideRequest(id: string, requestId: string, decision: { approve: boolean; name?: string }): Promise<void> {
    await (await this.admin()).decideAccessRequest(id, requestId, decision)
  }

  async events(artifactId?: string): Promise<ArtifactEventView[]> {
    return (await this.admin()).listEvents(artifactId === undefined ? {} : { artifactId })
  }

  async markSeen(artifactId?: string): Promise<void> {
    await (await this.admin()).markEventsSeen(artifactId)
  }

  /** Every comment of an artifact, in the order they were written. */
  async comments(id: string): Promise<ArtifactCommentView[]> {
    const admin = await this.admin()
    const all: ArtifactCommentView[] = []
    let cursor: string | undefined
    // The host pages comments; the limit on comments per artifact bounds the loop.
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      const result = await admin.listComments(id, cursor ? { cursor } : {})
      all.push(...result.comments.map(toCommentView))
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    return all
  }

  /** The owner's reply to a thread, written in the app instead of the viewer. */
  async replyComment(id: string, commentId: string, body: string): Promise<ArtifactCommentView> {
    return toCommentView(await (await this.admin()).addComment(id, { author: 'owner', body, parentId: commentId }))
  }

  async resolveComment(id: string, commentId: string, resolved: boolean): Promise<void> {
    await (await this.admin()).setCommentResolved(id, commentId, resolved)
  }

  async deleteComment(id: string, commentId: string): Promise<void> {
    await (await this.admin()).deleteComment(id, commentId)
  }

  /** Events the owner has not seen, across artifacts. It never starts the host: a stopped host has nothing new. */
  async unseenCount(): Promise<number> {
    if (this.deps.host.status().state !== 'running') return 0
    try {
      const artifacts = await (await this.admin()).list()
      return artifacts.reduce((sum, artifact) => sum + artifact.unseenEvents, 0)
    } catch {
      return 0
    }
  }

  /** The owner's URL: the single-use ticket travels in the fragment, which never reaches a server log. */
  private async ownerUrl(admin: ArtifactAdmin, id: string, version?: number, preview = false): Promise<string> {
    const { ticket } = await admin.mintOwnerTicket(id)
    const port = this.deps.host.status().port
    return `http://127.0.0.1:${port}/a/${id}#o=${ticket}${version ? `&v=${version}` : ''}${preview ? '&preview=1' : ''}`
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
    // The host reads these when it starts, so changing any of them takes a restart.
    const changed =
      before.port !== after.port ||
      before.quotaGb !== after.quotaGb ||
      before.publicAddress !== after.publicAddress ||
      before.ownerName !== after.ownerName
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
