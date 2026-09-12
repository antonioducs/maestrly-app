function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function convAccentColor(convId: string): string {
  return `hsl(${fnv1a(convId) % 360} 72% 62%)`
}
