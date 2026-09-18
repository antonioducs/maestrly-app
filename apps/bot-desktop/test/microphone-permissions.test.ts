import { expect, it } from 'vitest'
import { decideMicrophone, requestSystemMicrophone } from '../src/main/microphone-permissions'

const expectedUrl = 'file:///Applications/Maestrly.app/renderer/index.html'
const ask = (overrides: Partial<Parameters<typeof decideMicrophone>[0]> = {}) =>
  decideMicrophone({
    permission: 'audioCapture',
    details: {},
    isMainFrame: true,
    sameWebContents: true,
    requestingUrl: expectedUrl,
    expectedUrl,
    armed: true,
    ...overrides,
  })

it('grants the microphone only while a person is actually recording in this window', () => {
  expect(ask()).toBe(true)
  // Nothing is granted on load: the page has to be holding the button.
  expect(ask({ armed: false })).toBe(false)
})

it('never grants the camera or the screen, whatever the page asks for', () => {
  expect(ask({ permission: 'video' })).toBe(false)
  expect(ask({ permission: 'videoCapture' })).toBe(false)
  expect(ask({ permission: 'display-capture' })).toBe(false)
  expect(ask({ permission: 'geolocation' })).toBe(false)
  expect(ask({ permission: 'notifications' })).toBe(false)
  expect(ask({ permission: 'clipboard-read' })).toBe(false)
  // The generic "media" permission covers audio and video; only audio-only is accepted.
  expect(ask({ permission: 'media', details: { mediaTypes: ['audio'] } })).toBe(true)
  expect(ask({ permission: 'media', details: { mediaTypes: ['audio', 'video'] } })).toBe(false)
  expect(ask({ permission: 'media', details: { mediaTypes: [] } })).toBe(false)
  expect(ask({ permission: 'media', details: {} })).toBe(false)
})

it('refuses a subframe, another window and an unexpected page', () => {
  expect(ask({ isMainFrame: false })).toBe(false)
  expect(ask({ details: { isMainFrame: false }, isMainFrame: false })).toBe(false)
  expect(ask({ sameWebContents: false })).toBe(false)
  expect(ask({ requestingUrl: 'https://example.com/' })).toBe(false)
  expect(ask({ requestingUrl: `${expectedUrl}?x=1` })).toBe(false)
  expect(ask({ requestingUrl: '' })).toBe(false)
})

it('asks macOS for the system grant on a gesture and reports what it got', async () => {
  const asked: string[] = []
  expect(await requestSystemMicrophone({ getMediaAccessStatus: () => 'granted' }, 'darwin')).toBe('granted')
  expect(await requestSystemMicrophone({ getMediaAccessStatus: () => 'restricted' }, 'darwin')).toBe('restricted')
  expect(await requestSystemMicrophone({ getMediaAccessStatus: () => 'denied' }, 'darwin')).toBe('denied')
  expect(
    await requestSystemMicrophone(
      {
        getMediaAccessStatus: () => 'not-determined',
        askForMediaAccess: async (type) => {
          asked.push(type)
          return true
        },
      },
      'darwin'
    )
  ).toBe('granted')
  expect(asked).toEqual(['microphone'])
  // A refusal from the system is a refusal here; nothing pretends otherwise.
  expect(await requestSystemMicrophone({ getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => false }, 'darwin')).toBe('denied')
  // An Electron build without the API says so instead of assuming it may record.
  expect(await requestSystemMicrophone({ getMediaAccessStatus: () => 'not-determined' }, 'darwin')).toBe('unavailable')
})
