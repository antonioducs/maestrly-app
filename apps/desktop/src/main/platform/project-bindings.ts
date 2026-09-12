import { randomUUID } from 'node:crypto'
import type { PlatformProjectBinding } from '../../shared/platform'
import { getAppSetting, setAppSetting } from '../store'

const KEY = 'platform.project-bindings.v1'

export class PlatformProjectBindings {
  list(): PlatformProjectBinding[] {
    try { return JSON.parse(getAppSetting(KEY) ?? '[]') as PlatformProjectBinding[] } catch { return [] }
  }
  forWorkspace(workspaceId: string): PlatformProjectBinding | null {
    return this.list().find((binding) => binding.workspaceId === workspaceId) ?? null
  }
  set(binding: PlatformProjectBinding): void {
    const previous = this.forWorkspace(binding.workspaceId)
    const sameScope = previous && ['connectionId', 'organizationId', 'projectId', 'boardId'].every(
      (key) => previous[key as keyof PlatformProjectBinding] === binding[key as keyof PlatformProjectBinding]
    )
    const revision = sameScope ? previous.revision : randomUUID()
    const next = this.list().filter((item) => item.workspaceId !== binding.workspaceId)
    next.push({ ...binding, revision })
    setAppSetting(KEY, JSON.stringify(next))
  }
  remove(workspaceId: string): void {
    setAppSetting(KEY, JSON.stringify(this.list().filter((item) => item.workspaceId !== workspaceId)))
  }
}

export const platformProjectBindings = new PlatformProjectBindings()
