import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import '@fontsource-variable/bricolage-grotesque/standard.css'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import './styles/theme.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
