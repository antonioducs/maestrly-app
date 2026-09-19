export function filterStandaloneConversations<T extends { name: string }>(conversations: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  return q ? conversations.filter((conversation) => conversation.name.toLowerCase().includes(q)) : conversations
}
