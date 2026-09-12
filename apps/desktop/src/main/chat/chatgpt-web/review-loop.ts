/**
 * ChatGPT Web compatibility adapter for the generic review-loop core.
 *
 * Keep this module as the stable import surface for the bridge/manager. Concrete visual runtime types and
 * diagnostic formatting intentionally stop here; the controller remains usable by conversation drivers
 * without importing BrowserSurface or preview-runtime.
 */
import type { BrowserSurface, BrowserSurfaceInfo } from '../browser-surface'
import {
  createReviewLoopController as createCoreReviewLoopController,
  type ReviewLoopController as CoreReviewLoopController,
} from '../review-loop/controller'
import type {
  ReviewLoopControllerDeps,
  ReviewLoopEvidence,
  ReviewLoopVisualBrowser,
  ReviewLoopVisualInfo,
  ReviewLoopVisualPreview,
} from '../review-loop/types'
import { previewStartupErrorMessage, type PreviewHandle, type PreviewTarget } from './preview-runtime'

export * from '../review-loop/evidence'
export * from '../review-loop/types'
export * from '../review-loop/workspace'

/** Backward-compatible dependency name and bridge evidence hook. */
export type ReviewLoopDeps<
  TVisualInfo extends ReviewLoopVisualInfo = ReviewLoopVisualInfo,
  TVisualBrowser extends ReviewLoopVisualBrowser<TVisualInfo> = ReviewLoopVisualBrowser<TVisualInfo>,
  TVisualPreview extends ReviewLoopVisualPreview = ReviewLoopVisualPreview,
  TVisualTarget = unknown,
> = Omit<
  ReviewLoopControllerDeps<TVisualInfo, TVisualBrowser, TVisualPreview, TVisualTarget>,
  'formatVisualStartupError' | 'getReviewEvidence'
> & {
  getBridgeEvidence: (loopId: string) => ReviewLoopEvidence
}

export function createReviewLoopController<
  TVisualInfo extends ReviewLoopVisualInfo = ReviewLoopVisualInfo,
  TVisualBrowser extends ReviewLoopVisualBrowser<TVisualInfo> = ReviewLoopVisualBrowser<TVisualInfo>,
  TVisualPreview extends ReviewLoopVisualPreview = ReviewLoopVisualPreview,
  TVisualTarget = unknown,
>(deps: ReviewLoopDeps<TVisualInfo, TVisualBrowser, TVisualPreview, TVisualTarget>) {
  const { getBridgeEvidence, ...coreDeps } = deps
  return createCoreReviewLoopController<TVisualInfo, TVisualBrowser, TVisualPreview, TVisualTarget>({
    ...coreDeps,
    getReviewEvidence: getBridgeEvidence,
    formatVisualStartupError: previewStartupErrorMessage,
  })
}

/** Existing ChatGPT Web controller contract, specialized only at the adapter boundary. */
export type ReviewLoopController = CoreReviewLoopController<
  BrowserSurfaceInfo,
  BrowserSurface,
  PreviewHandle,
  PreviewTarget
>
