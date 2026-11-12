// What the artifact host's bridge gives a whiteboard's page, and what the page shows its end-to-end check.

interface MaestrlyBoard {
  load(): Promise<{ revision: number; elements: unknown[]; canEdit: boolean }>
  push(elements: unknown[]): Promise<{ revision: number; kept: unknown[] }>
  subscribe(listener: (change: { revision: number; elements: unknown[] }) => void): () => void
}

interface Window {
  maestrly?: { board?: MaestrlyBoard }
  __whiteboard?: {
    ready(): boolean
    canEdit(): boolean
    elements(): unknown[]
    viewportCenter(id: string): { x: number; y: number } | null
  }
}
