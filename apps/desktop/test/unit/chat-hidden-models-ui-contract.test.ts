import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settings = readFileSync('src/renderer/components/chat/ApiKeySettings.tsx', 'utf8')
const filter = readFileSync('src/renderer/components/chat/accounts/ProviderModelFilter.tsx', 'utf8')
const pickers = readFileSync('src/renderer/components/chat/model-settings/SelectionBodies.tsx', 'utf8')

describe('renderer model-filter contract', () => {
  it('reloads the default picker when the persisted filter changes', () => {
    expect(settings).toContain('const [modelFilterRevision, setModelFilterRevision] = useState(0)')
    expect(settings).toContain('modelFilterRevision={modelFilterRevision}')
    expect(pickers).toContain('[api, draft.providerId, providerConnected, modelFilterRevision]')
  })

  it('serializes writes and prevents old snapshots from overwriting edits', () => {
    expect(filter).toContain('saveQueueRef.current = saveQueueRef.current.then(save, save)')
    expect(filter).toContain('hiddenRevision === hiddenRevisionRef.current')
    expect(filter).toContain('hiddenRevisionRef.current += 1')
  })

  it('blocks bulk actions while loading and exposes persistence failures', () => {
    expect(filter).toContain('disabled={loading || shown.length === 0}')
    expect(filter).toContain("t('settings.modelFilterSaveFailed')")
    expect(filter).toContain('const map = await api.chatHiddenModels()')
  })
})
