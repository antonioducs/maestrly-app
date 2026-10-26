import { describe, expect, it } from 'vitest'
import { fileStem, responsesToCsv, responsesToJson } from '../../src/main/artifacts/responses-export'
import type { ArtifactResponseView } from '../../src/shared/artifacts'

const SENT = Date.UTC(2026, 9, 26, 12, 0, 0)

const response = (
  id: string,
  data: Record<string, unknown>,
  author: ArtifactResponseView['author'] = { kind: 'invited', name: 'Maria', verified: true }
): ArtifactResponseView => ({ id, version: 2, author, data, createdAt: SENT, updatedAt: SENT + 60_000 })

const BOM = '\uFEFF'

describe('responsesToCsv', () => {
  it('writes the fixed columns, then every field of the data in the order first seen', () => {
    const csv = responsesToCsv([
      response('a', { answer: 'yes', score: 4 }),
      response('b', { answer: 'no', extra: { a: 1 } }, { kind: 'guest', name: 'Paula', verified: false }),
    ])
    expect(csv.startsWith(BOM)).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.slice(1).split('\r\n')).toEqual([
      '"name","kind","verified","version","sent_at","updated_at","answer","score","extra"',
      '"Maria","invited","true","2","2026-10-26T12:00:00.000Z","2026-10-26T12:01:00.000Z","yes","4",""',
      '"Paula","guest","false","2","2026-10-26T12:00:00.000Z","2026-10-26T12:01:00.000Z","no","","{""a"":1}"',
      '',
    ])
  })

  it('keeps a spreadsheet from running what visitors typed as a formula', () => {
    const csv = responsesToCsv([
      response('a', { link: '=HYPERLINK("x")', plus: '+1', minus: '-1', at: '@cmd', tab: '\tx', fine: 'a=b' }),
    ])
    const row = csv.slice(1).split('\r\n')[1]!
    expect(row).toContain(`"'=HYPERLINK(""x"")"`)
    expect(row).toContain(`"'+1"`)
    expect(row).toContain(`"'-1"`)
    expect(row).toContain(`"'@cmd"`)
    expect(row).toContain(`"'\tx"`)
    expect(row).toContain(`"a=b"`)
  })

  it('leaves empty values empty and takes any field name, `__proto__` included', () => {
    const data = JSON.parse('{"__proto__": "kept", "none": null, "yes": true}') as Record<string, unknown>
    const [header, row] = responsesToCsv([response('a', data)])
      .slice(1)
      .split('\r\n')
    expect(header).toBe('"name","kind","verified","version","sent_at","updated_at","__proto__","none","yes"')
    expect(row?.endsWith('"kept","","true"')).toBe(true)
  })

  it('writes only the header without responses', () => {
    expect(responsesToCsv([])).toBe(`${BOM}"name","kind","verified","version","sent_at","updated_at"\r\n`)
  })
})

describe('responsesToJson', () => {
  it('keeps the responses as they are, with the artifact and when they were exported', () => {
    const responses = [response('a', { answer: 'yes', nested: { list: [1, 2] } })]
    expect(JSON.parse(responsesToJson({ id: 'A', title: 'Form' }, responses, SENT))).toEqual({
      artifact: { id: 'A', title: 'Form' },
      exportedAt: '2026-10-26T12:00:00.000Z',
      responses,
    })
  })
})

describe('fileStem', () => {
  it('makes a file name from the title', () => {
    expect(fileStem('Formulário da PO!')).toBe('formulario-da-po')
    expect(fileStem('  Q3   report / draft  ')).toBe('q3-report-draft')
    expect(fileStem('***')).toBe('artifact')
    expect(fileStem('x'.repeat(100))).toHaveLength(60)
  })
})
