/**
 * Desktop side of artifacts: agent scope, the owner's views and actions, and the bot server's settings. Artifacts live
 * only on the bot server; this service talks to its admin interface, and moves what earlier versions left on this
 * computer.
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
  ArtifactListItem,
  ArtifactRemoveResult,
  ArtifactSharingPatch,
  ArtifactSharingView,
  ArtifactThumbnailView,
  LegacyArtifactView,
  LegacyMoveState,
} from '../../shared/artifacts'
import type { FleetArtifactHost, FleetArtifactSettingsPatch } from '@maestrly/bot-fleet-protocol'
import type { ArtifactServerStatus } from '../../shared/artifacts'
import { serverUnavailable, type ArtifactSource, type ArtifactSources } from './sources'
import type { ServerArtifacts } from './server-artifacts'
import type { Conversation } from '../../shared/conversation'
import type { InviteVault } from './invite-vault'
import type { LegacyArtifacts } from './legacy'

export type ToolBundleInput = { files?: BundleFile[]; directory?: string }

export type ArtifactChange =
  | { kind: 'edits'; edits: TextEdit[] }
  | { kind: 'files'; files: BundleFile[]; delete: string[] }
  | { kind: 'directory'; directory: string }

export interface ArtifactsServiceDeps {
  sources: ArtifactSources
  server?: ServerArtifacts
  /** What earlier versions published on this computer; absent in a bot's own Maestrly. */
  legacy?: LegacyArtifacts
  emitChanged?: () => void
  botName?: (id: string) => string | undefined
  /** The tokens of personal links, kept so the owner can copy a link again. */
  vault: InviteVault
  getConversation: (id: string) => Conversation | undefined
  /** The name of a project, or undefined once it was removed. */
  workspaceName: (id: string) => string | undefined
  /** Resolves a folder relative to the conversation's files, refusing anything outside them. */
  resolveDirectory: (conversation: Conversation, relative: string) => Promise<string>
  openExternal: (url: string) => Promise<void>
  openInDrawer: (convId: string, url: string, activate: boolean) => void
  /** Asks for a preview image of a version; the capture runs later and may not happen. */
  requestThumbnail?: (id: string, version: number) => void
}

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
/** An artifact an earlier version published on this computer: it opens again once moved to the bot server. */
const onThisComputer = () =>
  new ArtifactHostError('host_unavailable', 'The artifact is on this computer and must be moved to the bot server', {
    reason: 'on_this_computer',
  })

export class ArtifactsService {
  private readonly sources: ArtifactSources
  private readonly locations = new Map<string, ArtifactSource>()
  constructor(private readonly deps: ArtifactsServiceDeps) {
    this.sources = deps.sources
  }

  private async refreshSources(): Promise<void> {
    await this.deps.server?.refresh()
  }

  /** Not on the server: when it is among the artifacts on this computer, says so instead of "not found". */
  private async missing(id: string): Promise<ArtifactHostError> {
    return (await this.deps.legacy?.has(id)) ? onThisComputer() : notFound()
  }

  private conversation(convId: string): Conversation {
    const conversation = this.deps.getConversation(convId)
    if (!conversation) throw notFound('Conversation not found')
    return conversation
  }

  /** Agents reach only their owner's project, or their standalone conversation. */
  private inScope(conversation: Conversation, artifact: ArtifactSummary, source: ArtifactSource): boolean {
    if (artifact.ownerKind !== source.owner.kind || artifact.ownerId !== source.owner.id) return false
    if (conversation.scope === 'standalone') return artifact.conversationId === conversation.id
    return artifact.workspaceId === conversation.workspaceId
  }

  private async find(id: string, sources: ArtifactSource[], conversation?: Conversation) {
    let unavailable: unknown
    for (const source of sources) {
      try {
        const admin = await source.admin()
        const artifact = await admin.get(id)
        if (!artifact) continue
        if (conversation && !this.inScope(conversation, artifact, source)) throw notFound()
        this.locations.set(id, source)
        return { source, admin, artifact }
      } catch (error) {
        if (!(error instanceof ArtifactHostError) || error.code !== 'host_unavailable') throw error
        unavailable = error
      }
    }
    if (unavailable) throw unavailable
    return null
  }

