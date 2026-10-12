export type SseFrame = { event: string; data: string }

/** Incremental text/event-stream parser: comments, multi-line data and CR, LF or CRLF line ends. */
export class SseParser {
  private buffer = ''
  private event = ''
  private data: string[] = []
  push(text: string): SseFrame[] {
    this.buffer += text
    const frames: SseFrame[] = []
    for (;;) {
      const end = this.buffer.search(/\r\n|\r|\n/)
      if (end < 0) break
      // A lone CR at the end of a chunk may be the first half of CRLF.
      if (this.buffer[end] === '\r' && end === this.buffer.length - 1) break
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + (this.buffer.startsWith('\r\n', end) ? 2 : 1))
      if (line === '') {
        if (this.data.length) frames.push({ event: this.event || 'message', data: this.data.join('\n') })
        this.event = ''
        this.data = []
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') this.event = value
        else if (field === 'data') this.data.push(value)
      }
    }
    return frames
  }
}
