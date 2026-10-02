import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PERSONAL_MEMORY_SPACE_ID,
  type LocalMemory,
  type MemoryIndexStatus,
  type PersonalMemorySettings,
} from '../../../shared/memory'

export const memoryError = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason))

async function loadMemories(): Promise<LocalMemory[]> {
  const rows: LocalMemory[] = []
  for (;;) {
    const page = await window.api.listPersonalMemories({ limit: 500, offset: rows.length })
    rows.push(...page)
    if (page.length < 500) return rows
  }
}

/** Refresh the collection without unmounting open drafts or accepting older reads over newer events. */
export function usePersonalMemory() {
  const [memories, setMemories] = useState<LocalMemory[]>([])
  const [settings, setSettings] = useState<PersonalMemorySettings | null>(null)
  const [index, setIndex] = useState<MemoryIndexStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const settingsRevision = useRef(0)
  const indexRevision = useRef(0)

  const reload = useCallback(async () => {
    const request = ++generation.current
    const settingsVersion = settingsRevision.current
    const indexVersion = indexRevision.current
    try {
      const [rows, nextSettings, nextIndex] = await Promise.all([
        loadMemories(),
        window.api.getPersonalMemorySettings(),
        window.api.getPersonalMemoryIndexStatus(),
      ])
      if (request !== generation.current) return
      setMemories(rows)
      if (settingsVersion === settingsRevision.current) setSettings(nextSettings)
      if (indexVersion === indexRevision.current) setIndex(nextIndex)
      setError('')
    } catch (reason) {
      if (request === generation.current) setError(memoryError(reason))
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const offMemory = window.api.onMemoryChanged((event) => {
      if (event.workspaceId === PERSONAL_MEMORY_SPACE_ID) void reload()
    })
    const offSettings = window.api.onPersonalMemorySettingsChanged((next) => {
      settingsRevision.current += 1
      setSettings(next)
    })
    const offIndex = window.api.onMemoryIndexStatus((next) => {
      if (next.workspaceId !== PERSONAL_MEMORY_SPACE_ID) return
      indexRevision.current += 1
      setIndex(next)
    })
    void reload()
    return () => {
      generation.current += 1
      offMemory()
      offSettings()
      offIndex()
    }
  }, [reload])

  const accept = (memory: LocalMemory) => {
    generation.current += 1
    setMemories((rows) => {
      const found = rows.some((row) => row.id === memory.id)
      return found ? rows.map((row) => (row.id === memory.id ? memory : row)) : [memory, ...rows]
    })
    void reload()
  }

  return { memories, settings, index, loading, error, reload, accept }
}
