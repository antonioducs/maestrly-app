import { createHash } from 'node:crypto'
import type { BotInventory, BotSelection } from '@maestrly/protocol'
import { getWorkspace } from '../store'
import { listBranches } from '../git-service'
import {
  BOT_PERMISSION_CEILINGS,
  DEFAULT_BOT_PERMISSION_CEILING,
  botPermissionRank,
  type BotPermissionCeiling,
} from '../../shared/bot'

export interface BotLocalSelection {
  selectionId: string
  providerId: string
  modelId: string
  providerLabel: string
  reasoningEfforts: string[]
  fastMode: boolean
}

/** A resolved turn: the account and model it runs with, and how far it may go before it asks. */
export interface BotResolvedSelection extends BotLocalSelection {
  permissionMode: BotPermissionCeiling
}

export class BotModelCatalog {
  constructor(
    private readonly providerIds: string[],
    private readonly allowedSelections?: Array<{ providerId: string; modelId: string }>,
    /** Chosen by the person for this connection; a bot may ask for any mode up to it and none past it. */
    private readonly permissionCeiling: BotPermissionCeiling = DEFAULT_BOT_PERMISSION_CEILING
  ) {}

  /** Exactly the modes this connection was allowed, in the order the person reads them. */
  private permissionModes(): BotPermissionCeiling[] {
    return BOT_PERMISSION_CEILINGS.filter(
      (mode) => botPermissionRank(mode) <= botPermissionRank(this.permissionCeiling)
    )
  }

  async selections(): Promise<BotLocalSelection[]> {
    const { listChatRunnerCapabilities } = await import('../chat/service')
    return (await listChatRunnerCapabilities(true))
      .filter((model) => this.providerIds.includes(model.providerId))
      .filter(
        (model) =>
          !this.allowedSelections ||
          this.allowedSelections.some(
            (allowed) => allowed.providerId === model.providerId && allowed.modelId === model.modelId
          )
      )
      .map((model) => ({
        ...model,
        selectionId: createHash('sha256').update(`${model.providerId}\0${model.modelId}`).digest('hex'),
      }))
  }

  async resolve(selection: BotSelection): Promise<BotResolvedSelection> {
    const model = (await this.selections()).find((candidate) => candidate.selectionId === selection.selectionId)
    if (!model) throw new Error('The authorized bot account or model is unavailable.')
    if (selection.reasoning && !model.reasoningEfforts.includes(selection.reasoning))
      throw new Error('The selected reasoning effort is unavailable for this model.')
    if (selection.fastMode && !model.fastMode) throw new Error('Fast mode is unavailable for this model.')
    // A bot can never promote itself past the ceiling the person chose for this connection.
    if (
      selection.permissionMode &&
      botPermissionRank(selection.permissionMode) > botPermissionRank(this.permissionCeiling)
    )
      throw new Error('This bot connection requires owner approval for protected operations.')
    // Asking for nothing means the connection's own ceiling: what the person already allowed applies.
    return { ...model, permissionMode: selection.permissionMode ?? this.permissionCeiling }
  }

  async inventory(workspaceIds: string[]): Promise<BotInventory> {
    const workspaces: BotInventory['workspaces'] = []
    for (const workspaceId of workspaceIds) {
      const workspace = getWorkspace(workspaceId)
      if (!workspace) continue
      try {
        const branches = await listBranches(workspace.path)
        if (!branches.local.length && !branches.remoteRefs.length) continue
        workspaces.push({
          workspaceId,
          label: workspace.name.slice(0, 160),
          defaultBranch: workspace.defaultBranch,
          branches: [...new Set([...branches.local, ...branches.remoteRefs.map((branch) => branch.ref)])].slice(0, 500),
        })
      } catch {
        // An unavailable repository is not advertised or substituted with another checkout.
      }
    }
    const selections = (await this.selections()).map((model) => ({
      selectionId: model.selectionId,
      label: model.modelId.slice(0, 200),
      providerLabel: model.providerLabel.slice(0, 200),
      reasoningEfforts: model.reasoningEfforts,
      fastMode: model.fastMode,
      modes: ['agent', 'ask', 'plan'] as Array<'agent' | 'ask' | 'plan'>,
      permissionModes: this.permissionModes(),
    }))
    return { capability: 'bot:conversations:v1', enabled: true, workspaces, selections }
  }
}
