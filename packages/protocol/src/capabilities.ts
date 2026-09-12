import { z } from 'zod'

export const PROTOCOL_VERSION = '1.0'
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const

export const instanceMetadataSchema = z.object({
  instanceId: z.string().min(1).max(191),
  name: z.string().min(1).max(160),
  canonicalUrl: z.string().url(),
  apiVersion: z.literal('v1'),
  protocolVersions: z.array(z.string().min(1)).min(1),
  authentication: z.object({
    localAccounts: z.boolean(),
    publicSignup: z.boolean(),
    deviceAuthorization: z.boolean(),
    desktopClientId:z.string().optional(),
  }),
})

export const protocolHeaderSchema = z.object({
  protocolVersion: z.string().min(1),
})

export function supportsProtocol(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)
}

export type InstanceMetadata = z.infer<typeof instanceMetadataSchema>
