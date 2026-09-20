import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function sourceFiles(directory = new URL('../src/', import.meta.url)): Promise<URL[]> {
  const found: URL[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory)
    if (entry.isDirectory()) found.push(...(await sourceFiles(child)))
    else if (entry.name.endsWith('.tsx')) found.push(child)
  }
  return found
}

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

  it('never falls back to a native select', async () => {
    // Every choice in this interface uses the keyboard-accessible Select, so it looks and behaves the same
    // on every platform instead of rendering the operating system dropdown.
    for (const file of await sourceFiles())
      expect(await readFile(file, 'utf8'), file.pathname).not.toMatch(/<select[\s>]/)
  })

  it('echoes the signed authorization query instead of rebuilding it', async () => {
    const consent = await readFile(new URL('../src/features/auth/ConsentApproval.tsx', import.meta.url), 'utf8')
    // The server decides what was requested; this page must not compose its own authorization parameters.
    expect(consent).toContain('oauth_query')
    expect(consent).toContain('location.search')
  })

  it('offers only the efforts and modes the chosen selection actually lists', async () => {
    const picker = await readFile(new URL('../src/features/delegations/ModelPicker.tsx', import.meta.url), 'utf8')
    expect(picker).toContain('selection?.efforts ?? []')
    expect(picker).toContain('next?.efforts.includes(value.reasoning)')
    expect(picker).not.toContain("['low', 'medium', 'high']")
  })
})
