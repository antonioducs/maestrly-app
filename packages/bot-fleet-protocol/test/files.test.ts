import { describe, expect, it } from 'vitest'
import {
  FLEET_FILE_LIMITS,
  fleetAttachmentInputSchema,
  fleetFileRefSchema,
  fleetInstanceInputSchema,
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
