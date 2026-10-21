import { describe, expect, it } from 'vitest'
import {
  FLEET_FILE_LIMITS,
  FLEET_GATEWAY_ROUTES,
  FLEET_INSTANCE_ROUTES,
  fleetAttachmentInputSchema,
  fleetBotSchema,
  fleetFileOriginSchema,
  fleetFileQuotaBytes,
  fleetFileRefSchema,
  fleetFileSettingsSchema,
  fleetFilesDeleteRequestSchema,
  fleetInstanceInputSchema,
  fleetInstanceStatusSchema,
  fleetPublishedFileSchema,
  fleetSendMessageRequestSchema,
  fleetTranscriptItemSchema,
} from '../src/index.js'

const idempotencyKey = '11111111-1111-4111-8111-111111111111'
const pdf = {
  kind: 'pdf',
  name: 'report.pdf',
  mediaType: 'application/pdf',
  dataBase64: Buffer.from('%PDF-1.7').toString('base64'),
}
const text = {
  kind: 'text',
  name: 'notes.md',
  mediaType: 'text/plain',
  dataBase64: Buffer.from('São Paulo').toString('base64'),
}

describe('fleet file contracts', () => {
  it('accepts original PDF and UTF-8 text bytes without a message, and older image inputs', () => {
    expect(
      fleetSendMessageRequestSchema.parse({ idempotencyKey, text: '', attachments: [pdf, text] }).attachments
    ).toEqual([pdf, text])
    expect(
      fleetAttachmentInputSchema.parse({ name: 'image.png', mediaType: 'image/png', dataBase64: 'AA==' }).kind
    ).toBe('image')
    expect(fleetAttachmentInputSchema.parse({ ...text, dataBase64: '' }).dataBase64).toBe('')
  })

  it('rejects mismatched kinds, unsupported binaries and malformed base64', () => {
    for (const value of [
      { ...pdf, kind: 'image' },
      { ...text, mediaType: 'application/zip' },
      { ...pdf, dataBase64: '' },
      { ...pdf, dataBase64: 'abc' },
      { ...pdf, dataBase64: '!!!!' },
    ])
      expect(fleetAttachmentInputSchema.safeParse(value).success).toBe(false)
  })

  it('bounds individual documents, PDF count, and total bytes', () => {
    expect(
      fleetAttachmentInputSchema.safeParse({
        ...text,
        dataBase64: Buffer.alloc(FLEET_FILE_LIMITS.textMaxBytes + 1).toString('base64'),
      }).success
    ).toBe(false)
    expect(
      fleetAttachmentInputSchema.safeParse({
        ...pdf,
        dataBase64: Buffer.alloc(FLEET_FILE_LIMITS.pdfMaxBytes + 1).toString('base64'),
      }).success
    ).toBe(false)
    expect(
      fleetSendMessageRequestSchema.safeParse({ idempotencyKey, text: '', attachments: Array(5).fill(pdf) }).success
    ).toBe(false)
    const large = { ...pdf, dataBase64: Buffer.alloc(FLEET_FILE_LIMITS.pdfMaxBytes).toString('base64') }
    expect(
      fleetSendMessageRequestSchema.safeParse({ idempotencyKey, text: '', attachments: [large, large, text] }).success
    ).toBe(false)
  })

  it('only allows owner messages to carry documents', () => {
    expect(
      fleetInstanceInputSchema.safeParse({ idempotencyKey, source: 'owner', text: '', attachments: [pdf] }).success
    ).toBe(true)
    expect(
      fleetInstanceInputSchema.safeParse({
        idempotencyKey,
        source: 'continuation',
        text: 'Continue',
        attachments: [pdf],
      }).success
    ).toBe(false)
  })

  it('keeps old transcripts valid and exposes bounded opaque file references', () => {
    const item = {
      kind: 'tool',
      id: 'm:0',
      at: '2026-10-01T12:00:00Z',
      name: 'bot_share_file',
      target: 'report.pdf',
      state: 'done',
      output: null,
    }
    expect(fleetTranscriptItemSchema.parse(item)).not.toHaveProperty('files')
    const file = { id: 'f-synthetic', name: 'Relatório.pdf', mediaType: 'application/pdf', byteSize: 0 }
    expect(fleetTranscriptItemSchema.parse({ ...item, files: [file] })).toMatchObject({ files: [file] })
    for (const patch of [
      { id: '../secret' },
      { name: 'broken\uD800.txt' },
      { mediaType: 'text/plain\r\nX-Test: yes' },
      { byteSize: FLEET_FILE_LIMITS.downloadMaxBytes + 1 },
    ]) {
      expect(fleetFileRefSchema.safeParse({ ...file, ...patch }).success).toBe(false)
    }
  })
})

