import { useTranslation } from 'react-i18next'
import { ChoiceMark } from '@/components/fleet/ChoiceMark'
import { Button } from '@/components/ui/button'
import { choiceClass } from '@/lib/fleet/choice'
import { cn } from '@/lib/utils'

export function BotServerChoice({ onChoose }: { onChoose: (choice: 'local' | 'remote' | 'manual') => void }) {
  const { t } = useTranslation('fleet')
  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">{t('botServer.choice.heading')}</h3>
      <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label={t('botServer.choice.heading')}>
        {(['local', 'remote'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => onChoose(choice)}
            className={cn(
              'flex min-h-28 items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              choiceClass(false)
            )}
          >
            <ChoiceMark selected={false} />
            <span>
              <strong className="block text-sm text-foreground">{t(`botServer.choice.${choice}Title`)}</strong>
              <span className="mt-1 block text-xs leading-relaxed">{t(`botServer.choice.${choice}Note`)}</span>
            </span>
          </button>
        ))}
      </div>
      <Button variant="link" className="px-0" onClick={() => onChoose('manual')}>
        {t('botServer.choice.manual')}
      </Button>
    </div>
  )
}
