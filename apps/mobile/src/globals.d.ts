// Expo's runtime installs TextDecoder on native (expo/src/winter/runtime.native.ts) and browsers have it, but React
// Native's type definitions do not declare it.
declare class TextDecoder {
  constructor(label?: string)
  decode(input?: Uint8Array, options?: { stream?: boolean }): string
}
