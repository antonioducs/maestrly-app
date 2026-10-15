import { isRemoteHostId, parseHostKey } from '../shared/host-key'
import type { RemoteConversationLabel } from '../shared/hosts'

/**
 * The names of remote hosts' conversations, which this computer does not store: the window lists them and reports
 * them here, so a floating window of such a conversation is named as one of this computer's is.
 */

type Label = Omit<RemoteConversationLabel, 'id'>

const MAX_LABELS = 20_000
const MAX_TEXT = 300

let labels = new Map<string, Label>()

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value.slice(0, MAX_TEXT) : undefined

function parse(value: unknown): Map<string, Label> | null {
  if (!Array.isArray(value) || value.length > MAX_LABELS) return null
  const out = new Map<string, Label>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { id, name, projectName } = item as Partial<Record<keyof RemoteConversationLabel, unknown>>
    if (typeof id !== 'string' || !isRemoteHostId(parseHostKey(id).hostId)) continue
    const label: Label = { name: text(name) ?? '' }
    const project = text(projectName)
    if (project) label.projectName = project
    out.set(id, label)
  }
  return out
}

/** The name and project of a remote host's conversation (its host key), or null when the window has not listed it. */
export function remoteConversationLabel(key: string): Label | null {
  return labels.get(key) ?? null
}

/** Replaces the labels with the window's whole list; returns the conversations whose name or project changed. */
export function setRemoteConversationLabels(value: unknown): string[] {
  const next = parse(value)
  if (!next) return []
  const changed: string[] = []
  for (const [key, label] of next) {
    const previous = labels.get(key)
    if (previous?.name !== label.name || previous?.projectName !== label.projectName) changed.push(key)
  }
  for (const key of labels.keys()) if (!next.has(key)) changed.push(key)
  labels = next
  return changed
}
