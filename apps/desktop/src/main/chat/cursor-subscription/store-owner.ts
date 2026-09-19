import type { LocalAgentStore } from '@cursor/sdk'
import { CursorSubscriptionAccountChangedError } from './auth'

interface CursorStoreOwnerOptions {
  stateRoot(): string
  isDisposed(): boolean
  resetPromise(): Promise<void> | null
  ensureDirectory(directory: string): Promise<void>
  openStore?: (options: { stateRoot: string; workspaceRef: string }) => Promise<LocalAgentStore>
}

/** Serializes store generations; physical disposal waits for every accepted lease. */
export class CursorStoreOwner {
  private store: LocalAgentStore | null = null

  private storePromise: Promise<LocalAgentStore> | null = null

  private storeInFlight = 0

  private readonly pendingStoreDispose = new Set<LocalAgentStore>()

  private storeTransitionPromise: Promise<void> | null = null

  private storeDrainPromise: Promise<void> | null = null
  private storeDrainWaiters: Array<() => void> = []
  private lifecycleGeneration = 0
  private exclusivePromise: Promise<void> | null = null

  constructor(private readonly options: CursorStoreOwnerOptions) {}

  private async getStoreForLease(): Promise<{ store: LocalAgentStore; generation: number }> {
    while (this.options.resetPromise()) await this.options.resetPromise()
    if (this.options.isDisposed()) throw new Error('Cursor subscription manager is disposed')

    while (this.storeTransitionPromise) await this.storeTransitionPromise
    if (this.store) return { store: this.store, generation: this.lifecycleGeneration }
    if (this.storePromise) {
      const store = await this.storePromise
      return { store, generation: this.lifecycleGeneration }
    }
    const generation = ++this.lifecycleGeneration
    const promise = this.openStore(generation)
    this.storePromise = promise
    try {
      const store = await promise

      if (!this.options.isDisposed() && generation === this.lifecycleGeneration) {
        this.store = store
      }
      return { store, generation }
    } finally {
      if (this.storePromise === promise) this.storePromise = null
    }
  }

  private async openStore(generation: number): Promise<LocalAgentStore> {
    const stateRoot = this.options.stateRoot()
    await this.options.ensureDirectory(stateRoot)
    const store = await (this.options.openStore
      ? this.options.openStore({ stateRoot, workspaceRef: stateRoot })
      : (await import('@cursor/sdk/sqlite')).SqliteLocalAgentStore.open({ stateRoot, workspaceRef: stateRoot }))
    if (this.options.isDisposed() || generation !== this.lifecycleGeneration) {
      await (store as { dispose?: () => Promise<void> }).dispose?.().catch(() => undefined)
      throw new CursorSubscriptionAccountChangedError()
    }
    return store
  }

  async acquireStoreLease(exclusive = false): Promise<{ store: LocalAgentStore; release: () => void }> {
    for (;;) {
      while (!exclusive && this.exclusivePromise) await this.exclusivePromise
      const { store, generation } = await this.getStoreForLease()
      // Acceptance and increment are synchronous: a stale store never gains a lease.
      if (
        !this.options.isDisposed() &&
        (exclusive || !this.exclusivePromise) &&
        !this.storeTransitionPromise &&
        this.store === store &&
        !this.pendingStoreDispose.has(store) &&
        generation === this.lifecycleGeneration
      ) {
        this.storeInFlight += 1
        let released = false
        return {
          store,
          release: () => {
            if (released) return
            released = true
            this.storeInFlight -= 1
            if (this.storeInFlight === 0) {
              for (const resolve of this.storeDrainWaiters.splice(0)) resolve()
            }
            this.drainPendingStoreDispose()
          },
        }
      }

      while (this.storeTransitionPromise) await this.storeTransitionPromise
    }
  }

  async withStoreLease<T>(fn: (store: LocalAgentStore) => Promise<T>): Promise<T> {
    const lease = await this.acquireStoreLease()
    try {
      return await fn(lease.store)
    } finally {
      lease.release()
    }
  }

  /** Deletion excludes new turns and waits for existing turns to release. */
  async withExclusiveStoreLease<T>(fn: (store: LocalAgentStore) => Promise<T>): Promise<T> {
    while (this.exclusivePromise) await this.exclusivePromise
    let releaseExclusive!: () => void
    const exclusive = new Promise<void>((resolve) => {
      releaseExclusive = resolve
    })
    this.exclusivePromise = exclusive
    try {
      while (this.storeInFlight > 0) {
        await new Promise<void>((resolve) => this.storeDrainWaiters.push(resolve))
      }
      const lease = await this.acquireStoreLease(true)
      try {
        return await fn(lease.store)
      } finally {
        lease.release()
      }
    } finally {
      if (this.exclusivePromise === exclusive) this.exclusivePromise = null
      releaseExclusive()
    }
  }

  private drainPendingStoreDispose(): void {
    if (this.storeInFlight > 0 || this.storeDrainPromise) return
    if (this.pendingStoreDispose.size === 0) return
    const pending = new Set(this.pendingStoreDispose)
    this.pendingStoreDispose.clear()

    // Defer until the promise is assigned, including stores without a dispose hook.
    this.storeDrainPromise = Promise.resolve().then(async () => {
      try {
        for (const store of pending) {
          await (store as { dispose?: () => Promise<void> }).dispose?.().catch(() => undefined)
        }
      } finally {
        this.storeDrainPromise = null
        const waiters = this.storeDrainWaiters.splice(0)
        for (const resolve of waiters) resolve()
      }
    })
  }

  private async waitStoreDrained(): Promise<void> {
    for (;;) {
      if (this.storeInFlight > 0) {
        await new Promise<void>((resolve) => this.storeDrainWaiters.push(resolve))
        continue
      }
      const drain = this.storeDrainPromise
      if (drain) {
        await drain
        continue
      }
      if (this.pendingStoreDispose.size > 0) {
        this.drainPendingStoreDispose()
        continue
      }
      return
    }
  }

  /** Invalidate first, then serialize physical disposal behind accepted leases. */
  async disposeStore(): Promise<void> {
    while (this.storeTransitionPromise) {
      await this.storeTransitionPromise
    }
    this.lifecycleGeneration += 1
    const connecting = this.storePromise
    this.storePromise = null
    const active = this.store
    this.store = null
    const transition = (async () => {
      if (connecting) {
        const store = await connecting.catch(() => null)

        if (store && store !== active) {
          this.pendingStoreDispose.add(store)
        }
      }
      if (active) {
        this.pendingStoreDispose.add(active)
      }
      await this.waitStoreDrained()
    })()
    this.storeTransitionPromise = transition
    try {
      await transition
    } finally {
      if (this.storeTransitionPromise === transition) this.storeTransitionPromise = null
    }
  }
}
