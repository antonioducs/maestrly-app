import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { useChatUi } from '../provider'

export function CopyButton({ text }: { text: string }) {
  const { labels } = useChatUi()
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      title={done ? labels.copied : labels.copy}
      aria-label={labels.copy}
      data-copy-button
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
      className="rounded p-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}
