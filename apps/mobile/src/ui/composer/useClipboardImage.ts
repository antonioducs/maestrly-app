import * as Clipboard from 'expo-clipboard'
import { randomUUID } from 'expo-crypto'
import { File, Paths } from 'expo-file-system'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Platform } from 'react-native'
import type { OutboxAttachment } from '../../fleet/attachments'

/** Saves a pasted image in the app's cache, where attachments are read from when their message is sent. */
function savePasted(image: Clipboard.ClipboardImage): OutboxAttachment {
  const base64 = image.data.replace(/^data:[^;]+;base64,/, '')
  const name = `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`
  const file = new File(Paths.cache, 'pasted', `${randomUUID()}.jpg`)
  file.create({ intermediates: true, overwrite: true })
  file.write(base64, { encoding: 'base64' })
  return { name, kind: 'image', mediaType: 'image/jpeg', uri: file.uri, byteSize: file.size ?? 0 }
}

/**
 * Whether the clipboard holds an image to paste, and pasting it. A text field only pastes text, so the composer offers
 * the image itself. Checking reads no content, so iOS asks nothing until the person pastes; once pasted, the offer
 * waits for the clipboard to change or the app to come back.
 */
export function useClipboardImage(enabled: boolean) {
  const [available, setAvailable] = useState(false)
  const used = useRef(false)
  const check = useCallback(() => {
    if (!enabled || Platform.OS === 'web') return
    void Clipboard.hasImageAsync().then(
      (has) => setAvailable(has && !used.current),
      () => setAvailable(false)
    )
  }, [enabled])

  useEffect(() => {
    if (!enabled || Platform.OS === 'web') {
      setAvailable(false)
      return
    }
    check()
    const changed = Clipboard.addClipboardListener(() => {
      used.current = false
      check()
    })
    const app = AppState.addEventListener('change', (state) => {
      // Another app may have put a new image there; iOS does not say whether it did.
      if (state !== 'active') return
      used.current = false
      check()
    })
    return () => {
      changed.remove()
      app.remove()
    }
  }, [enabled, check])

  const paste = useCallback(async (): Promise<OutboxAttachment | null> => {
    const image = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.8 })
    used.current = true
    setAvailable(false)
    return image ? savePasted(image) : null
  }, [])

  return { available, check, paste }
}
