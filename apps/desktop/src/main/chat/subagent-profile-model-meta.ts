import type { SubagentProfileModelMetaResult } from '../../shared/subagent-profile-effort'
import { subagentModelMeta } from './subagent-provider-runtime'

/** Same dynamic metadata as the main selector: exact provider, with canonical model-ID fallback. */
export async function getSubagentProfileModelMeta(
  providerId: string,
  modelId: string
): Promise<SubagentProfileModelMetaResult> {
  return subagentModelMeta(providerId, modelId)
}
