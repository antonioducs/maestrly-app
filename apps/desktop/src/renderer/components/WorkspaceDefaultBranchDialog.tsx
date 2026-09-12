import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { BranchCombo } from '@/components/ui/branch-combo'

export function WorkspaceDefaultBranchDialog({
  workspaceId,
  workspaceName,
  currentDefault,
  open,
  onOpenChange,
  onSaved,
}: {
  workspaceId: string | null
  workspaceName?: string
  currentDefault: string
  open: boolean
  onOpenChange: (open: boolean) => void

  onSaved: () => void
}) {
  const { t } = useTranslation('ui')
  const [draft, setDraft] = useState(currentDefault)
  const [branches, setBranches] = useState<{ local: string[]; remote: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !workspaceId) return
    setDraft(currentDefault)
    setError(null)
    setBranches(null)
    let alive = true
    window.api
      .getBranches(workspaceId)
      .then((info) => {
        if (alive) setBranches({ local: info.local, remote: info.remote })
      })
      .catch(() => {
        if (alive) setBranches({ local: [], remote: [] })
      })
    return () => {
      alive = false
    }
  }, [open, workspaceId, currentDefault])

  const suggestions = useMemo(() => (branches ? [...new Set([...branches.local, ...branches.remote])] : []), [branches])
  const trimmed = draft.trim()

  const unknown = !!branches && !!trimmed && !suggestions.includes(trimmed)

  const refresh = async () => {
    if (!workspaceId) return
    try {
      const info = await window.api.fetchBranches(workspaceId)
      setBranches({ local: info.local, remote: info.remote })
    } catch (e) {
      console.error('[workspace] Failed to fetch branches:', e)
    }
  }

  const save = async () => {
    if (!workspaceId || !trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.api.setWorkspaceDefaultBranch(workspaceId, trimmed)
      onSaved()
      onOpenChange(false)
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4 shrink-0 text-muted-foreground" />
            {t('workspaceBranch.title')}
          </DialogTitle>
          <DialogDescription>
            {workspaceName ? t('workspaceBranch.descNamed', { name: workspaceName }) : t('workspaceBranch.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5 py-1">
          <Label>{t('workspaceBranch.label')}</Label>
          <BranchCombo
            value={draft}
            onChange={setDraft}
            suggestions={suggestions}
            invalid={unknown}
            placeholder={t('workspaceBranch.placeholder')}
            autoFocus
            onRefresh={refresh}
          />
          {unknown && (
            <p className="text-[11px] leading-snug text-amber-300/80">{t('workspaceBranch.unknownWarning')}</p>
          )}
          {error && <p className="text-[11px] leading-snug text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy || !trimmed}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
