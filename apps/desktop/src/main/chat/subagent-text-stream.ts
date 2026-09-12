/** Incremental text contract shared by every isolated subagent runtime. */
export type SubagentTextUpdate = { kind: 'append'; text: string } | { kind: 'replace'; text: string }

export type SubagentTextUpdateHandler = (update: SubagentTextUpdate) => void

/** Applies one update to the text currently shown by a host/UI. */
export function applySubagentTextUpdate(current: string, update: SubagentTextUpdate): string {
  return update.kind === 'append' ? current + update.text : update.text
}

/**
 * Normalizes runtime snapshots into append events when they extend the text already emitted and replace events
 * when a runtime corrects/restarts it. Callers can therefore fold every provider with applySubagentTextUpdate.
 */
export function createSubagentTextEmitter(onTextUpdate?: SubagentTextUpdateHandler): (snapshot: string) => void {
  let emitted = ''
  return (snapshot) => {
    if (snapshot === emitted) return
    if (snapshot.startsWith(emitted)) {
      const text = snapshot.slice(emitted.length)
      emitted = snapshot
      if (text) onTextUpdate?.({ kind: 'append', text })
      return
    }
    emitted = snapshot
    onTextUpdate?.({ kind: 'replace', text: snapshot })
  }
}
