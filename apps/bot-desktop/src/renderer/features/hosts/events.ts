import type { HostEvent } from '../../../shared/types'
export function mergeEvents(previous: HostEvent[], batch: HostEvent[]): HostEvent[] {
  return [...new Map([...previous, ...batch].map((event) => [event.seq, event])).values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(-300)
}
