import type { GenUiWidgetIssueKind } from '../../shared/genui-widget'

/**
 * A problem found in a generated interface, which its author wrote without seeing it. The frame reports what it finds
 * in inline HTML; a native program reports what the parser and the evaluator dropped: invalid calls, names used but
 * never defined, statements defined but never shown, and props whose evaluation failed.
 */
export type GenUiIssueKind = GenUiWidgetIssueKind | 'invalid' | 'undefined' | 'unused' | 'runtime'

export interface GenUiIssue {
  kind: GenUiIssueKind
  detail: string
}

/** Most issues one interface lists. */
export const MAX_GENUI_ISSUES = 20

/** Adds an issue unless the same one is already listed or the list is full; returns the same list when unchanged. */
export function addGenUiIssue(issues: readonly GenUiIssue[], issue: GenUiIssue): readonly GenUiIssue[] {
  if (issues.length >= MAX_GENUI_ISSUES) return issues
  if (issues.some((item) => item.kind === issue.kind && item.detail === issue.detail)) return issues
  return [...issues, issue]
}
