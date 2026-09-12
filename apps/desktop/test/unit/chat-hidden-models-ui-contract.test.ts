import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/renderer/components/chat/ApiKeySettings.tsx', 'utf8')

describe('renderer model-filter contract', () => {
  it('reloads the default picker when the persisted filter changes', () => {
    expect(source).toContain('const [modelFilterRevision, setModelFilterRevision] = useState(0)')
    expect(source).toContain('modelFilterRevision={modelFilterRevision}')
    expect(source).toContain('[providerId, providerConnected, modelFilterRevision]')
  })

  it('serializes writes and prevents old snapshots from overwriting edits', () => {
    expect(source).toContain('saveQueueRef.current = saveQueueRef.current.then(save, save)')
    expect(source).toContain('hiddenRevision === hiddenRevisionRef.current')
    expect(source).toContain('hiddenRevisionRef.current += 1')
  })

  it('blocks bulk actions while loading and exposes persistence failures', () => {
    expect(source).toContain('disabled={loading || shown.length === 0}')
    expect(source).toContain("t('settings.modelFilterSaveFailed')")
    expect(source).toContain('const map = await window.api.chatHiddenModels()')
  })
})
