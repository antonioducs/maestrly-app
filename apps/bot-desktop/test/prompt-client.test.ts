import { describe, expect, it } from 'vitest'
import { validatePromptCall, PromptClient } from '../src/main/prompt-client'
import { expandMessage, parseCommand } from '../src/renderer/features/prompts/usePrompts'
import type { BotPrompt } from '@maestrly/host-protocol'

const stamp = new Date().toISOString()
const prompt = (name: string, template: string, scope: 'host' | 'bot' = 'host'): BotPrompt => ({ id: `${scope}-${name}`, scope, ...(scope === 'bot' ? { botId: 'bot-1' } : {}), name, description: '', template, revision: 0, createdAt: stamp, updatedAt: stamp })

describe('stored commands in the composer', () => {
  it('expands $ARGUMENTS with what follows the command, and leaves plain text alone', () => {
    const prompts = [prompt('revise', 'Revise $ARGUMENTS com cuidado')]
    expect(expandMessage('/revise a.ts', prompts)).toBe('Revise a.ts com cuidado')
    // No arguments: the placeholder becomes empty, nothing is invented in its place.
    expect(expandMessage('/revise', prompts)).toBe('Revise  com cuidado')
    expect(expandMessage('só um texto /revise', prompts)).toBe('só um texto /revise')
    expect(expandMessage('/desconhecido x', prompts)).toBe('/desconhecido x')
    expect(parseCommand('/resumo  hoje e amanhã')).toEqual({ name: 'resumo', args: 'hoje e amanhã' })
  })
  it("prefers the bot's own command over a Host command with the same name", () => {
    const prompts = [prompt('resumo', 'Host: $ARGUMENTS'), prompt('resumo', 'Bot: $ARGUMENTS', 'bot')]
    expect(expandMessage('/resumo x', prompts)).toBe('Bot: x')
  })
})

describe('prompt client', () => {
  it('refuses methods outside the prompt namespace and malformed params before the wire', () => {
    expect(() => validatePromptCall({ method: 'bot.archive', params: {} })).toThrow(/Invalid prompt request/)
    expect(() => validatePromptCall({ method: 'prompt.upsert', params: { scope: 'host', name: 'Bad Name', template: 'x' } })).toThrow()
    expect(validatePromptCall({ method: 'prompt.list', params: {} })).toEqual({ method: 'prompt.list', params: {} })
  })
  it('validates the Host reply and requires a connection', async () => {
    const seen: string[] = []
    const client = new PromptClient(async (method) => {
      seen.push(method)
      return { prompts: [] }
    })
    await expect(client.call({ method: 'prompt.list', params: {} })).rejects.toThrow(/Conecte-se/)
    client.connected('host-1')
    expect(await client.call({ method: 'prompt.list', params: {} })).toEqual({ prompts: [] })
    expect(seen).toEqual(['prompt.list'])
    const broken = new PromptClient(async () => ({ nope: true }))
    broken.connected('host-1')
    await expect(broken.call({ method: 'prompt.list', params: {} })).rejects.toThrow()
  })
})
