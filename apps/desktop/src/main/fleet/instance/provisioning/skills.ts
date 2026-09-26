import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  fleetSkillNameSchema,
  type FleetBotSkills,
  type FleetSkillInstallRequest,
  type FleetSkillInstallResponse,
} from '@maestrly/bot-fleet-protocol'
import { listSkills } from '../../../chat/skills'
import {
  installSkillFiles,
  listInstalledSkillSources,
  removeGlobalSkill,
  skillFilesProblem,
} from '../../../chat/skills-registry'
import { measureSkillDirectory } from '../../../chat/skill-package'
import { InstanceHttpError } from '../server'

export async function listBotSkills(): Promise<FleetBotSkills> {
  const sources = listInstalledSkillSources()
  const skills = await listSkills('', os.homedir())
  return {
    skills: await Promise.all(
      skills
        .filter((skill) => skill.scope === 'global')
        .map(async (skill) => {
          const size = await measureSkillDirectory(skill.dir)
          return {
            name: skill.name,
            description: skill.description.slice(0, 1024),
            files: size.files,
            bytes: size.bytes,
            source:
              sources[skill.name] === 'fleet'
                ? ('fleet' as const)
                : sources[skill.name]
                  ? ('registry' as const)
                  : ('local' as const),
          }
        })
    ),
  }
}
export async function installBotSkill(request: FleetSkillInstallRequest): Promise<FleetSkillInstallResponse> {
  if (!fleetSkillNameSchema.safeParse(request.name).success)
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid skill name.')
  const files = request.files.map((file) => ({ ...file, data: Buffer.from(file.data, 'base64') }))
  const problem = skillFilesProblem(files)
  if (problem) throw new InstanceHttpError(400, 'INVALID_REQUEST', problem)
  // Discovery owns the frontmatter parser. Stage only the manifest to use exactly its name normalization.
  const home = await mkdtemp(path.join(os.tmpdir(), 'fleet-skill-name-'))
  try {
    const dir = path.join(home, '.agents', 'skills', request.name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), files.find((file) => file.path === 'SKILL.md')!.data)
    const discovered = await listSkills('', home)
    if (discovered.length !== 1 || discovered[0].name !== request.name)
      throw new InstanceHttpError(400, 'INVALID_REQUEST', 'The skill name does not match SKILL.md.')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
  const result = await installSkillFiles({ name: request.name, files, source: 'fleet' })
  return { name: request.name, outcome: result.outcome }
}
export async function removeBotSkill(name: string): Promise<void> {
  if (!fleetSkillNameSchema.safeParse(name).success)
    throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Invalid skill name.')
  if (!(await removeGlobalSkill(name, path.join(os.homedir(), '.agents', 'skills'))))
    throw new InstanceHttpError(404, 'NOT_FOUND', 'Skill does not exist.')
}