  private async scoped(conversation: Conversation, id: string) {
    await this.refreshSources()
    const found = await this.find(id, this.sources.forConversation(conversation), conversation)
    if (!found) throw await this.missing(id)
    return found
  }

  private async at(id: string) {
    await this.refreshSources()
    const sources = this.sources.managed()
    const cached = this.locations.get(id)
    // Resolve against today's sources: pairing another server invalidates cached credentials.
    const preferred = cached && sources.find((s) => s.key === cached.key && s.owner.id === cached.owner.id)
    return this.find(id, preferred ? [preferred, ...sources.filter((s) => s !== preferred)] : sources)
  }

  private async requiredAt(id: string) {
    const found = await this.at(id)
    if (!found) throw await this.missing(id)
    return found
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
    await this.refreshSources()
    const source = this.sources.publishTarget(conversation)
    const admin = await source.admin()
    const detail = await admin.create({
      title: input.title,
      description: input.description,
      entry: input.entry,
      owner: source.owner,
      origin: {
        workspaceId: conversation.scope === 'project' ? conversation.workspaceId : null,
        conversationId: conversation.id,
        conversationTitle: conversation.name,
      },
      createdBy: 'agent',
      files,
    })
    this.locations.set(detail.id, source)
    if (source.viewerBase()) this.deps.requestThumbnail?.(detail.id, detail.currentVersion)
    return { detail, skipped }
  }

  async update(
    convId: string,
    input: { id: string; baseVersion: number; summary?: string; entry?: string; change: ArtifactChange }
  ): Promise<{ detail: ArtifactDetail; skipped: string[] }> {
    const conversation = this.conversation(convId)
    const { admin, source } = await this.scoped(conversation, input.id)
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
    if (source.viewerBase()) this.deps.requestThumbnail?.(detail.id, detail.currentVersion)
    return { detail, skipped }
  }

  async getForConversation(convId: string, id: string): Promise<ArtifactDetail> {
    return (await this.scoped(this.conversation(convId), id)).artifact
  }

  async listFilesForConversation(convId: string, id: string, version?: number): Promise<ArtifactFileInfo[]> {
    const { admin } = await this.scoped(this.conversation(convId), id)
    return admin.listFiles(id, version)
  }

