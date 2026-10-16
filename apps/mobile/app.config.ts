import type { ExpoConfig } from 'expo/config'

/**
 * Store builds come from EAS (see eas.json and docs/mobile.md). Push notifications need the EAS project of the build
 * (`eas init` prints its id) and, on Android, the Firebase file of the app. Builds without them still work; their
 * Settings say notifications are not available.
 */
const env = (name: string) => process.env[name]?.trim() || undefined
const projectId = env('MAESTRLY_EAS_PROJECT_ID')
const owner = env('MAESTRLY_EAS_OWNER')
const googleServicesFile = env('MAESTRLY_GOOGLE_SERVICES_FILE')

/** The tile of the app icon, and the background of the intro (src/ui/Intro.tsx), dark in both themes. */
const TILE = '#131514'
const INTRO = '#0f1110'
/** Every plugin that touches the microphone gets the same reason, so none of them overrides it with a generic one. */
const MICROPHONE = 'Maestrly uses the microphone only while you dictate a message.'

const config: ExpoConfig = {
  name: 'Maestrly',
  slug: 'maestrly',
  scheme: 'maestrly',
  version: '0.1.0',
  ...(owner ? { owner } : {}),
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/images/icon.png',
  ios: {
    bundleIdentifier: 'io.github.antonioducs.maestrly.mobile',
    supportsTablet: false,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
    // The required-reason APIs that React Native, the Expo modules and AsyncStorage declare in their own manifests,
    // repeated so the app's manifest does not depend on CocoaPods aggregating them. The app tracks no one and
    // collects nothing: what it sends goes to the user's own bot server.
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
      NSPrivacyAccessedAPITypes: [
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults', NSPrivacyAccessedAPITypeReasons: ['CA92.1'] },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1', '0A2A.1', '3B52.1'],
        },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime', NSPrivacyAccessedAPITypeReasons: ['35F9.1'] },
        { NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace', NSPrivacyAccessedAPITypeReasons: ['E174.1', '85F4.1'] },
      ],
    },
  },
  android: {
    package: 'io.github.antonioducs.maestrly.mobile',
    // Part of the template for React Native's debug overlay; the app never draws over other apps.
    blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW'],
    adaptiveIcon: {
      foregroundImage: './assets/images/adaptive-icon.png',
      monochromeImage: './assets/images/monochrome-icon.png',
      backgroundColor: TILE,
    },
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  web: { favicon: './assets/images/favicon.png' },
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
  plugins: [
    'expo-router',
    // The token is read without biometrics, so the app never asks for Face ID.
    ['expo-secure-store', { faceIDPermission: false }],
    'expo-font',
    [
      'expo-splash-screen',
      // Only the intro's background: the intro draws the logo once the app starts. The image is transparent.
      { image: './assets/images/splash-icon.png', imageWidth: 120, resizeMode: 'contain', backgroundColor: INTRO },
    ],
    [
      'expo-speech-recognition',
      {
        microphonePermission: MICROPHONE,
        speechRecognitionPermission: 'Maestrly turns what you dictate into text for your messages.',
      },
    ],
    ['expo-notifications', { icon: './assets/images/notification-icon.png', color: '#c79a3a' }],
    [
      'expo-camera',
      {
        cameraPermission: 'Maestrly uses the camera to scan the pairing code shown on your computer.',
        microphonePermission: MICROPHONE,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Maestrly attaches the photos you choose to your messages.',
        cameraPermission: 'Maestrly uses the camera to take photos you send to your bots.',
        microphonePermission: MICROPHONE,
      },
    ],
  ],
}
export default config
