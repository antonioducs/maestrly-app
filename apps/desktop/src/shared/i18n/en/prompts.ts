export default {

  planBroker: {
    approvedWithEdits:
      'PLAN APPROVED WITH EDITS by the user. This is the FINAL approved version — implement it ' +
      'now exactly as it stands; DO NOT call review_plan again and do NOT re-plan:\n\n{{edited}}',
    implementApprovedPlan:
      'Implement the FINAL approved plan included inline below. It is context supplied directly by Maestrly and does ' +
      'NOT exist as a file in the worktree. Do not search for or try to open approved-plan.md. Follow the plan exactly, ' +
      'do not re-plan or call review_plan again, and verify the implementation before finishing.\n\n' +
      '<approved_plan>\n{{plan}}\n</approved_plan>',
    decisionTurnFailed:
      'Could not start the turn for your plan decision ({{reason}}). Nothing was changed — send a message to try again.',
    approved: 'PLAN APPROVED by the user. Implement it now exactly as planned. ' + 'DO NOT call review_plan again.',
    discarded: 'The user DISCARDED this plan. Stop and wait for new instructions — do not implement anything.',
    cancelledReplaced: 'Plan replaced by a new version sent for review.',
    cancelledClosed: 'Plan review cancelled (conversation ended).',
    cancelledTimedOut:
      'Plan review timed out after {{min}} min. Stop and wait for new instructions — do not implement anything.',
    feedbackIntro:
      'The user reviewed the plan and asked for adjustments. Redo the plan taking the feedback below into ' +
      'account and call review_plan again with the revised version.',
    feedbackGeneralHeading: '## General comment',
    feedbackLineHeading: '## Comments on specific passages',
    feedbackLineItem: 'On “{{ref}}”: {{text}}',
    feedbackLineFallback: '(line {{line}})',
    feedbackEditedHeading: '## Version edited by the user (use as a base)',
  },

  // ---- review-loop.ts (internal turn + auditable summary of the automatic review loop) ----
  reviewLoop: {
    pairedReviewerRound:
      'Review the current code checkout afresh. Use git_diff, at least one grep or glob, and read before ' +
      'calling submit_review exactly once. Stay read-only and do not infer the decision from prose.',
    pairedImplementFindings:
      'Implement the structured review findings for correction {{iteration}} of {{max}}. Do not create a plan; ' +
      'apply the findings directly, run relevant checks, and verify the changes before finishing.',
    implementFindings:
      'Implement now the findings of round {{iteration}}/{{max}} of the automatic review, attached as ' +
      'review-loop-findings.md. Treat them as the specification of this round: implement the actionable ' +
      'findings directly; DO NOT produce a plan or call review_plan; inspect the implementation and related ' +
      'contracts before changing anything; make minimal and complete changes; run the relevant checks ' +
      'available to you (tests/lint/typecheck); if a finding is invalid, do not force a change — explain ' +
      'with evidence in the final summary; do not commit, push or change anything outside the scope of the ' +
      'findings; finish with a summary of the changes and validations.',
    findingsHeading: 'Review loop — round {{iteration}}/{{max}}',
    findingsSection: 'Findings ({{count}})',
    reviewerNotes: 'Reviewer notes',
    summaryHeading: 'Automatic review finished',
    summaryResult: 'Result',
    summaryRounds: 'Rounds executed',
    summaryDuration: 'Duration',
    summaryBaseline: 'Initial fingerprint (workspace)',
    summaryFinal: 'Final fingerprint (workspace)',
    summaryStopReason: 'Stop reason',
    summaryReviewer: 'Reviewer summary',
    summaryRemaining: 'Remaining findings',
    summaryRemainingCount:
      '{{total}} in total ({{blocking}} blocking, {{important}} important, {{optional}} optional):',
    summaryRemainingNone: 'None reported.',
    summaryChecks: 'Checks executed through the bridge',
    summaryChecksNone: 'None.',
    resultClean: 'clean',
    resultMaxIterations: 'iteration limit reached',
    resultNoProgress: 'no progress',
    resultFailed: 'failed',
    resultCancelled: 'cancelled',
    reasonExecutorUnavailable: 'executor unavailable',
    reasonWorkspaceChanged: 'workspace changed externally',
    reasonSessionEnded: 'session ended',
    reasonInterrupted: 'interrupted',
  },

  // ---- memory-service.ts (legacy wrapper/header retained for compatibility) ----

  memory: {
    cursorRuleDescription: 'Project memory (managed by Maestrly)',
  },

  drawerPreference: {
    directive:
      "Tool preference (this app): you have DRAWER tools whose results show up in the conversation's drawer, where the user can watch and edit them — {{drawerToolExamples}}. PREFER them over your own shell, your own memory (CLAUDE.md/AGENTS.md) or scratch files whenever the user should see, follow or edit the result: running a server, a long build or a script, or recording a decision or a durable project rule. A quick internal one-off (e.g. git status) can stay in your own shell, and your own memory/files are fine when the user asks or for anything these tools don't cover. This is a default to lean toward, not a hard rule.",
    drawerToolExamplesWithNotes:
      'terminal_* (run commands in drawer terminals), memory_* (durable PROJECT memory) and notes_* (notebook)',
    drawerToolExamplesWithoutNotes:
      'terminal_* (run commands in drawer terminals) and memory_* (durable PROJECT memory)',

    cursorRuleDescription: 'Maestrly drawer-tools preference',
  },
} as const