  async readTextForConversation(
    convId: string,
    id: string,
    version: number,
    filePath: string
  ): Promise<{ text: string; truncated: boolean }> {
    const { admin } = await this.scoped(this.conversation(convId), id)
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
    const { admin, artifact } = await this.scoped(this.conversation(convId), id)
    const page = await admin.listComments(id, {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.version === undefined ? {} : { version: filter.version }),
      ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
    })
    return { ...page, currentVersion: artifact.currentVersion }
  }

  /** An agent's reply, stored as written by the owner's agent. */
  async replyForConversation(convId: string, id: string, commentId: string, body: string): Promise<CommentView> {
    const { admin } = await this.scoped(this.conversation(convId), id)
    return admin.addComment(id, { author: 'agent', body, parentId: commentId })
  }

  async resolveForConversation(convId: string, id: string, commentId: string): Promise<void> {
    const { admin } = await this.scoped(this.conversation(convId), id)
    await admin.setCommentResolved(id, commentId, true)
  }

  async listForConversation(convId: string, scope: 'conversation' | 'project'): Promise<ArtifactSummary[]> {
    const conversation = this.conversation(convId)
    await this.refreshSources()
    const sources = this.sources.forConversation(conversation)
    const groups = await Promise.all(
      sources.map(async (source) => {
        const admin = await source.admin()
        const filter =
          conversation.scope === 'standalone' || scope === 'conversation'
            ? { conversationId: conversation.id }
            : { workspaceId: conversation.workspaceId }
        return admin.list({ ownerKind: source.owner.kind, ownerId: source.owner.id, ...filter })
      })
    )
    return groups.flat()
  }

  private toListItem(artifact: ArtifactSummary, source: ArtifactSource): ArtifactListItem {
    const own = artifact.ownerKind === source.owner.kind && artifact.ownerId === source.owner.id
    const localConversation = own && artifact.ownerKind !== 'bot'
    const conversation =
      localConversation && artifact.conversationId ? this.deps.getConversation(artifact.conversationId) : undefined
    return {
      id: artifact.id,
      title: artifact.title,
      description: artifact.description,
      currentVersion: artifact.currentVersion,
      versionCount: artifact.versionCount,
      visibility: artifact.visibility,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      bot:
        artifact.ownerKind === 'bot'
          ? { id: artifact.ownerId, name: this.deps.botName?.(artifact.ownerId) ?? null }
          : null,
      elsewhere: artifact.ownerKind === 'device' && !own,
      project:
        localConversation && artifact.workspaceId
          ? { id: artifact.workspaceId, name: this.deps.workspaceName(artifact.workspaceId) ?? null }
          : null,
      storageBytes: artifact.storageBytes,
      thumbnailVersion: artifact.thumbnailVersion,
      unseenEvents: artifact.unseenEvents,
      pendingRequests: artifact.pendingRequests,
      openComments: artifact.openComments,
      conversation:
        localConversation && artifact.conversationId
          ? {
              id: artifact.conversationId,
              title: conversation?.name ?? artifact.conversationTitle,
              exists: conversation !== undefined,
            }
          : null,
    }
  }

  async listAll(): Promise<ArtifactListItem[]> {
    await this.refreshSources()
    const results = await Promise.allSettled(
      this.sources.managed().map(async (source) => {
        const artifacts = await (await source.admin()).list()
        return artifacts.map((artifact) => {
          this.locations.set(artifact.id, source)
          if (source.viewerBase() && artifact.thumbnailVersion !== artifact.currentVersion)
            this.deps.requestThumbnail?.(artifact.id, artifact.currentVersion)
          return this.toListItem(artifact, source)
        })
      })
    )
    const items = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    // An unavailable source does not hide the other one's artifacts; status is shown separately.
    return items
  }

  async thumbnail(id: string, version?: number): Promise<ArtifactThumbnailView | null> {
    const image = await (await this.requiredAt(id)).admin.getThumbnail(id, version)
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
    const { source, admin } = await this.requiredAt(id)
    return this.ownerUrl(source, admin, id, version, true)
  }

  async saveThumbnail(id: string, version: number, image: Uint8Array): Promise<void> {
    await (await this.requiredAt(id)).admin.setThumbnail(id, version, image)
  }

  async detail(id: string): Promise<ArtifactDetailView | null> {
    const found = await this.at(id)
    if (!found) return null
    const { artifact, source } = found
    return {
      ...this.toListItem(artifact, source),
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
    const found = await this.at(id)
    if (!found) return { removed: false, freedBytes: 0 }
    const { admin } = found
    const before = (await admin.status()).storageBytes
    // The personal links die with the artifact; their tokens must not outlive it.
    const people = await admin.getSharing(id).then(
      (sharing) => sharing.people,
      () => []
    )
    const removed = await admin.delete(id)
    if (removed) for (const person of people) this.deps.vault.remove(person.id)
    if (removed) this.locations.delete(id)
    const after = (await admin.status()).storageBytes
    return { removed, freedBytes: Math.max(0, before - after) }
  }

  /** Personal links keep the token in the fragment. */
  private inviteUrl(source: ArtifactSource, id: string, token: string): string {
    const base = source.publicBase() || source.viewerBase()
    if (!base) throw serverUnavailable('no_viewer')
    return `${base}/a/${id}#i=${token}`
  }

  private toSharingView(
    source: ArtifactSource,
    sharing: Awaited<ReturnType<ArtifactAdmin['getSharing']>>
  ): ArtifactSharingView {
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
      publicBase: source.publicBase(),
      localBase: source.viewerBase() ?? '',
      defaultLinkExpiryDays: source.linkExpiryDays(),
    }
  }

  /** Who can open an artifact. Only the owner's interface reaches this and the operations below, never an agent. */
  async sharing(id: string): Promise<ArtifactSharingView> {
    const { source, admin } = await this.requiredAt(id)
    return this.toSharingView(source, await admin.getSharing(id))
  }

  async setSharing(id: string, patch: ArtifactSharingPatch): Promise<ArtifactSharingView> {
    const { source, admin } = await this.requiredAt(id)
    return this.toSharingView(source, await admin.setSharing(id, patch))
  }

  async createInvite(id: string, name: string): Promise<{ principalId: string; link: string }> {
    const { source, admin } = await this.requiredAt(id)
    if (!source.publicBase() && !source.viewerBase()) throw serverUnavailable('no_viewer')
    const { principalId, token } = await admin.createInvite(id, { name })
    this.deps.vault.save(principalId, token)
    return { principalId, link: this.inviteUrl(source, id, token) }
  }

  /** The person's link again, or null when its token is no longer stored and the link can only be reset. */
  async inviteLink(id: string, principalId: string): Promise<string | null> {
    const { source, admin } = await this.requiredAt(id)
    const { people } = await admin.getSharing(id)
    const person = people.find((candidate) => candidate.id === principalId)
    if (person?.kind !== 'invited') return null
    const token = this.deps.vault.get(principalId)
    return token ? this.inviteUrl(source, id, token) : null
  }

  async resetInvite(id: string, principalId: string): Promise<string> {
    const { source, admin } = await this.requiredAt(id)
    if (!source.publicBase() && !source.viewerBase()) throw serverUnavailable('no_viewer')
    const { token } = await admin.resetInvite(id, principalId)
    this.deps.vault.save(principalId, token)
    return this.inviteUrl(source, id, token)
  }

  async revokePerson(id: string, principalId: string): Promise<void> {
    await (await this.requiredAt(id)).admin.revokePerson(id, principalId)
    this.deps.vault.remove(principalId)
  }

  async revokeDevice(id: string, sessionId: string): Promise<void> {
    await (await this.requiredAt(id)).admin.revokeDevice(id, sessionId)
  }

  async revokeAllSessions(id: string): Promise<void> {
    await (await this.requiredAt(id)).admin.revokeAllSessions(id)
  }

  async decideRequest(id: string, requestId: string, decision: { approve: boolean; name?: string }): Promise<void> {
    await (await this.requiredAt(id)).admin.decideAccessRequest(id, requestId, decision)
  }

  async events(artifactId?: string): Promise<ArtifactEventView[]> {
    if (artifactId) return (await this.requiredAt(artifactId)).admin.listEvents({ artifactId })
    await this.refreshSources()
    const results = await Promise.allSettled(
      this.sources
        .managed()
        .filter((s) => s.ready())
        .map(async (s) => (await s.admin()).listEvents({}))
    )
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => b.createdAt - a.createdAt)
  }

  async markSeen(artifactId?: string): Promise<void> {
    if (artifactId) {
      await (await this.requiredAt(artifactId)).admin.markEventsSeen(artifactId)
      return
    }
    await this.refreshSources()
    await Promise.all(
      this.sources
        .managed()
        .filter((s) => s.ready())
        .map(async (s) => (await s.admin()).markEventsSeen())
    )
  }

  /** Every comment of an artifact, in the order they were written. */
  async comments(id: string): Promise<ArtifactCommentView[]> {
    const { admin } = await this.requiredAt(id)
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
    return toCommentView(
      await (await this.requiredAt(id)).admin.addComment(id, { author: 'owner', body, parentId: commentId })
    )
  }

  async resolveComment(id: string, commentId: string, resolved: boolean): Promise<void> {
    await (await this.requiredAt(id)).admin.setCommentResolved(id, commentId, resolved)
  }

  async deleteComment(id: string, commentId: string): Promise<void> {
    await (await this.requiredAt(id)).admin.deleteComment(id, commentId)
  }

  /** Events the owner has not seen, across artifacts. It never starts the host: a stopped host has nothing new. */
  async unseenCount(): Promise<number> {
    await this.refreshSources()
    const results = await Promise.allSettled(
      this.sources
        .managed()
        .filter((s) => s.ready())
        .map(async (s) => {
          const artifacts = await (await s.admin()).list()
          return artifacts.reduce((sum, a) => sum + a.unseenEvents, 0)
        })
    )
    return results.reduce((sum, r) => sum + (r.status === 'fulfilled' ? r.value : 0), 0)
  }

  /** Owner tickets are single-use and never put in the query or a log. */
  private async ownerUrl(
    source: ArtifactSource,
    admin: ArtifactAdmin,
    id: string,
    version?: number,
    preview = false
  ): Promise<string> {
    const base = source.viewerBase()
    if (!base) throw serverUnavailable('no_viewer')
    const { ticket } = await admin.mintOwnerTicket(id)
    return `${base}/a/${id}#o=${ticket}${version ? `&v=${version}` : ''}${preview ? '&preview=1' : ''}`
  }

  async openExternal(id: string, version?: number): Promise<void> {
    const { source, admin } = await this.requiredAt(id)
    await this.deps.openExternal(await this.ownerUrl(source, admin, id, version))
  }

  async openInConversation(
    convId: string,
    id: string,
    version?: number,
    options: { checkScope?: boolean; activate?: boolean } = {}
  ): Promise<ArtifactDetail> {
    const conversation = this.conversation(convId)
    const { source, admin, artifact } = options.checkScope
      ? await this.scoped(conversation, id)
      : await this.requiredAt(id)
    this.deps.openInDrawer(conversation.id, await this.ownerUrl(source, admin, id, version), options.activate ?? true)
    return artifact
  }

  async serverStatus(): Promise<ArtifactServerStatus> {
    return (await this.deps.server?.refresh()) ?? { state: 'absent' }
  }
  async serverHost(): Promise<FleetArtifactHost | null> {
    await this.refreshSources()
    return this.deps.server?.host() ?? null
  }
  async setServerHost(patch: FleetArtifactSettingsPatch): Promise<FleetArtifactHost> {
    if (!this.deps.server) throw serverUnavailable()
    const host = await this.deps.server.update(patch)
    this.deps.emitChanged?.()
    return host
  }

  /** What earlier versions left on this computer, waiting to be moved or deleted. */
  async legacyList(): Promise<LegacyArtifactView[]> {
    return (await this.deps.legacy?.list()) ?? []
  }

  legacyState(): LegacyMoveState {
    return (
      this.deps.legacy?.state() ?? { phase: 'idle', items: [], moved: [], current: null, stopping: false, error: null }
    )
  }

  /**
   * Starts moving the artifacts on this computer (all, or the given ones) to the bot server, in the main process;
   * returns at once. The server must be ready and accept moved artifacts.
   */
  async legacyMove(ids?: string[]): Promise<LegacyMoveState> {
    const legacy = this.deps.legacy
    if (!legacy) throw notFound()
    const state = this.legacyState()
    if (state.phase === 'running') return state
    await this.refreshSources()
    const server = this.deps.server
    const source = server?.source()
    if (!server || !source) throw server?.unavailable() ?? serverUnavailable('server_absent')
    const status = server.status()
    if (status.state !== 'ready' || !status.canMove) throw serverUnavailable('server_unsupported')
    const admin: ArtifactAdmin = await source.admin()
    return legacy.move(() => admin, ids)
  }

  legacyStop(): LegacyMoveState {
    return this.deps.legacy?.stopAfterCurrent() ?? this.legacyState()
  }

  /** Deletes artifacts on this computer (all, or the given ones); what is on the bot server does not change. */
  async legacyDelete(ids?: string[]): Promise<void> {
    await this.deps.legacy?.remove(ids)
  }

  /** Writes a consistent copy of the artifacts on this computer to `<targetDir>/artifacts.sqlite` for a data export. */
  async prepareExport(targetDir: string): Promise<boolean> {
    if (!this.deps.legacy?.exists()) return false
    await mkdir(targetDir, { recursive: true, mode: 0o700 })
    return this.deps.legacy.snapshot(path.join(targetDir, 'artifacts.sqlite'))
  }
}
