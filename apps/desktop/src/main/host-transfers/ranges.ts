/** A part of a transfer that is moved, verified and recorded on its own. */
export interface HostTransferRange {
  index: number
  start: number
  length: number
}

export function planRanges(size: number, rangeBytes: number): HostTransferRange[] {
  const ranges: HostTransferRange[] = []
  for (let start = 0, index = 0; start < size; start += rangeBytes, index++)
    ranges.push({ index, start, length: Math.min(rangeBytes, size - start) })
  return ranges
}