describe('managed bot files', () => {
  const file = {
    id: 'f-1',
    name: 'clip.mp4',
    mediaType: 'video/mp4',
    byteSize: 10,
    sharedAt: '2026-10-20T10:00:00.000Z',
  }
  it('accepts every origin and rejects unknown ones', () => {
    for (const origin of [
      { kind: 'primary' },
      { kind: 'routine', runId: 'run-1', title: 'Daily report' },
      { kind: 'thread', threadId: 'thread-1', title: 'Research' },
      { kind: 'unknown' },
    ])
      expect(fleetPublishedFileSchema.safeParse({ ...file, origin, originGone: false }).success).toBe(true)
    expect(fleetPublishedFileSchema.safeParse({ ...file, origin: { kind: 'disk' }, originGone: false }).success).toBe(
      false
    )
    expect(fleetFileOriginSchema.safeParse({ kind: 'primary', runId: 'x' }).success).toBe(false)
  })
  it('bounds the space and the deletions', () => {
    expect(fleetFileSettingsSchema.safeParse({ quotaGb: 20, deleteWithConversations: true }).success).toBe(true)
    expect(fleetFileSettingsSchema.safeParse({ quotaGb: 0, deleteWithConversations: true }).success).toBe(false)
    expect(fleetFileSettingsSchema.safeParse({ quotaGb: 21, deleteWithConversations: true }).success).toBe(false)
    expect(fleetFileSettingsSchema.safeParse({ quotaGb: 1.5, deleteWithConversations: true }).success).toBe(false)
    expect(fleetFilesDeleteRequestSchema.safeParse({ ids: [] }).success).toBe(false)
    expect(fleetFilesDeleteRequestSchema.safeParse({ ids: ['../x'] }).success).toBe(false)
    expect(
      fleetFilesDeleteRequestSchema.safeParse({ ids: Array.from({ length: 201 }, (_, i) => `f-${i}`) }).success
    ).toBe(false)
    expect(fleetFileQuotaBytes(2)).toBe(2 * 1024 ** 3)
  })
  it('keeps statuses and bots from older readers valid', () => {
    expect(fleetBotSchema.shape.sharedFiles.parse(undefined)).toBeNull()
    expect(fleetInstanceStatusSchema.shape.sharedFiles.parse(undefined)).toBeNull()
  })
  it('pairs the gateway and instance routes', () => {
    expect(FLEET_GATEWAY_ROUTES.botFilesList).toMatchObject({ method: 'GET', path: '/v1/bots/:id/files' })
    expect(FLEET_GATEWAY_ROUTES.botFilesDelete).toMatchObject({ method: 'POST', path: '/v1/bots/:id/files/delete' })
    expect(FLEET_GATEWAY_ROUTES.botFileSettings).toMatchObject({ method: 'PUT', path: '/v1/bots/:id/file-settings' })
    expect(FLEET_INSTANCE_ROUTES.botFilesList).toMatchObject({ method: 'GET', path: '/v1/bots/:botId/files' })
    expect(FLEET_INSTANCE_ROUTES.botFilesDelete).toMatchObject({
      method: 'POST',
      path: '/v1/bots/:botId/files/delete',
    })
    expect(FLEET_INSTANCE_ROUTES.botFileSettings).toMatchObject({
      method: 'PUT',
      path: '/v1/bots/:botId/file-settings',
    })
  })
})
