export type ChatWindowTarget = { kind: 'conversation' | 'bot'; id: string }
export type ChatWindowRequest = ChatWindowTarget & { title: string }

export function chatWindowKey(target: ChatWindowTarget): string {
  return `${target.kind}:${target.id}`
}
