/** Image formats Maestrly accepts as images, recognized by their bytes (never by a file name or a declared type). */
export const IMAGE_FORMATS_BY_MAGIC: ReadonlyArray<{ mime: string; ext: string; match: (buf: Buffer) => boolean }> = [
  {
    mime: 'image/png',
    ext: 'png',
    match: (b) =>
      b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    match: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { mime: 'image/gif', ext: 'gif', match: (b) => b.length >= 6 && b.subarray(0, 3).toString('latin1') === 'GIF' },
]

export function sniffImageFormat(buffer: Buffer): { mime: string; ext: string } | null {
  return IMAGE_FORMATS_BY_MAGIC.find((candidate) => candidate.match(buffer)) ?? null
}
