import { useCallback, useEffect, useState } from 'react'
import { expandPrompt, type BotPrompt } from '@maestrly/host-protocol'
import type { ComposerCommand } from '@maestrly/chat-ui'

/** `/name rest` → the command name and everything after it; null when the text is not a command. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]{0,63})(?:\s+([\s\S]*))?$/.exec(text.trim())
  return match ? { name: match[1], args: match[2] ?? '' } : null
}

/** What actually goes to the bot: the template with `$ARGUMENTS` filled, or the text as typed. */
export function expandMessage(text: string, prompts: BotPrompt[]): string {
  const command = parseCommand(text)
  if (!command) return text
  // A bot's own command shadows a Host command of the same name.
  const prompt = prompts.find((p) => p.name === command.name && p.scope === 'bot') ?? prompts.find((p) => p.name === command.name)
  return prompt ? expandPrompt(prompt.template, command.args) : text
}

export function usePrompts(botId: string, connected: boolean, supported: boolean) {
  const [prompts, setPrompts] = useState<BotPrompt[]>([])
  const reload = useCallback(async () => {
    if (!connected || !supported) return
    const page = await window.bot.prompt({ method: 'prompt.list', params: { botId } })
    setPrompts(page.prompts)
  }, [botId, connected, supported])
  useEffect(() => {
    void reload().catch(() => setPrompts([]))
  }, [reload])
  const commands: ComposerCommand[] = prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description || undefined,
    kind: prompt.scope === 'host' ? 'host' : 'bot',
  }))
  return { prompts, commands, reload }
}
