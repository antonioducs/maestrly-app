/**
 * Cursor SDK platform-package targets.
 *
 * @cursor/sdk@1.3.1 optionalDependencies ship native helpers per platform:
 *   bin/rg, bin/cursorsandbox, vendor/tree-sitter*
 * There is NO @cursor/sdk-win32-arm64 on npm for 1.3.1 — Windows ARM is a
 * hard product gap unless Cursor publishes it or we fall back to x64 emulation.
 *
 * Same host-only optionalDependency problem as GitHub Copilot: cross-build
 * (mac → win/linux) must materialize platform packages explicitly.
 */

export interface CursorSdkPlatformTarget {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  /** npm optional package name */
  npmPackage: string
  /** resources/cursor-sdk/<id>/ layout id (mirrors copilot materialization) */
  materializedId: string
  supported: boolean
  notes?: string
}

const TARGETS: readonly CursorSdkPlatformTarget[] = [
  {
    platform: 'darwin',
    arch: 'arm64',
    npmPackage: '@cursor/sdk-darwin-arm64',
    materializedId: 'mac-arm64',
    supported: true,
  },
  {
    platform: 'darwin',
    arch: 'x64',
    npmPackage: '@cursor/sdk-darwin-x64',
    materializedId: 'mac-x64',
    supported: true,
  },
  {
    platform: 'linux',
    arch: 'arm64',
    npmPackage: '@cursor/sdk-linux-arm64',
    materializedId: 'linux-arm64',
    supported: true,
  },
  {
    platform: 'linux',
    arch: 'x64',
    npmPackage: '@cursor/sdk-linux-x64',
    materializedId: 'linux-x64',
    supported: true,
  },
  {
    platform: 'win32',
    arch: 'x64',
    npmPackage: '@cursor/sdk-win32-x64',
    materializedId: 'win-x64',
    supported: true,
  },
  {
    platform: 'win32',
    arch: 'arm64',
    npmPackage: '@cursor/sdk-win32-arm64',
    materializedId: 'win-arm64',
    supported: false,
    notes:
      'Package does not exist on npm for @cursor/sdk@1.3.1 (404). Product must refuse win-arm64 or document x64-emulation fallback if/when viable.',
  },
]

/** Pinned SDK version. Keep in sync with package.json. */
export const CURSOR_SDK_VERSION = '1.3.1'

/**
 * Integrity hashes for platform optional packages at CURSOR_SDK_VERSION
 * (`npm view @cursor/sdk-<plat>@1.3.1 dist.integrity`, checked against downloaded bytes 2026-11-13).
 * Verified npm tarball integrity used for target materialization.
 */
export const CURSOR_SDK_PLATFORM_INTEGRITY: Readonly<Record<string, string>> = {
  'mac-arm64': 'sha512-5JXgVJYeFPxXjDqnu1ha/rAmH+ATFh4abdx199x8E/RcYYM++9b55oJXO3GYv1/9/4Qa9RsE5JkHRY6FYc5vQw==',
  'mac-x64': 'sha512-yHzIRER8IpOpIH/CUigquuwqvcjCEe62xV6OiJHzRfgApdnzxCjC8JMhLZP2M08/dofyZu9xeo7yr43H6oSRTA==',
  'linux-arm64': 'sha512-8wI7DUSQtJ7Rkyj5AhNONeR0M+5bjhR0qo8GJEEmRs6isi072sNPsFXwfhlzX7bhbtsX/FCtvsTG/vpam48ObA==',
  'linux-x64': 'sha512-jIwzTr3KhMtU4aJc8x0i1RlcBKttqcVYhor9FI/h1qJQm03yTgSwhyZjsMvfBHPQ5KoYDFVdu47S1dIhwaSWZA==',
  'win-x64': 'sha512-hqYllGgY27eaq+w035PebKdoc/JswcrvOSNCniqq/nicLXgWdK5zdKiAs5MyWUr73HGGL1sK0aiE7WdxbIKKVw==',
}

export function listCursorSdkPlatformTargets(): readonly CursorSdkPlatformTarget[] {
  return TARGETS
}

export function resolveCursorSdkPlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): CursorSdkPlatformTarget {
  const hit = TARGETS.find((t) => t.platform === platform && t.arch === arch)
  if (hit) return hit
  return {
    platform,
    arch,
    npmPackage: `@cursor/sdk-${platform}-${arch}`,
    materializedId: `${platform}-${arch}`,
    supported: false,
    notes: `No known @cursor/sdk platform package for ${platform}/${arch}.`,
  }
}

export function isCursorSdkPlatformSupported(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch
): boolean {
  return resolveCursorSdkPlatformTarget(platform, arch).supported
}

/** Approx unpacked sizes observed on host for packaging budget notes. */
export const CURSOR_SDK_SIZE_NOTES = {
  metaPackageMb: 26,
  platformPackageMb: '10–14',
  hostObserved: {
    meta: '~26MB (@cursor/sdk dist+deps)',
    'mac-arm64': '~10MB (rg 4.4M + cursorsandbox 3.4M + tree-sitter ~2.2M)',
  },
  engines: 'node >= 22.13 (SDK package.json engines)',
} as const
