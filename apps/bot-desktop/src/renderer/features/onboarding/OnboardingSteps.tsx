import { Check } from 'lucide-react'
import { useT } from '../../i18n'
export function OnboardingSteps({ current }: { current: number }) {
  const t = useT()
  return <ol className="onboarding-steps" aria-label={t('setupStages')}>
    {[t('botIdentity'), t('environment'), t('model')].map((label, index) =>
      <li key={label} aria-current={index === current ? 'step' : undefined} className={index < current ? 'complete' : ''}>
        <span>{index < current ? <Check size={12} aria-hidden="true" /> : index + 1}</span>{label}
      </li>)}
  </ol>
}
