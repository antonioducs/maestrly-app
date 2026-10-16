#!/usr/bin/env node
// Sends the app's version (package.json) to App Review with a build EAS uploaded for it: waits until App Store Connect
// has processed the build, attaches it to the version and submits the version. `eas metadata:push` creates the version
// and its listing first (store.config.cjs). It needs an App Store Connect team key with the Admin or App Manager role:
// ASC_API_KEY (the .p8 file's contents, or their base64), ASC_API_KEY_ID and ASC_API_ISSUER.
//   node scripts/submit-for-review.mjs [--build <build number>] [--wait-minutes <minutes>]
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const appId = JSON.parse(readFileSync(path.join(root, 'eas.json'), 'utf8')).submit.production.ios.ascAppId
const { values: args } = parseArgs({ options: { build: { type: 'string' }, 'wait-minutes': { type: 'string', default: '60' } } })
/** Versions App Store Connect still lets you change and submit; READY_FOR_REVIEW is in a submission not yet sent. */
const EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
])

function fail(message) {
  console.error(message)
  process.exit(1)
}

const env = (name) => process.env[name]?.trim() || fail(`Set ${name}.`)
const keyId = env('ASC_API_KEY_ID')
const issuer = env('ASC_API_ISSUER')
const encoded = env('ASC_API_KEY')
const key = createPrivateKey(encoded.includes('PRIVATE KEY') ? encoded : Buffer.from(encoded, 'base64').toString('utf8'))

/** A token for App Store Connect, valid for 20 minutes (its maximum). */
function token() {
  const now = Math.floor(Date.now() / 1000)
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${part({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${part({ iss: issuer, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

async function api(method, pathname, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = response.status === 204 ? null : await response.json()
  if (!response.ok) {
    // What keeps a version from review (a missing answer or field) comes in each error's associated errors.
    const lines = (json?.errors ?? []).flatMap((error) => [
      `- ${error.title}: ${error.detail}`,
      ...Object.values(error.meta?.associatedErrors ?? {})
        .flat()
        .map((associated) => `  - ${associated.detail ?? associated.title}`),
    ])
    fail(`App Store Connect refused ${method} ${pathname.split('?')[0]} (${response.status}):\n${lines.join('\n')}`)
  }
  return json
}

const versions = await api('GET', `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${version}`)
const appVersion = versions.data[0] ?? fail(`App Store Connect has no version ${version}. Push the listing first.`)
const state = appVersion.attributes.appStoreState
if (!EDITABLE.has(state)) fail(`Version ${version} is ${state} and cannot be submitted.`)

// The build asked for, or the newest one of this version, once App Store Connect has processed it.
const query = new URLSearchParams({
  'filter[app]': appId,
  'filter[preReleaseVersion.version]': version,
  'filter[preReleaseVersion.platform]': 'IOS',
  sort: '-uploadedDate',
  limit: '1',
})
if (args.build) query.set('filter[version]', args.build)
const deadline = Date.now() + Number(args['wait-minutes']) * 60_000
let build
for (;;) {
  build = (await api('GET', `/v1/builds?${query}`)).data[0]
  const processing = build?.attributes.processingState
  if (processing === 'VALID' && !build.attributes.expired) break
  if (processing === 'FAILED' || processing === 'INVALID' || build?.attributes.expired)
    fail(`Build ${build.attributes.version} of ${version} is ${build.attributes.expired ? 'expired' : processing}.`)
  if (Date.now() > deadline) fail(`App Store Connect had not processed a build of ${version} in ${args['wait-minutes']} minutes.`)
  console.log(build ? `Build ${build.attributes.version} is ${processing}; waiting…` : `No build of ${version} yet; waiting…`)
  await new Promise((resolve) => setTimeout(resolve, 30_000))
}

await api('PATCH', `/v1/appStoreVersions/${appVersion.id}/relationships/build`, { data: { type: 'builds', id: build.id } })

// A submission left unsent by an earlier run is reused: an app has at most one per platform.
const drafts = await api('GET', `/v1/reviewSubmissions?filter[app]=${appId}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`)
const submission =
  drafts.data[0] ??
  (
    await api('POST', '/v1/reviewSubmissions', {
      data: { type: 'reviewSubmissions', attributes: { platform: 'IOS' }, relationships: { app: { data: { type: 'apps', id: appId } } } },
    })
  ).data
const items = await api('GET', `/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion`)
if (!items.data.some((item) => item.relationships?.appStoreVersion?.data?.id === appVersion.id)) {
  await api('POST', '/v1/reviewSubmissionItems', {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: appVersion.id } },
      },
    },
  })
}
await api('PATCH', `/v1/reviewSubmissions/${submission.id}`, {
  data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } },
})
console.log(`Submitted ${version} (${build.attributes.version}) to App Review.`)
