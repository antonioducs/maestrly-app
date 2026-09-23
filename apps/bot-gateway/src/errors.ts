import { FLEET_ERROR_STATUS, type FleetErrorCode } from '@maestrly/bot-fleet-protocol'

export class GatewayError extends Error {
  readonly status: number
  constructor(
    readonly code: FleetErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.status = FLEET_ERROR_STATUS[code]
  }
}
export function failure(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  return new GatewayError('INTERNAL', 'Internal gateway error')
}
