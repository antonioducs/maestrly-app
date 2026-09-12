import { z } from 'zod'
import { projectRoleSchema } from './identity.js'
export const teamChangeSchema = z.object({ expectedVersion: z.number().int().positive() })
export const memberChangeSchema = teamChangeSchema
  .extend({ userId: z.string().min(1).max(191), role: projectRoleSchema.nullable() })
  .strict()
export const projectInvitationInputSchema = teamChangeSchema
  .extend({
    email: z.string().trim().email().max(254),
    role: projectRoleSchema,
    expiresInHours: z.number().int().min(1).max(168).default(24),
  })
  .strict()
export interface TeamMember {
  userId: string
  name: string
  email: string
  role: 'viewer' | 'contributor' | 'maintainer' | null
  organizationRole: 'owner' | 'admin' | 'member'
  inherited: boolean
}
export interface ProjectInvitation {
  id: string
  email: string
  role: 'viewer' | 'contributor' | 'maintainer'
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
  createdAt: string
  expiresAt: string
  createdBy: string
}
export interface ProjectTeam {
  version: number
  canManage: boolean
  members: TeamMember[]
  candidates: TeamMember[]
  invitations: ProjectInvitation[]
  history: Array<{ id: string; type: string; actorName: string; createdAt: string; data: Record<string, unknown> }>
}
