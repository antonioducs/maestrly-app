/** The user's message a @ToAssistant step sends: its text, then any context it carries, visible to the person. */
export function genUiMessage(message: string, context?: unknown): string {
  const text = message.trim()
  if (context === undefined || context === null || context === '') return text
  let data: string
  if (typeof context === 'string') data = context
  else {
    try {
      data = `\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``
    } catch {
      return text
    }
  }
  return text ? `${text}\n\n${data}` : data
}
