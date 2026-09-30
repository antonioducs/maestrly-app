import { isArtifactId } from '@maestrly/artifact-host'
import { z } from 'zod'
import type { IpcRegistrar } from '../ipc-registrar'
import type { ArtifactsService } from './service'
import { artifactSettingsSchema } from './settings'

const artifactId = z.string().refine(isArtifactId, 'Invalid artifact ID')
const version = z.number().int().min(1).optional()
const conversationId = z.string().min(1).max(128)

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
}
