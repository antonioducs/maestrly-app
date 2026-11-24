export {
  BADGE_OTHERS_DEBOUNCE_MS,
  computeBadgeOthers,
  createBadgeSync,
  type BadgeServerRef,
  type BadgeSync,
  type BadgeSyncOptions,
} from './badge-sync'

/** Web preview has no OS app-icon badge and never loads expo-notifications. */
export async function setAppBadgeCount(_count: number): Promise<void> {}
