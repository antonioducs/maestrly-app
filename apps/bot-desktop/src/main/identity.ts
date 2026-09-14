import { join } from 'node:path'
export const APP_ID = 'io.github.antonioducs.maestrly.bot'
export function identity(appData: string, packaged: boolean, fixture = false, fixtureSession?: string) {
  const channel = fixture ? 'fixture' : packaged ? 'lab' : 'dev'
  if (fixtureSession && (!fixture || !/^[a-f0-9-]{36}$/.test(fixtureSession))) throw new Error('Invalid fixture session')
  return {
    id: APP_ID,
    name: `Maestrly Bot ${channel === 'lab' ? 'Lab' : channel === 'dev' ? 'Dev' : 'Fixture'}`,
    userData: fixtureSession ? join(appData, `${APP_ID}.${channel}`, fixtureSession) : join(appData, `${APP_ID}.${channel}`),
  }
}
