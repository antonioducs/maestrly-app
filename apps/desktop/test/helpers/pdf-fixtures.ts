/**
 * Minimal, synthetic PDF documents generated in-process for tests (no external or private documents).
 * Pages use the standard Helvetica font, so pdf.js extracts their text without font data.
 */

const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`)

function buildPdf(objects: string[], trailerExtra = ''): Buffer {
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function textPdfObjects(pages: string[]): string[] {
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  pages.forEach((text, i) => {
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${esc(text)}) Tj ET` : ''
    // PDF.js drops text outside the page box, so widen the page for long single-line fixtures.
    const width = Math.max(612, 144 + text.length * 8)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
    )
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  })
  return objects
}

/** One page per entry; an empty string produces a page without a text layer. */
export const makeTextPdf = (pages: string[]): Buffer => buildPdf(textPdfObjects(pages))

/** Standard security handler (RC4 40-bit) with a user password, so pdf.js cannot open it without one. */
export function makeEncryptedPdf(): Buffer {
  const objects = textPdfObjects(['secret'])
  objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'11'.repeat(32)}> /U <${'22'.repeat(32)}> /P -4 >>`)
  const id = `<${'33'.repeat(16)}>`
  return buildPdf(objects, ` /Encrypt ${objects.length} 0 R /ID [${id} ${id}]`)
}
