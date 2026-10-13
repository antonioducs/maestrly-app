import type { ExpoConfig } from 'expo/config'

/**
 * Push notifications need the EAS project of the build (`eas init` prints its id) and, on Android, the Firebase
 * file of the app. Builds without them still work; their Settings say notifications are not available.
 */
const projectId = process.env.MAESTRLY_EAS_PROJECT_ID?.trim() || undefined
const googleServicesFile = process.env.MAESTRLY_GOOGLE_SERVICES_FILE?.trim() || undefined

const config: ExpoConfig = {
  name: 'Maestrly',
  slug: 'maestrly',
  scheme: 'maestrly',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'io.github.antonioducs.maestrly.mobile',
    supportsTablet: false,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: 'io.github.antonioducs.maestrly.mobile',
    ...(googleServicesFile ? { googleServicesFile } : {}),
  },
  ...(projectId ? { extra: { eas: { projectId } } } : {}),
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
    ['expo-notifications', { color: '#c79a3a' }],
    [
      'expo-camera',
      {
        cameraPermission: 'Maestrly uses the camera to scan the pairing code shown on your computer.',
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: 'Maestrly attaches the photos you choose to your messages.',
        cameraPermission: 'Maestrly uses the camera to take photos you send to your bots.',
        microphonePermission: false,
      },
    ],
  ],
}
export default config
