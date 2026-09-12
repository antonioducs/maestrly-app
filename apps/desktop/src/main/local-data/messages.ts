import { tMain } from '../i18n'

/** Resolve dialogs at call time so language changes apply without restarting. */
export const localDataMessages = {
  get resetInProgress() {
    return tMain('ui')('localData.resetInProgress')
  },
  get exportInProgress() {
    return tMain('ui')('localData.exportInProgress')
  },
  get windowUnavailable() {
    return tMain('ui')('localData.windowUnavailable')
  },
  get exportTitle() {
    return tMain('ui')('localData.exportTitle')
  },
  get resetAlreadyInProgress() {
    return tMain('ui')('localData.resetAlreadyInProgress')
  },
  get resetTitle() {
    return tMain('ui')('localData.resetTitle')
  },
  get resetMessage() {
    return tMain('ui')('localData.resetMessage')
  },
  get resetDetail() {
    return tMain('ui')('localData.resetDetail')
  },
  get cancel() {
    return tMain('ui')('localData.cancel')
  },
  get resetCanceled() {
    return tMain('ui')('localData.resetCanceled')
  },
} as const
