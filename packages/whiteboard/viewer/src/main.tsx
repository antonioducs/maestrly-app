import './asset-path'
import './focus-guard'
import '@excalidraw/excalidraw/index.css'
import './viewer.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
