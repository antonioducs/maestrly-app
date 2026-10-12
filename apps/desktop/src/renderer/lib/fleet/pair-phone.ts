import { isAllowedPhoneServerUrl } from '@maestrly/bot-fleet-protocol'

/** This computer's address only works for a phone when it is HTTPS; a tunnel or loopback address would not. */
export const initialPhoneAddress = (url: string | null): string => (url && isAllowedPhoneServerUrl(url).ok ? url : '')

export function phoneAddressError(input: string): string | null {
  const result = isAllowedPhoneServerUrl(input.trim())
  return result.ok ? null : result.reason
}

export const secondsLeft = (expiresAt: string, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
