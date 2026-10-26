import type { FleetArtifactHost, FleetArtifactSettingsPatch } from '@maestrly/bot-fleet-protocol'
import type { ArtifactServerStatus, ArtifactServerView } from '../shared/artifacts'
import type { FleetServerId } from '../shared/fleet-servers'
import { ipcRenderer } from 'electron'
import type {
  ArtifactActivity,
  ArtifactCommentView,
  ArtifactDetailView,
  ArtifactEventView,
  ArtifactListItem,
  ArtifactRemoveResult,
  ArtifactResponsesExportResult,
  ArtifactResponseView,
  ArtifactSharingPatch,
  ArtifactSharingView,
  ArtifactThumbnailView,
  LegacyArtifactView,
  LegacyMoveState,
} from '../shared/artifacts'

export const artifactsApi = {
  artifacts: {
    /** A paired server's artifact host; without one, the server conversations of this computer publish to. */
    serverStatus: (serverId?: FleetServerId): Promise<ArtifactServerStatus> =>
      ipcRenderer.invoke('artifacts:server-status', serverId),
    serverHost: (serverId?: FleetServerId): Promise<FleetArtifactHost | null> =>
      ipcRenderer.invoke('artifacts:server-host-get', serverId),
    setServerHost: (patch: FleetArtifactSettingsPatch, serverId?: FleetServerId): Promise<FleetArtifactHost> =>
      ipcRenderer.invoke('artifacts:server-host-set', patch, serverId),
    /** Every paired server's artifact host, and the one conversations of this computer publish to. */
    servers: (): Promise<ArtifactServerView[]> => ipcRenderer.invoke('artifacts:servers'),
    setPublishServer: (serverId: FleetServerId): Promise<ArtifactServerView[]> =>
      ipcRenderer.invoke('artifacts:publish-server-set', serverId),
    list: (): Promise<ArtifactListItem[]> => ipcRenderer.invoke('artifacts:list'),
    detail: (id: string): Promise<ArtifactDetailView | null> => ipcRenderer.invoke('artifacts:detail', id),
    remove: (id: string): Promise<ArtifactRemoveResult> => ipcRenderer.invoke('artifacts:delete', id),
    thumbnail: (id: string, version?: number): Promise<ArtifactThumbnailView | null> =>
      ipcRenderer.invoke('artifacts:thumbnail', id, version),
    openExternal: (id: string, version?: number): Promise<void> =>
      ipcRenderer.invoke('artifacts:open-external', id, version),
    openInConversation: (conversationId: string, id: string, version?: number): Promise<void> =>
      ipcRenderer.invoke('artifacts:open-in-conversation', conversationId, id, version),
    legacyList: (): Promise<LegacyArtifactView[]> => ipcRenderer.invoke('artifacts:legacy-list'),
    legacyState: (): Promise<LegacyMoveState> => ipcRenderer.invoke('artifacts:legacy-state'),
    legacyMove: (ids?: string[]): Promise<LegacyMoveState> => ipcRenderer.invoke('artifacts:legacy-move', ids),
    legacyStop: (): Promise<LegacyMoveState> => ipcRenderer.invoke('artifacts:legacy-stop'),
    legacyDelete: (ids?: string[]): Promise<void> => ipcRenderer.invoke('artifacts:legacy-delete', ids),
    sharing: (id: string): Promise<ArtifactSharingView> => ipcRenderer.invoke('artifacts:sharing-get', id),
    setSharing: (id: string, patch: ArtifactSharingPatch): Promise<ArtifactSharingView> =>
      ipcRenderer.invoke('artifacts:sharing-set', id, patch),
    createInvite: (id: string, name: string): Promise<{ principalId: string; link: string }> =>
      ipcRenderer.invoke('artifacts:invite-create', id, name),
    inviteLink: (id: string, principalId: string): Promise<string | null> =>
      ipcRenderer.invoke('artifacts:invite-link', id, principalId),
    resetInvite: (id: string, principalId: string): Promise<string> =>
      ipcRenderer.invoke('artifacts:invite-reset', id, principalId),
    revokePerson: (id: string, principalId: string): Promise<void> =>
      ipcRenderer.invoke('artifacts:person-revoke', id, principalId),
    revokeDevice: (id: string, sessionId: string): Promise<void> =>
      ipcRenderer.invoke('artifacts:device-revoke', id, sessionId),
    revokeAllSessions: (id: string): Promise<void> => ipcRenderer.invoke('artifacts:sessions-revoke', id),
    decideRequest: (id: string, requestId: string, decision: { approve: boolean; name?: string }): Promise<void> =>
      ipcRenderer.invoke('artifacts:request-decide', id, requestId, decision),
    events: (id?: string): Promise<ArtifactEventView[]> => ipcRenderer.invoke('artifacts:events', id),
    markSeen: (id?: string): Promise<void> => ipcRenderer.invoke('artifacts:events-seen', id),
    unseenCount: (): Promise<number> => ipcRenderer.invoke('artifacts:unseen-count'),
    comments: (id: string): Promise<ArtifactCommentView[]> => ipcRenderer.invoke('artifacts:comments', id),
    replyComment: (id: string, commentId: string, body: string): Promise<ArtifactCommentView> =>
      ipcRenderer.invoke('artifacts:comment-add', id, commentId, body),
    resolveComment: (id: string, commentId: string, resolved: boolean): Promise<void> =>
      ipcRenderer.invoke('artifacts:comment-resolve', id, commentId, resolved),
    deleteComment: (id: string, commentId: string): Promise<void> =>
      ipcRenderer.invoke('artifacts:comment-delete', id, commentId),
    responses: (id: string): Promise<ArtifactResponseView[]> => ipcRenderer.invoke('artifacts:responses', id),
    deleteResponse: (id: string, responseId: string): Promise<void> =>
      ipcRenderer.invoke('artifacts:response-delete', id, responseId),
    /** Asks where to save, then writes every response of the artifact as CSV or JSON. */
    exportResponses: (id: string, format: 'csv' | 'json'): Promise<ArtifactResponsesExportResult> =>
      ipcRenderer.invoke('artifacts:responses-export', id, format),
    onChanged: (cb: () => void): (() => void) => {
      const listener = () => cb()
      ipcRenderer.on('artifacts:changed', listener)
      return () => ipcRenderer.removeListener('artifacts:changed', listener)
    },
    onActivity: (cb: (activity: ArtifactActivity) => void): (() => void) => {
      const listener = (_e: unknown, activity: ArtifactActivity) => cb(activity)
      ipcRenderer.on('artifacts:activity', listener)
      return () => ipcRenderer.removeListener('artifacts:activity', listener)
    },
    onLegacyState: (cb: (state: LegacyMoveState) => void): (() => void) => {
      const listener = (_e: unknown, state: LegacyMoveState) => cb(state)
      ipcRenderer.on('artifacts:legacy-state', listener)
      return () => ipcRenderer.removeListener('artifacts:legacy-state', listener)
    },
  },
}
