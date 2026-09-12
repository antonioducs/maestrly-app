/** Mount the local desktop after locale initialization. Sound playback belongs to this primary window. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { i18n, initRendererI18n } from './lib/i18n'
import { initSoundPlayer } from './lib/sound-player'
import './styles.css'

initSoundPlayer()

void initRendererI18n().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>
  )
})
