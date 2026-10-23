#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowlistPath = path.join(root, 'config', 'npm-audit-allowlist.json')
const ADVISORY_URL = /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function advisoryId(url) {
  if (typeof url !== 'string') return null
  return ADVISORY_URL.exec(url)?.[1] ?? null
}

// An exception covers one advisory on one package at one exact path, so the same advisory can be accepted at several
// paths only by listing each of them, each with its own reason and expiry.
function exceptionKey({ id, package: packageName, path: nodePath }) {
  return `${id}\0${packageName}\0${nodePath}`
}

function validDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function validateAllowlist(allowlist, failures) {
  if (!isRecord(allowlist) || allowlist.schema !== 1 || !Array.isArray(allowlist.exceptions)) {
    failures.push('allowlist must use schema 1 and contain an exceptions array')
    return []
  }

  const normalized = []
  const seen = new Set()
  for (const [index, exception] of allowlist.exceptions.entries()) {
    const label = `exception ${index + 1}`
    if (!isRecord(exception)) {
      failures.push(`${label} must be an object`)
      continue
    }
    const packageName = typeof exception.package === 'string' ? exception.package.trim() : ''
    const nodePath = typeof exception.path === 'string' ? exception.path.trim() : ''
    const reason = typeof exception.reason === 'string' ? exception.reason.trim() : ''
    const expiresOn = exception.expiresOn
    const advisories = Array.isArray(exception.advisories) ? exception.advisories : []
    if (!packageName) failures.push(`${label} requires a package`)
    if (!nodePath) failures.push(`${label} requires a path`)
    if (!reason) failures.push(`${label} requires a reason`)
    if (!validDate(expiresOn)) failures.push(`${label} requires an ISO expiresOn date`)
    if (advisories.length === 0) failures.push(`${label} requires at least one advisory`)

    for (const id of advisories) {
      if (typeof id !== 'string' || !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(id)) {
        failures.push(`${label} contains invalid advisory ${String(id)}`)
        continue
      }
      const key = exceptionKey({ id, package: packageName, path: nodePath })
      if (seen.has(key)) failures.push(`duplicate exception ${id} at ${nodePath}`)
      seen.add(key)
      normalized.push({ id, package: packageName, path: nodePath, reason, expiresOn })
    }
  }
  return normalized
}

function auditFindings(report, failures) {
  if (!isRecord(report)) {
    failures.push('audit report must be an object')
    return []
  }
  if (report.auditReportVersion !== 2 || !isRecord(report.vulnerabilities)) {
    failures.push('audit report must use version 2 and contain vulnerabilities')
    return []
  }

  const findings = []
  for (const [key, vulnerability] of Object.entries(report.vulnerabilities)) {
    if (!isRecord(vulnerability) || !Array.isArray(vulnerability.via)) {
      failures.push(`audit vulnerability ${key} is malformed`)
      continue
    }
    const packageName = typeof vulnerability.name === 'string' && vulnerability.name ? vulnerability.name : key
    const nodes = Array.isArray(vulnerability.nodes)
      ? vulnerability.nodes.filter((node) => typeof node === 'string' && node)
      : []
    for (const detail of vulnerability.via) {
      if (typeof detail === 'string') continue
      if (!isRecord(detail)) {
        failures.push(`audit vulnerability ${packageName} contains a malformed advisory`)
        continue
      }
      const id = advisoryId(detail.url)
      if (!id) {
        failures.push(`audit vulnerability ${packageName} contains an advisory without a canonical GHSA URL`)
        continue
      }
      if (nodes.length === 0) {
        findings.push({ id, package: packageName, path: '(missing node path)', severity: detail.severity })
        continue
      }
      for (const node of nodes) findings.push({ id, package: packageName, path: node, severity: detail.severity })
    }
  }
  return findings
}

export function evaluateAuditReport(report, allowlist, now = new Date()) {
  const failures = []
  const exceptions = validateAllowlist(allowlist, failures)
  const findings = auditFindings(report, failures)
  const accepted = []
  const observed = new Set()
  const uniqueFindings = new Map()
  for (const finding of findings) {
    uniqueFindings.set(`${finding.id}\0${finding.package}\0${finding.path}`, finding)
  }

  for (const finding of uniqueFindings.values()) {
    const exception = exceptions.find(
      (candidate) =>
        candidate.id === finding.id && candidate.package === finding.package && candidate.path === finding.path
    )
    if (!exception) {
      failures.push(`unapproved advisory ${finding.id} for ${finding.package} at ${finding.path}`)
      continue
    }
    observed.add(exceptionKey(exception))
    const expiry = new Date(`${exception.expiresOn}T00:00:00.000Z`)
    if (now.getTime() >= expiry.getTime()) {
      failures.push(`expired exception ${exception.id} (${exception.expiresOn})`)
      continue
    }
    accepted.push({ ...finding, reason: exception.reason, expiresOn: exception.expiresOn })
  }

  for (const exception of exceptions) {
    if (!observed.has(exceptionKey(exception))) failures.push(`stale exception ${exception.id} at ${exception.path}`)
  }

  accepted.sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path))
  failures.sort()
  return { accepted, failures }
}

function runAudit() {
  let allowlist
  try {
    allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  } catch (error) {
    throw new Error(`could not read ${path.relative(root, allowlistPath)}: ${error.message}`)
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(npm, ['audit', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    shell: false,
  })
  if (result.error) throw new Error(`npm audit could not start: ${result.error.message}`)
  if (result.status === null || result.status > 1) {
    throw new Error(`npm audit failed operationally with status ${String(result.status)}: ${result.stderr.trim()}`)
  }
  if (!result.stdout.trim()) throw new Error('npm audit returned an empty report')

  let report
  try {
    report = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`npm audit returned malformed JSON: ${error.message}`)
  }
  const evaluation = evaluateAuditReport(report, allowlist)
  for (const finding of evaluation.accepted) {
    console.log(
      `[dependency-audit] accepted ${finding.id} for ${finding.package} at ${finding.path} until ${finding.expiresOn}`
    )
  }
  if (evaluation.failures.length > 0) throw new Error(evaluation.failures.join('\n'))
  console.log(`[dependency-audit] ok (${evaluation.accepted.length} reviewed exception(s))`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runAudit()
  } catch (error) {
    console.error(`[dependency-audit] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
