import * as Notifications from 'expo-notifications'

export {
  BADGE_OTHERS_DEBOUNCE_MS,
  computeBadgeOthers,
  createBadgeSync,
  type BadgeServerRef,
  type BadgeSync,
  type BadgeSyncOptions,
} from './badge-sync'

/** Sets the native app-icon badge count; swallows platform errors when permission is absent or unsupported. */
export async function setAppBadgeCount(count: number): Promise<void> {
  const safe = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0))
  try {
    await Notifications.setBadgeCountAsync(safe)
  } catch {
    // Badge updates are best-effort; never disrupt the app if OS permission was not granted.
  }
}
