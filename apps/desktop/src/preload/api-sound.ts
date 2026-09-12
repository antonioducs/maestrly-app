import { ipcRenderer } from 'electron'
import type { SoundPlayAck, SoundPlayRequest } from '../shared/sound-playback'

export const soundApi = {
  onSoundPlay: (cb: (request: SoundPlayRequest) => void): (() => void) => {
    const listener = (_event: unknown, request: SoundPlayRequest) => cb(request)
    ipcRenderer.on('sound:play', listener)
    return () => ipcRenderer.removeListener('sound:play', listener)
  },
  setSoundRendererReady: (): void => ipcRenderer.send('sound:renderer-ready'),
  ackSoundPlay: (ack: SoundPlayAck): void => ipcRenderer.send('sound:ack', ack),
}
