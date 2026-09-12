export function automationMayTrigger(input: {
  changedColumn: boolean
  source: 'human' | 'agent' | 'system'
  allowAutomationChain: boolean
  chainDepth: number
}): boolean {
  if (!input.changedColumn) return false
  if (input.source !== 'agent') return true
  return input.allowAutomationChain && input.chainDepth < 5
}
