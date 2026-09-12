/**
 * Stub for `@xterm/headless` (used by mcp-server/screen-tracker), mapped through `resolve.alias`.
 * Phase 1 tests do not start the MCP server; this stub safeguards transitive imports.
 */
export class Terminal {
  constructor(_opts?: unknown) {}
  write(): void {}
  resize(): void {}
  dispose(): void {}
}
export default { Terminal }
