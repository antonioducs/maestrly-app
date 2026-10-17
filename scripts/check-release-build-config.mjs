#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Public identifiers that release packages embed at build time. Each comes from a GitHub Actions repository
 * variable, not a secret: the value ships inside the app. A package built without one ships a feature that can
 * never work, which is how v0.20.0 shipped GitHub Copilot, so releases refuse to build without them.
 */
export const RELEASE_BUILD_INPUTS = Object.freeze([
  Object.freeze({
    env: 'MAIN_VITE_GITHUB_COPILOT_CLIENT_ID',
    variable: 'MAESTRLY_GITHUB_COPILOT_CLIENT_ID',
    purpose: 'client ID of the Maestrly GitHub OAuth App (Device Flow enabled) used for GitHub Copilot sign-in',
    // GitHub client IDs have 20 characters (legacy hex, `Ov23…`, `Iv1.…`, `Iv23…`). The shape also rejects a
    // pasted client secret (40 hex characters) or token, which must never be embedded in the app.
    pattern: /^[A-Za-z0-9.]{20}$/,
  }),
])

/** Problems with the build environment, as messages that name the variable to fix. */
export function releaseBuildConfigErrors(env) {
  const errors = []
  for (const input of RELEASE_BUILD_INPUTS) {
    const value = env[input.env] ?? ''
    if (!value.trim()) {
      errors.push(
        `${input.env} is empty. Set the GitHub Actions repository variable ${input.variable} to the ${input.purpose}.`
      )
    } else if (!input.pattern.test(value)) {
      errors.push(
        `${input.env} is not a GitHub client ID (expected 20 letters, digits, or dots without whitespace). ` +
          `Check the repository variable ${input.variable}; it must hold the client ID, never the client secret.`
      )
    }
  }
  return errors
}

function javaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.[cm]?js$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
}

/** Build inputs whose value is absent from the built main-process bundle. */
export function bundleMissingInputs(bundleDir, env) {
  const sources = javaScriptFiles(bundleDir).map((file) => readFileSync(file, 'utf8'))
  if (sources.length === 0) throw new Error(`No JavaScript files found in ${bundleDir}`)
  return RELEASE_BUILD_INPUTS.filter((input) => !sources.some((source) => source.includes(env[input.env])))
}

function main() {
  const args = process.argv.slice(2)
  const bundleIndex = args.indexOf('--bundle')
  const bundleDir = bundleIndex === -1 ? null : args[bundleIndex + 1]
  if ((bundleIndex !== -1 && !bundleDir) || args.length !== (bundleIndex === -1 ? 0 : 2)) {
    throw new Error('Usage: check-release-build-config.mjs [--bundle <built main-process directory>]')
  }

  const errors = releaseBuildConfigErrors(process.env)
  if (errors.length === 0 && bundleDir) {
    for (const input of bundleMissingInputs(bundleDir, process.env)) {
      errors.push(`${input.env} is set but was not embedded in ${bundleDir}; check how the main process reads it.`)
    }
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[release-build-config] ${error}`)
    process.exitCode = 1
    return
  }
  const scope = bundleDir ? `embedded in ${bundleDir}` : 'present'
  for (const input of RELEASE_BUILD_INPUTS) console.log(`[release-build-config] ${input.env} is ${scope}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`[release-build-config] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
