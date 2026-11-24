import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resources } from '../../src/shared/i18n/resources'

function lookup(catalog: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)
}

describe('Maestro swarm renderer contract', () => {
  it('mounts the unified MaestroActivityPill in ChatView with subagentSessions and removes maestroRuns', () => {
    const view = readFileSync('src/renderer/components/chat/ChatView.tsx', 'utf8')
    expect(view).toContain('<MaestroActivityPill conversationId={conversationId} subagentSessions={subagentSessions} />')
    expect(view).not.toContain('maestroRuns')
    expect(view).not.toContain('type MaestroRun')
    expect(view).not.toContain("from './OrchestrationRun'")
  })

  it('implements the unified swarm + subagents activity pill with stop confirmation and row navigation', () => {
    const pill = readFileSync('src/renderer/components/chat/MaestroActivityPill.tsx', 'utf8')
    expect(pill).toContain('useMaestroSwarm(')
    expect(pill).toContain("t('maestro.swarm.title')")
    expect(pill).toContain("t('maestro.swarm.progress'")
    expect(pill).toContain("t('maestro.swarm.stop')")
    expect(pill).toContain("t('maestro.swarm.confirmStop')")
    expect(pill).toContain("t('maestro.swarm.subagents')")
    expect(pill).toContain('ownerWindow.confirm(')
    expect(pill).toContain('chatMaestroSwarmStop(')
    expect(pill).toContain('openConversationById(')
    expect(pill).toContain('SubagentActivityList')
    expect(pill).not.toContain('OrchestrationGroups')
    expect(pill).not.toContain('maestro.run.')
  })

  it('extracts SubagentActivityList from SubagentActivityPill for reuse by both pills', () => {
    const subagentPill = readFileSync('src/renderer/components/chat/SubagentActivityPill.tsx', 'utf8')
    expect(subagentPill).toContain('export function SubagentActivityList(')
    expect(subagentPill).toContain('<SubagentActivityList')
  })

  it('provides useMaestroSwarm and useMaestroSwarmPhases hooks wired to host swarm APIs', () => {
    const hook = readFileSync('src/renderer/lib/use-maestro-swarm.ts', 'utf8')
    expect(hook).toContain('export function useMaestroSwarm(')
    expect(hook).toContain('export function useMaestroSwarmPhases(')
    expect(hook).toContain('chatMaestroSwarmGet')
    expect(hook).toContain('onMaestroSwarmChanged')
    expect(hook).not.toContain('window.api.')
  })

  it('renders SwarmPhaseBadge in Maestro dispatch folder child rows and fetches phases at the list level', () => {
    const badge = readFileSync('src/renderer/components/sidebar/SwarmPhaseBadge.tsx', 'utf8')
    const rows = readFileSync('src/renderer/components/sidebar/conv-rows.tsx', 'utf8')
    const list = readFileSync('src/renderer/components/sidebar/WorkspaceConvList.tsx', 'utf8')

    expect(badge).toContain('export function SwarmPhaseBadge(')
    expect(badge).toContain('maestro.swarm.phase.changesReview')
    expect(badge).toContain('maestro.swarm.phase.changesConflict')
    expect(rows).toContain('SwarmPhaseBadge')
    expect(rows).not.toContain('useMaestroSwarmPhases(')
    expect(list).toContain('useMaestroSwarmPhases(')
  })

  it('defines every maestro.swarm i18n key in both en and pt-BR chat catalogs', () => {
    const requiredKeys: Record<string, { en: string; ptBR: string }> = {
      'maestro.swarm.title': { en: 'Swarm', ptBR: 'Swarm' },
      'maestro.swarm.progress': { en: '{{merged}}/{{total}} merged', ptBR: '{{merged}}/{{total}} integradas' },
      'maestro.swarm.subagents': { en: 'Subagents', ptBR: 'Subagentes' },
      'maestro.swarm.subagentsCount_one': { en: '{{count}} subagent', ptBR: '{{count}} subagente' },
      'maestro.swarm.subagentsCount_other': { en: '{{count}} subagents', ptBR: '{{count}} subagentes' },
      'maestro.swarm.stop': { en: 'Stop swarm', ptBR: 'Parar swarm' },
      'maestro.swarm.confirmStop': {
        en: 'Stop the orchestrator and every running worker conversation?',
        ptBR: 'Parar a orquestradora e todas as conversas de worker em andamento?',
      },
      'maestro.swarm.phase.queued': { en: 'queued', ptBR: 'fila' },
      'maestro.swarm.phase.implementing': { en: 'implementing', ptBR: 'implementando' },
      'maestro.swarm.phase.delivered': { en: 'delivered', ptBR: 'entregue' },
      'maestro.swarm.phase.reviewing': { en: 'review', ptBR: 'review' },
      'maestro.swarm.phase.changesReview': { en: 'changes r{{round}}', ptBR: 'ajuste r{{round}}' },
      'maestro.swarm.phase.changesConflict': { en: 'conflict', ptBR: 'conflito' },
      'maestro.swarm.phase.merged': { en: 'merged', ptBR: 'merged' },
      'maestro.swarm.phase.blocked': { en: 'blocked', ptBR: 'bloqueado' },
      'maestro.swarm.phase.failed': { en: 'failed', ptBR: 'falhou' },
    }

    for (const [key, expected] of Object.entries(requiredKeys)) {
      expect(lookup(resources.en.chat, key), `en ${key}`).toBe(expected.en)
      expect(lookup(resources['pt-BR'].chat, key), `pt-BR ${key}`).toBe(expected.ptBR)
    }
  })
})
