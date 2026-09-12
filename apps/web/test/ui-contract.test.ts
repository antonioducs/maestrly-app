import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('web trust boundaries', () => {
  it('does not render agent-controlled HTML directly', async () => {
    const files = [
      '../src/features/cards/CardDialog.tsx',
      '../src/features/boards/BoardView.tsx',
      '../src/features/executions/OperationsPanel.tsx',
    ]
    for (const file of files) expect(await readFile(new URL(file, import.meta.url), 'utf8')).not.toContain('dangerouslySetInnerHTML')
  })

  it('keeps unknown cost explicitly unavailable', async () => {
    expect(await readFile(new URL('../src/features/reports/ReportsPanel.tsx', import.meta.url), 'utf8')).toContain('Unavailable')
  })
})
