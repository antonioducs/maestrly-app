import { FLEET_FILE_LIMITS, type FleetPublishedFile } from '@maestrly/bot-fleet-protocol'

const MIB = 1024 ** 2
export const DEMO_FILES_BOT = 'pixel'
export const DEMO_FILES_QUOTA = 1024 * MIB
/** Pixel's files fill its space but 7 MB, so the demo shows the full-space notice and the Files sheet. */
export const DEMO_FILES_FREE = 7 * MIB

export function demoFilesWorld(now: number): { pixel: FleetPublishedFile[] } {
  const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
  const file = (
    id: string,
    name: string,
    mediaType: string,
    byteSize: number,
    minutes: number,
    origin: FleetPublishedFile['origin'] = { kind: 'primary' },
    originGone = false
  ): FleetPublishedFile => ({ id, name, mediaType, byteSize, sharedAt: at(minutes), origin, originGone })
  const review = (week: number) => ({
    kind: 'routine' as const,
    runId: `pixel-review-${week}`,
    title: 'Weekly visual review',
  })
  const pixel = [
    // The walkthrough is the one Pixel's conversation shows (fixtures.ts, `shared('pixel-2c', …)`).
    file('pixel-2c-file', 'pricing-walkthrough.mp4', 'video/mp4', 4 * MIB, 14),
    file('pixel-staging-1440', 'staging-recording-1440.mp4', 'video/mp4', 98 * MIB, 60 * 26),
    file('pixel-staging-390', 'staging-recording-390.mp4', 'video/mp4', 61 * MIB, 60 * 26),
    file('pixel-hero-zip', 'hero-variants.zip', 'application/zip', 84 * MIB, 60 * 50),
    file('pixel-hero-a', 'pricing-hero-a.png', 'image/png', 2 * MIB, 60 * 50),
    file('pixel-hero-b', 'pricing-hero-b.png', 'image/png', 2 * MIB, 60 * 50),
    file('pixel-hero-c', 'pricing-hero-c.png', 'image/png', 2 * MIB, 60 * 50),
  ]
  // Pixel keeps no routine runs in the demo, so the conversations of the runs that shared these are gone.
  for (let week = 1; week <= 8; week++)
    pixel.push(
      file(
        `pixel-review-${week}-file`,
        `visual-review-week-${week}.mp4`,
        'video/mp4',
        96 * MIB,
        60 * 24 * 7 * (9 - week),
        review(week),
        true
      )
    )
  // The last review takes what is left, so the space reads exactly 7 MB free.
  const rest = pixel.slice(0, -1).reduce((sum, item) => sum + item.byteSize, 0)
  pixel[pixel.length - 1] = { ...pixel[pixel.length - 1]!, byteSize: DEMO_FILES_QUOTA - DEMO_FILES_FREE - rest }
  if (pixel.some((item) => item.byteSize > FLEET_FILE_LIMITS.downloadMaxBytes)) throw new Error('Demo file too large')
  return { pixel }
}
