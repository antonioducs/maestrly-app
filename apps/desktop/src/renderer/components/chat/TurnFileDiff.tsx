import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHostApi } from '@/lib/hosts/host-context'
import { DiffLines, parseUnifiedDiff } from '@/components/ui/diff-view'
import type { TurnFilePatch } from '../../../shared/turn-snapshots'

/** One file's diff, loaded when it opens: what the turn did or, with a token, what confirming would do. */
export function TurnFileDiff({
  conversationId,
  recordId,
  file,
  token,
  unavailable = false,
}: {
  conversationId: string
  recordId: string
  file: { root: number; path: string }
  token?: string
  unavailable?: boolean
}) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const [patch, setPatch] = useState<TurnFilePatch | null | 'loading'>(unavailable ? null : 'loading')
  useEffect(() => {
    if (unavailable) return
    let alive = true
    setPatch('loading')
    api
      .turnSnapshotPatch({ conversationId, recordId, root: file.root, path: file.path, ...(token ? { token } : {}) })
      .then((value) => alive && setPatch(value))
      .catch(() => alive && setPatch(null))
    return () => {
      alive = false
    }
  }, [api, conversationId, recordId, file.root, file.path, token, unavailable])
  const lines = useMemo(
    () => (patch && patch !== 'loading' ? (parseUnifiedDiff(patch.patch)[0]?.lines ?? []) : []),
    [patch]
  )
  const note = (text: string) => <p className="px-2 pb-2 text-[12px] text-muted-foreground">{text}</p>
  if (patch === 'loading') return note(t('turnChanges.diffLoading'))
  if (!patch) return note(t('turnChanges.diffUnavailable'))
  if (patch.truncated) return note(t('turnChanges.diffTooLarge'))
  if (patch.binary) return note(t('turnChanges.binary'))
  const body = lines.filter((line) => line.kind !== 'meta')
  // The patch ends with a newline, which parses as one empty context line.
  while (body.length && body[body.length - 1]!.kind === 'ctx' && !body[body.length - 1]!.text) body.pop()
  if (!body.length) return note(t('turnChanges.diffUnavailable'))
  return <DiffLines lines={body} className="mx-2 mb-2 max-h-80 overflow-auto rounded border border-border" />
}
