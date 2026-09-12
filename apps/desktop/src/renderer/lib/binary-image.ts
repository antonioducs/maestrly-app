export function bytesToObjectUrl(bytes: Uint8Array, mediaType: string): string {
  const copy = Uint8Array.from(bytes)
  return URL.createObjectURL(new Blob([copy.buffer], { type: mediaType }))
}

export function imageResultToObjectUrl(result: { bytes: Uint8Array; mediaType: string }): string {
  return bytesToObjectUrl(result.bytes, result.mediaType)
}

const MAX_CONCURRENT_IMAGE_FETCHES = 3
let activeImageFetches = 0
const waiters: Array<{
  signal: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  onAbort: () => void
}> = []

function releaseImageFetchSlot(): void {
  activeImageFetches = Math.max(0, activeImageFetches - 1)
  while (waiters.length) {
    const waiter = waiters.shift()!
    waiter.signal.removeEventListener('abort', waiter.onAbort)
    if (waiter.signal.aborted) {
      waiter.reject(waiter.signal.reason ?? new Error('Image fetch was aborted.'))
      continue
    }
    activeImageFetches += 1
    waiter.resolve(releaseImageFetchSlot)
    break
  }
}

function acquireImageFetchSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Image fetch was aborted.'))
  if (activeImageFetches < MAX_CONCURRENT_IMAGE_FETCHES) {
    activeImageFetches += 1
    return Promise.resolve(releaseImageFetchSlot)
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        reject(signal.reason ?? new Error('Image fetch was aborted.'))
      },
    }
    signal.addEventListener('abort', waiter.onAbort, { once: true })
    waiters.push(waiter)
  })
}

export async function withImageFetchSlot<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const release = await acquireImageFetchSlot(signal)
  try {
    signal.throwIfAborted()
    return await work()
  } finally {
    release()
  }
}
