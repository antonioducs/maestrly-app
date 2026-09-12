import { describe, expect, it, vi } from 'vitest'
import { NotesSaveQueue, prepareNotesMemoryEviction } from '../../src/renderer/lib/notes-save-queue'

describe('NotesSaveQueue — memory eviction during pending or in-flight saves', () => {
  it('settle waits for the pending save triggered by flush to become durable (eviction-during-pending-save)', async () => {
    const queue = new NotesSaveQueue()
    let finishWrite!: () => void
    const write = vi.fn(
      (_id: string, _md: string) => new Promise<void>((resolve) => (finishWrite = resolve)),
    )
    queue.setPending('p1', 'latest edit')
    const settled = queue.flush(write)

    let done = false
    void settled.then(() => {
      done = true
    })
    // An in-flight write prevents settlement: acknowledging safety now would let the reclaimer
    // close the view while writeNotePage is pending, losing the latest edit during teardown.
    await Promise.resolve()
    expect(done).toBe(false)

    finishWrite()
    await settled
    expect(done).toBe(true)
    expect(write).toHaveBeenCalledWith('p1', 'latest edit')
  })

  it('settle also waits for saves started before flushing the pending save', async () => {
    const queue = new NotesSaveQueue()
    const stuck = vi.fn(() => new Promise<void>(() => {})) // save 1 never resolves
    queue.setPending('p1', 'a')
    void queue.flush(stuck)

    queue.setPending('p2', 'b')
    const settled = queue.flush(vi.fn(async () => undefined))
    let done = false
    settled.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false) // in-flight save 1 prevents settlement and premature acknowledgement
    expect(stuck).toHaveBeenCalledWith('p1', 'a')
  })

  it('settle rejects write failures so prepare reports an unsafe, nondurable state', async () => {
    const queue = new NotesSaveQueue()
    queue.setPending('p1', 'boom')
    const settled = queue.flush(vi.fn(async () => Promise.reject(new Error('disk'))))
    await expect(settled).rejects.toThrow('disk')
  })

  it('flush without a pending edit returns the current chain of in-flight saves', async () => {
    const queue = new NotesSaveQueue()
    let finishWrite!: () => void
    queue.setPending('p1', 'a')
    void queue.flush(vi.fn(() => new Promise<void>((resolve) => (finishWrite = resolve))))

    const settled = queue.flush(vi.fn(async () => undefined)) // no pending edit → same chain
    let done = false
    settled.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    finishWrite()
    await settled
    expect(done).toBe(true)
  })

  it('overwrites the single pending slot and submits only the latest edit', async () => {
    const queue = new NotesSaveQueue()
    queue.setPending('p1', 'a')
    queue.setPending('p1', 'b') // typing continued before the debounce
    const write = vi.fn(async () => undefined)
    await queue.flush(write)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('p1', 'b')
    expect(queue.pendingEdit).toBeNull()
  })

  it('acknowledges safety only after the title draft becomes durable', async () => {
    let finishTitle!: () => void
    let titleDurable = false
    const commitTitle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTitle = () => {
            titleDurable = true
            resolve()
          }
        }),
    )
    const persistOpenPage = vi.fn()
    const prepared = prepareNotesMemoryEviction({
      pendingDelete: false,
      conflict: false,
      flushBody: vi.fn(async () => undefined),
      titleDirty: true,
      commitTitle,
      persistOpenPage,
    })

    await Promise.resolve()
    expect(commitTitle).toHaveBeenCalledOnce()
    expect(titleDurable).toBe(false)
    expect(persistOpenPage).not.toHaveBeenCalled()

    finishTitle()
    await expect(prepared).resolves.toEqual({ safe: true })
    expect(titleDurable).toBe(true)
    expect(persistOpenPage).toHaveBeenCalledOnce()
  })

  it('denies eviction when committing the title fails', async () => {
    const commitTitle = vi.fn(async () => Promise.reject(new Error('manifest')))
    const persistOpenPage = vi.fn()

    await expect(
      prepareNotesMemoryEviction({
        pendingDelete: false,
        conflict: false,
        flushBody: vi.fn(async () => undefined),
        titleDirty: true,
        commitTitle,
        persistOpenPage,
      }),
    ).resolves.toEqual({ safe: false, reason: 'title-write-failed' })
    expect(persistOpenPage).not.toHaveBeenCalled()
  })
})
