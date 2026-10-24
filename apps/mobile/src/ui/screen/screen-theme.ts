import type { ScreenPageTheme } from '../../screen/screen-page'
import type { Palette } from '../../theme/tokens'

/** The app's colors in the screen's page: the code background around the screen, and the cue for where the bot is. */
export const screenPageTheme = (palette: Palette): ScreenPageTheme => ({
  base: palette.codeBg,
  ink: palette.codeInk,
  muted: palette.faint,
  cue: palette.cue,
  onCue: '#1f201e',
})
