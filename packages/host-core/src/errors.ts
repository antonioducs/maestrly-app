export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}
