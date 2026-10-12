import type { ExpoConfig } from 'expo/config'

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
  android: { package: 'io.github.antonioducs.maestrly.mobile' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-font',
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
