import { execFile as cpExecFile } from 'node:child_process'
import { coerceVolume, type SoundVoice } from '../../shared/sound'
import { isSoundVoice } from './assets'

const VOICE_MAC: Record<SoundVoice, string> = {
  glass: 'Glass',
  submarine: 'Submarine',
  ping: 'Ping',
  pop: 'Pop',
  hero: 'Hero',
  funk: 'Funk',
  sosumi: 'Sosumi',
  tink: 'Tink',
}
const VOICE_WIN: Record<SoundVoice, string> = {
  glass: 'Asterisk',
  submarine: 'Exclamation',
  ping: 'Beep',
  pop: 'Beep',
  hero: 'Asterisk',
  funk: 'Hand',
  sosumi: 'Hand',
  tink: 'Question',
}
const VOICE_LINUX: Record<SoundVoice, string> = {
  glass: 'complete',
  submarine: 'message',
  ping: 'bell',
  pop: 'bell',
  hero: 'complete',
  funk: 'dialog-warning',
  sosumi: 'dialog-error',
  tink: 'message',
}

/** Exceptional OS sound fallback; best-effort and never fatal. */
export function playNativeSound(voice: SoundVoice, volume = 1, platform: NodeJS.Platform = process.platform): void {
  if (!isSoundVoice(voice)) return
  const vol = coerceVolume(volume)
  if (vol <= 0) return
  try {
    if (platform === 'darwin') {
      const file = `/System/Library/Sounds/${VOICE_MAC[voice]}.aiff`
      const args = vol < 1 ? ['-v', String(Math.round(vol * 100) / 100), file] : [file]
      cpExecFile('afplay', args, () => {})
      return
    }
    if (platform === 'win32') {
      // SystemSounds exposes no gain; at partial volume prefer silence to violating user settings.
      if (vol < 1) return
      cpExecFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `[System.Media.SystemSounds]::${VOICE_WIN[voice]}.Play()`],
        () => {}
      )
      return
    }
    if (platform === 'linux') {
      const id = VOICE_LINUX[voice]
      const file = `/usr/share/sounds/freedesktop/stereo/${id}.oga`
      const args = vol < 1 ? [`--volume=${Math.round(vol * 65536)}`, file] : [file]
      cpExecFile('paplay', args, (err) => {
        if (!err || vol < 1) return // canberra also exposes no gain control
        try {
          cpExecFile('canberra-gtk-play', ['-i', id], () => {})
        } catch {
          /* Fallback playback is also best-effort. */
        }
      })
    }
  } catch {
    /* best-effort sound must never break the caller */
  }
}
