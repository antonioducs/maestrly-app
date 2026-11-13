import { LINE_HEIGHT } from './elements.js'

/**
 * Text size without a canvas to measure it. Estimates err on the wide side, so a box sized from them holds its text;
 * the canvas measures again when it loads the board.
 */
const CHAR_WIDTH = 0.62

export function charWidth(fontSize: number): number {
  return fontSize * CHAR_WIDTH
}

/** Breaks text into lines no wider than `maxWidth`, at spaces where it can. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const perLine = Math.max(1, Math.floor(maxWidth / charWidth(fontSize)))
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      let rest = word
      while (rest.length > perLine) {
        if (line) lines.push(line)
        lines.push(rest.slice(0, perLine))
        line = ''
        rest = rest.slice(perLine)
      }
      const candidate = line ? `${line} ${rest}` : rest
      if (candidate.length > perLine) {
        lines.push(line)
        line = rest
      } else line = candidate
    }
    lines.push(line)
  }
  return lines
}

export function measureText(text: string, fontSize: number, maxWidth = Number.POSITIVE_INFINITY) {
  const lines = wrapText(text, fontSize, maxWidth)
  const longest = Math.max(1, ...lines.map((line) => line.length))
  return {
    lines,
    width: Math.ceil(longest * charWidth(fontSize)),
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
  }
}
