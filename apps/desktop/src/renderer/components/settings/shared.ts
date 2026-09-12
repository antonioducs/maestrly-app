import type { useTranslation } from 'react-i18next'

export type TFn = ReturnType<typeof useTranslation>['t']
