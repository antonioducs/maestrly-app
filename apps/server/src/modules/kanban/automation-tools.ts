import {
  restoreColumnAutomation,
  automationCatalog,
  previewAutomation,
  executionEvents,
  defineFixedColumns,
  getColumnAutomation,
  saveColumnAutomation,
  columnAutomationHistory,
  cardAutomationContext,
  saveCardOverride,
  releaseDispatch,
  saveBoardAutomationLimits,
} from '../automation/column-service.js'
import { requestColumnAgent } from '../automation/dispatch.js'
import { linkedBoardToolSchemas as schemas, type LinkedBoardToolName } from '@maestrly/protocol'
import type { DatabasePool } from '../../db/pool.js'
import type { Scope } from './service.js'

/** Dispatch automation services after linked-project authorization and inside the caller's idempotency boundary. */
export async function executeAutomationTool(
  pool: DatabasePool,
  s: Scope & { projectId: string },
  name: LinkedBoardToolName,
  body: unknown
) {
  switch (name) {
    case 'board_automation_catalog':
      return automationCatalog(pool, { ...s, ...schemas.board_automation_catalog.parse(body) })
    case 'board_column_config':
      return getColumnAutomation(pool, { ...s, ...schemas.board_column_config.parse(body) })
    case 'board_set_column_agent':
      return saveColumnAutomation(pool, { ...s, ...schemas.board_set_column_agent.parse(body) })
    case 'board_column_automation_history':
      return columnAutomationHistory(pool, { ...s, ...schemas.board_column_automation_history.parse(body) })
    case 'board_restore_column_automation':
      return restoreColumnAutomation(pool, { ...s, ...schemas.board_restore_column_automation.parse(body) })
    case 'board_preview_automation':
      return previewAutomation(pool, { ...s, ...schemas.board_preview_automation.parse(body) })
    case 'board_card_automation':
      return cardAutomationContext(pool, { ...s, ...schemas.board_card_automation.parse(body) })
    case 'board_set_card_automation_override':
      return saveCardOverride(pool, { ...s, ...schemas.board_set_card_automation_override.parse(body) })
    case 'board_run_card':
      return requestColumnAgent(pool, { ...s, ...schemas.board_run_card.parse(body) })
    case 'board_release_card_automation':
      return releaseDispatch(pool, { ...s, ...schemas.board_release_card_automation.parse(body) })
    case 'board_set_automation_limits':
      return saveBoardAutomationLimits(pool, { ...s, ...schemas.board_set_automation_limits.parse(body) })
    case 'board_define_fixed_columns':
      return defineFixedColumns(pool, { ...s, ...schemas.board_define_fixed_columns.parse(body) })
    case 'board_execution_events':
      return executionEvents(pool, { ...s, ...schemas.board_execution_events.parse(body) })
  }
}
