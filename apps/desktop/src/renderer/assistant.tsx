/** Third renderer: the floating assistant window, opened from the global shortcut, the tray or the command line. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { AssistantApp } from '@/components/assistant/AssistantApp'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { i18n, initRendererI18n } from './lib/i18n'
import './styles.css'

void initRendererI18n().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <AssistantApp />
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>
  )
})
