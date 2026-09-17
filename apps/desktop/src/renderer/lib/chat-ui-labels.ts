/**
 * The copy the shared chat components need, read from the desktop catalogues. The shared package
 * never imports react-i18next: it receives plain strings, so the two applications can keep
 * different catalogues while rendering the same components.
 */
import type { ChatUiLabels } from '@maestrly/chat-ui'
import { i18n } from './i18n'

export function chatUiLabels(): ChatUiLabels {
  const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string
  return {
    copy: t('chat:messages.copy'),
    copied: t('chat:messages.copied'),
    responseDuration: (seconds) => t('chat:messages.responseTime', { duration: `${seconds}s` }),
    tool: {
      running: t('chat:tool.running'),
      done: t('chat:tool.completed'),
      error: t('chat:tool.error'),
      output: t('chat:tool.result'),
      command: t('chat:tool.arguments'),
      changes: t('ui:chatUi.changes'),
      pending: t('chat:tool.preparing'),
      awaitingPermission: t('chat:tool.awaitingPermission'),
      denied: t('chat:tool.denied'),
      imageOutput: t('chat:tool.imageOutput'),
      imageLoading: t('chat:tool.imageLoading'),
      imageUnavailable: t('chat:tool.imageUnavailable'),
    },
    context: {
      title: t('chat:meter.limitTitle'),
      used: (used, limit) => t('ui:chatUi.contextUsed', { used, limit }),
      cost: (cost) => t('ui:chatUi.contextCost', { cost }),
      unknownWindow: t('chat:meter.limitCeilingUnknown'),
    },
    composer: {
      placeholder: t('chat:composer.placeholder'),
      send: t('chat:composer.send'),
      stop: t('chat:composer.stop'),
      stopping: t('ui:chatUi.stopping'),
      attach: t('chat:plusMenu.imageFile'),
      commands: t('ui:chatUi.commands'),
      skills: t('chat:skillsMenu.button'),
      noCommands: t('ui:chatUi.noCommands'),
    },
    model: { title: t('chat:modelChip.choosePlaceholder'), effort: t('chat:reasoning.buttonTitle') },
    permission: {
      ask: t('chat:perm.askLabel'),
      full: t('chat:perm.fullLabel'),
      askHint: t('chat:perm.askDesc'),
      fullHint: t('chat:perm.fullDesc'),
    },
    usage: {
      title: t('ui:usage.heading'),
      period: t('ui:chatUi.period'),
      model: t('ui:usage.colModel'),
      input: t('ui:usage.colInput'),
      output: t('ui:usage.colOutput'),
      cached: t('ui:usage.colCacheRead'),
      turns: t('ui:usage.cardTurns'),
      cost: t('ui:usage.colCost'),
      empty: t('ui:usage.empty'),
      refresh: t('ui:usage.refresh'),
    },
    mermaid: {
      failed: t('ui:chatUi.invalidDiagram'),
      rendering: t('ui:notesEditor.renderingDiagram'),
      expand: t('ui:mermaid.expand'),
      zoomIn: t('ui:mermaid.zoomIn'),
      zoomOut: t('ui:mermaid.zoomOut'),
      reset: t('ui:mermaid.reset'),
      close: t('ui:mermaid.close'),
      dialog: t('ui:notesEditor.diagramMermaid'),
    },
  }
}
