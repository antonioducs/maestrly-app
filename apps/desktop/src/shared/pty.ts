/** Metadata shared by the main PTY owner and renderer replay handshake. */
export interface PtyStreamMeta {
  generation: number
  sequence: number
}

export interface PtyDataEvent extends PtyStreamMeta {
  data: string
}

export interface PtyExitEvent {
  code: number
  generation?: number
}

/** O(1) cursor for the bounded output ring. `totalChars` is monotonic within a generation. */
export interface PtyOutputStats {
  generation: number
  sequence: number
  bufferedLength: number
  totalChars: number
}

export interface PtyOutputSnapshot extends PtyOutputStats {
  data: string
}
