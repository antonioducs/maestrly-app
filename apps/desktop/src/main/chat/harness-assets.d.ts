/**
 * Minimal declarations for the bundler-provided glob/raw imports used by the harness catalog.
 * The main process tsconfig does not pull in `vite/client`, and the renderer must not depend on it.
 */
interface ImportMeta {
  glob<T = string>(
    patterns: string | readonly string[],
    options: { eager: true; query?: string; import?: string }
  ): Record<string, T>
}
