import type { GenUiWidgetIssueKind } from '@maestrly/bot-fleet-protocol'

export type InterfaceViewProps = {
  html: string
  /** What a screen reader calls the interface. */
  label: string
  /** The block asked to send a message as the person (`maestrly.send`). */
  onSend: (text: string) => void
  /** The block asked to open a web page (`maestrly.openLink`, or a link it shows). */
  onOpen: (url: string) => void
  /** Something the bridge found wrong in the block. */
  onIssue: (kind: GenUiWidgetIssueKind, detail: string) => void
}
