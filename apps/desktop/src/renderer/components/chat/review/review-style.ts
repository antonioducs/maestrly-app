import {
  BadgeCheck,
  Compass,
  FileText,
  GitCompare,
  Link2,
  ListChecks,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { ReviewActivity, ReviewDecision, ReviewLane, ReviewSeverity } from '../../../../shared/review'

/** One color per lane, used for its column, its marks on the evidence map and its candidates. */
export const LANE_STYLE: Record<ReviewLane, { color: string; icon: LucideIcon }> = {
  correctness: { color: '#7dd3fc', icon: Target },
  integration: { color: '#a78bfa', icon: Link2 },
  security: { color: '#f0abfc', icon: ShieldCheck },
  feasibility: { color: '#5eead4', icon: Compass },
  completeness: { color: '#c4b5fd', icon: ListChecks },
  verifier: { color: '#e4e4e7', icon: BadgeCheck },
}

export const ACTIVITY_ICON: Record<ReviewActivity['kind'], LucideIcon> = {
  diff: GitCompare,
  read: FileText,
  grep: Search,
  glob: Search,
  note: Sparkles,
  submit: Send,
  tool: Wrench,
}

export const SEVERITY_COLOR: Record<ReviewSeverity, string> = {
  blocking: '#f87171',
  important: '#fbbf24',
  minor: '#a1a1aa',
}

export const SEVERITY_PILL: Record<ReviewSeverity, string> = {
  blocking: 'border-red-400/30 bg-red-400/[0.1] text-red-300',
  important: 'border-amber-400/30 bg-amber-400/[0.1] text-amber-200',
  minor: 'border-white/[0.12] bg-white/[0.05] text-muted-foreground',
}

export const DECISION_CHIP: Record<ReviewDecision, string> = {
  fix: 'border-emerald-300/35 text-emerald-200',
  discuss: 'border-sky-300/35 text-sky-200',
  comment: 'border-teal-300/35 text-teal-200',
  dismiss: 'border-white/[0.12] text-muted-foreground',
}
