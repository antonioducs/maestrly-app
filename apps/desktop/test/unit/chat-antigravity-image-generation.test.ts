import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityAccountChangedError } from '../../src/main/chat/antigravity-subscription/errors'
import {
  ANTIGRAVITY_IMAGE_SESSION_META,
  generateImageWithAntigravityRuntime,
  parseAntigravityImageToolUpdate,
  pickAntigravityImageModel,
} from '../../src/main/chat/antigravity-subscription/image-generation'
import type { AntigravitySubscriptionManager } from '../../src/main/chat/antigravity-subscription/manager'
import { parseAntigravityModelOptions } from '../../src/main/chat/antigravity-subscription/models'
import { antigravityAcpHome } from '../../src/main/chat/antigravity-subscription/paths'
import { readGeneratedImage } from '../../src/main/chat/generated-images'
import { createFakeAntigravity, type FakeAntigravity } from '../helpers/antigravity-fake'

// The generated-image store writes under userData; this suite keeps its artifacts in a root of its own.
const artifactsUserData = mkdtempSync(path.join(os.tmpdir(), 'maestrly-agy-image-'))
const appGetPathSpy = vi.spyOn(app, 'getPath').mockReturnValue(artifactsUserData)

let fake: FakeAntigravity
let manager: AntigravitySubscriptionManager

beforeEach(async () => {
  fake = createFakeAntigravity()
  manager = fake.manager()
  await manager.login()
})
afterEach(async () => {
  await fake.cleanup()
  rmSync(path.join(artifactsUserData, 'chat-generated-images'), { recursive: true, force: true })
})
afterAll(() => {
  appGetPathSpy.mockRestore()
  rmSync(artifactsUserData, { recursive: true, force: true })
})

function generate(prompt: string, overrides: Partial<Parameters<typeof generateImageWithAntigravityRuntime>[0]> = {}) {
  return generateImageWithAntigravityRuntime({
    manager,
    accountIdentity: manager.getAccountIdentity(),
    conversationId: 'conv_agy_image',
    prompt,
    signal: new AbortController().signal,
    ...overrides,
  })
}

/** Answers the client sent to the agent's `session/request_permission` requests, in order. */
function permissionAnswers(): unknown[] {
  return fake
    .log()
    .filter((entry) => typeof entry.id === 'string' && String(entry.id).startsWith('agent-') && 'result' in entry)
    .map((entry) => (entry.result as { outcome?: unknown }).outcome)
}

/** The log holds only what the agent received, so the session id comes from the prompt it was sent. */
function promptedSessionId(): string {
  const params = fake.requests('session/prompt').at(-1)?.params as { sessionId?: string } | undefined
  return params?.sessionId ?? ''
}

