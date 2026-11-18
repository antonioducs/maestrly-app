// What the top bar makes of the state before drawing it.
import type { ViewerState } from './contract.js'

/** Whether the reader has a version to choose: with only the current one, the bar shows no version controls. */
export const hasVersionChoice = (artifact: ViewerState['artifact']): boolean => artifact.versions.length > 1
