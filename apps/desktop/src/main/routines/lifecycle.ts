import { app } from 'electron'

export const ROUTINE_LOGIN_ARG = '--routines-background'

export function isLoginItemSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

export function applyRoutineLoginItem(
  openAtLogin: boolean,
  platform: NodeJS.Platform = process.platform,
  appApi: Pick<typeof app, 'setLoginItemSettings'> = app
): void {
  if (!isLoginItemSupported(platform)) return
  try {
    appApi.setLoginItemSettings({
      openAtLogin,
      args: [ROUTINE_LOGIN_ARG],
    })
  } catch (error) {
    console.warn('[routines] setLoginItemSettings failed:', error instanceof Error ? error.message : String(error))
  }
}

export function wasOpenedAtLoginForRoutines(input: {
  platform?: NodeJS.Platform
  argv?: readonly string[]
  loginItemSettings?: { wasOpenedAtLogin?: boolean }
}): boolean {
  const platform = input.platform ?? process.platform
  if (!isLoginItemSupported(platform)) return false
  const argv = input.argv ?? process.argv
  if (platform === 'darwin') {
    return input.loginItemSettings?.wasOpenedAtLogin === true || argv.includes(ROUTINE_LOGIN_ARG)
  }
  return argv.includes(ROUTINE_LOGIN_ARG)
}
