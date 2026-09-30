import { isArtifactId } from '@maestrly/artifact-host'
import { z } from 'zod'
import {
  MAX_ACCESS_CODE_CHARS,
  MAX_ARTIFACT_COMMENT_CHARS,
  MAX_ARTIFACT_NAME_CHARS,
  MIN_ACCESS_CODE_CHARS,
} from '../../shared/artifacts'
import type { IpcRegistrar } from '../ipc-registrar'
import type { ArtifactsService } from './service'
import { artifactSettingsSchema } from './settings'

const artifactId = z.string().refine(isArtifactId, 'Invalid artifact ID')
const version = z.number().int().min(1).optional()
const conversationId = z.string().min(1).max(128)
/** People, devices and access requests use the host's random IDs, which look like artifact IDs. */
const recordId = z.string().refine(isArtifactId, 'Invalid ID')
const personName = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ARTIFACT_NAME_CHARS)
  .regex(/^\P{Cc}*$/u, 'Use a single line of text')
const sharingPatch = z
  .object({
    visibility: z.enum(['private', 'people', 'link']).optional(),
    linkExpiresAt: z.number().int().positive().nullable().optional(),
    accessCode: z.string().min(MIN_ACCESS_CODE_CHARS).max(MAX_ACCESS_CODE_CHARS).nullable().optional(),
    commentsEnabled: z.boolean().optional(),
  })
  .strict()
const requestDecision = z.object({ approve: z.boolean(), name: personName.optional() }).strict()
const commentBody = z.string().trim().min(1).max(MAX_ARTIFACT_COMMENT_CHARS)

/** Owner actions from the renderer. Every channel is guarded and validates its input before the service sees it. */
export function registerArtifactsIpc(reg: IpcRegistrar, deps: { service: () => ArtifactsService }): void {
  const service = deps.service
  reg.mhandle('artifacts:list', async () => service().listAll())
  reg.mhandle('artifacts:detail', async (_e, id: unknown) => service().detail(artifactId.parse(id)))
  reg.mhandle('artifacts:delete', async (_e, id: unknown) => service().remove(artifactId.parse(id)))
  reg.mhandle('artifacts:thumbnail', async (_e, id: unknown, number: unknown) =>
    service().thumbnail(artifactId.parse(id), version.parse(number))
  )
  reg.mhandle('artifacts:open-external', async (_e, id: unknown, number: unknown) => {
    await service().openExternal(artifactId.parse(id), version.parse(number))
  })
  // The owner may open any artifact in any conversation's browser; only agents are limited to their scope.
  reg.mhandle('artifacts:open-in-conversation', async (_e, convId: unknown, id: unknown, number: unknown) => {
    await service().openInConversation(conversationId.parse(convId), artifactId.parse(id), version.parse(number), {
      checkScope: false,
      activate: true,
    })
  })
  reg.mhandle('artifacts:status', async () => service().status())
  reg.mhandle('artifacts:start', async () => service().start())
  reg.mhandle('artifacts:settings-get', async () => service().getSettings())
  reg.mhandle('artifacts:settings-set', async (_e, settings: unknown) =>
    service().setSettings(artifactSettingsSchema.parse(settings))
  )

  // Sharing: the owner's controls. There is no agent tool for any of these.
  reg.mhandle('artifacts:sharing-get', async (_e, id: unknown) => service().sharing(artifactId.parse(id)))
  reg.mhandle('artifacts:sharing-set', async (_e, id: unknown, patch: unknown) =>
    service().setSharing(artifactId.parse(id), sharingPatch.parse(patch))
  )
  reg.mhandle('artifacts:invite-create', async (_e, id: unknown, name: unknown) =>
    service().createInvite(artifactId.parse(id), personName.parse(name))
  )
  reg.mhandle('artifacts:invite-link', async (_e, id: unknown, principalId: unknown) =>
    service().inviteLink(artifactId.parse(id), recordId.parse(principalId))
  )
  reg.mhandle('artifacts:invite-reset', async (_e, id: unknown, principalId: unknown) =>
    service().resetInvite(artifactId.parse(id), recordId.parse(principalId))
  )
  reg.mhandle('artifacts:person-revoke', async (_e, id: unknown, principalId: unknown) => {
    await service().revokePerson(artifactId.parse(id), recordId.parse(principalId))
  })
  reg.mhandle('artifacts:device-revoke', async (_e, id: unknown, sessionId: unknown) => {
    await service().revokeDevice(artifactId.parse(id), recordId.parse(sessionId))
  })
  reg.mhandle('artifacts:sessions-revoke', async (_e, id: unknown) => {
    await service().revokeAllSessions(artifactId.parse(id))
  })
  reg.mhandle('artifacts:request-decide', async (_e, id: unknown, requestId: unknown, decision: unknown) => {
    await service().decideRequest(artifactId.parse(id), recordId.parse(requestId), requestDecision.parse(decision))
  })
  reg.mhandle('artifacts:events', async (_e, id: unknown) => service().events(artifactId.optional().parse(id)))
  reg.mhandle('artifacts:events-seen', async (_e, id: unknown) => {
    await service().markSeen(artifactId.optional().parse(id))
  })
  reg.mhandle('artifacts:unseen-count', async () => service().unseenCount())

  // Comments: the owner reads and answers them in the app.
  reg.mhandle('artifacts:comments', async (_e, id: unknown) => service().comments(artifactId.parse(id)))
  reg.mhandle('artifacts:comment-add', async (_e, id: unknown, commentId: unknown, body: unknown) =>
    service().replyComment(artifactId.parse(id), recordId.parse(commentId), commentBody.parse(body))
  )
  reg.mhandle('artifacts:comment-resolve', async (_e, id: unknown, commentId: unknown, resolved: unknown) => {
    await service().resolveComment(artifactId.parse(id), recordId.parse(commentId), z.boolean().parse(resolved))
  })
  reg.mhandle('artifacts:comment-delete', async (_e, id: unknown, commentId: unknown) => {
    await service().deleteComment(artifactId.parse(id), recordId.parse(commentId))
  })
}
