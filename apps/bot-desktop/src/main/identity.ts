import { join } from 'node:path'
export const APP_ID = 'io.github.antonioducs.maestrly.bot'
export function identity(appData: string, packaged: boolean, fixture = false) {
  const channel = fixture ? 'fixture' : packaged ? 'lab' : 'dev'
  return {
    id: APP_ID,
    name: `Maestrly Bot ${channel === 'lab' ? 'Lab' : channel === 'dev' ? 'Dev' : 'Fixture'}`,
    userData: join(appData, `${APP_ID}.${channel}`),
  }
}
