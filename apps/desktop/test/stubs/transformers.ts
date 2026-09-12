/**
 * Stub for `@xenova/transformers` (downloads large ONNX models), mapped through `resolve.alias`.
 * Local-embedding tests mock the utility process; this prevents the real package from loading if a
 * transitive import escapes those mocks.
 */
export const pipeline = (): never => {
  throw new Error('[test] @xenova/transformers is unavailable under Vitest (stub)')
}
export const env = { allowLocalModels: false, allowRemoteModels: false }
export default { pipeline, env }
