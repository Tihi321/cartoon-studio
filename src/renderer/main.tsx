import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { connectEngine } from './api'
import { applyScheme, readScheme } from './lib/scheme'
import './styles.css'
import './studio.css'

applyScheme(readScheme())
if (window.cartoonstudio) connectEngine()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
