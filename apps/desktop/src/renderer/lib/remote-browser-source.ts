/**
 * Where the remote Browser tab gets its picture from: the tile's H.264 video, or the host's JPEG frames. A window that
 * plays video asks for it; it falls back to frames for good once the video breaks, but not when the stream ends as
 * the host or the gateway meant it to (a normal close, or the control given back).
 */
export type SourceState = { transport: 'video' | 'jpeg'; pictures: number }
export type SourceEvent =
  | { type: 'started'; transport: 'video' | 'jpeg' }
  | { type: 'picture' }
  | { type: 'video-closed'; code: number | null }
  | { type: 'video-error' }

/** Close codes of a video stream that ended on purpose: the host announces its own end over the bridge. */
const INTENDED_ENDS: ReadonlySet<number> = new Set([1000, 4001])

export function nextSource(state: SourceState, event: SourceEvent): { state: SourceState; fallBack: boolean } {
  if (event.type === 'started') return { state: { transport: event.transport, pictures: 0 }, fallBack: false }
  if (state.transport !== 'video') return { state, fallBack: false }
  if (event.type === 'picture') return { state: { ...state, pictures: state.pictures + 1 }, fallBack: false }
  if (event.type === 'video-closed' && event.code !== null && INTENDED_ENDS.has(event.code))
    return { state, fallBack: false }
  return { state: { transport: 'jpeg', pictures: state.pictures }, fallBack: true }
}