describe('Antigravity image generation', () => {
  it('draws in a session that enables only generate_image and stores the image as an artifact', async () => {
    const started = Date.now()
    const image = await generate('IMAGE a teal robot')

    expect(image).toMatchObject({ mediaType: 'image/png', name: 'teal_robot.png', byteSize: 70 })
    // The fake model rewrites the request it forwards, as Gemini does.
    expect(image.revisedPrompt).toBe('a teal robot, flat illustration')
    await expect(readGeneratedImage('conv_agy_image', image.artifactId)).resolves.toMatchObject({
      ok: true,
      mediaType: 'image/png',
    })
    expect(fake.requests('session/new').at(-1)?.params).toMatchObject({
      mcpServers: [],
      _meta: ANTIGRAVITY_IMAGE_SESSION_META,
    })
    // Gemini Flash at its lowest level forwards the request; the image model is the server's own.
    expect(fake.requests('session/set_config_option').at(-1)?.params).toMatchObject({ value: 'gemini-3.8-flash-low' })
    expect(permissionAnswers()).toEqual([{ outcome: 'selected', optionId: 'allow' }])
    // The model's closing remark is cut short instead of waited for.
    await expect.poll(() => fake.requests('session/cancel').length).toBe(1)
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  it('removes the session files, the server copy of the image included', async () => {
    await generate('IMAGE a teal robot')
    const id = promptedSessionId()
    await expect.poll(() => fake.requests('session/delete').length).toBe(1)
    await expect.poll(() => existsSync(path.join(antigravityAcpHome(manager.root), 'brain', id))).toBe(false)
  })

  it('reads the image from the session directory when the server reports only its path', async () => {
    const image = await generate('IMAGEPATH a teal robot')
    await expect(readGeneratedImage('conv_agy_image', image.artifactId)).resolves.toMatchObject({ ok: true })
  })

  it('approves one image per session and rejects a second call', async () => {
    const image = await generate('IMAGE2 two robots')
    expect(image.mediaType).toBe('image/png')
    await expect.poll(() => permissionAnswers().length).toBe(2)
    expect(permissionAnswers()).toEqual([
      { outcome: 'selected', optionId: 'allow' },
      { outcome: 'selected', optionId: 'deny' },
    ])
    expect(readdirSync(path.join(artifactsUserData, 'chat-generated-images', 'conv_agy_image'))).toHaveLength(1)
  })

  it('reports what the model said when it produced no image', async () => {
    await expect(generate('ECHO I will not draw that')).rejects.toThrow(
      'Google AI did not generate an image. It answered: I will not draw that'
    )
  })

  it('cancels the turn and stores nothing when aborted', async () => {
    const controller = new AbortController()
    const pending = generate('SLOW', { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('stop')
    try {
      await vi.waitFor(() => expect(fake.requests('session/prompt')).toHaveLength(1))
    } finally {
      controller.abort(new Error('stop'))
      await rejected
    }
    await expect.poll(() => fake.requests('session/cancel').length).toBe(1)
    expect(existsSync(path.join(artifactsUserData, 'chat-generated-images', 'conv_agy_image'))).toBe(false)
  })

  it('refuses to draw for another account identity', async () => {
    await expect(generate('IMAGE x', { accountIdentity: { fingerprint: 'project:other', epoch: 1 } })).rejects.toThrow(
      new AntigravityAccountChangedError().message
    )
    expect(fake.requests('session/new')).toHaveLength(0)
  })
})

describe('Antigravity image tool updates', () => {
  it('reads the inline image, path, final prompt and name of a completed call', () => {
    expect(
      parseAntigravityImageToolUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' } }],
        rawOutput: { imageName: 'apple', imagePath: '/x/apple.jpg', prompt: 'A red apple', aspectRatio: '1:1' },
      })
    ).toEqual({
      status: 'completed',
      data: 'AAAA',
      mimeType: 'image/jpeg',
      imagePath: '/x/apple.jpg',
      revisedPrompt: 'A red apple',
      imageName: 'apple',
    })
  })

  it('reads the text of a failed call and ignores calls still running', () => {
    expect(
      parseAntigravityImageToolUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'RESOURCE_EXHAUSTED' } }],
      })
    ).toEqual({ status: 'failed', error: 'RESOURCE_EXHAUSTED' })
    expect(
      parseAntigravityImageToolUpdate({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'pending' })
    ).toBeNull()
    expect(
      parseAntigravityImageToolUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text' } })
    ).toBeNull()
  })
})

describe('Antigravity image model choice', () => {
  const entries = parseAntigravityModelOptions([
    { value: 'gemini-pro-agent', name: 'Gemini 3.1 Pro (High)' },
    { value: 'gemini-flash-lite', name: 'Gemini 3 Flash Lite' },
    { value: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { value: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
    { value: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
  ])

  it('prefers a full Flash model at its lowest level', () => {
    expect(pickAntigravityImageModel(entries)).toEqual({ modelId: 'gemini-3.8-flash', effort: 'low' })
  })

  it('falls back to any chat model, and to nothing for an empty catalog', () => {
    expect(pickAntigravityImageModel(entries.filter((entry) => !/flash/i.test(entry.id)))).toEqual({
      modelId: 'gemini-3.1-pro',
      effort: 'low',
    })
    expect(pickAntigravityImageModel([])).toBeNull()
  })
})
