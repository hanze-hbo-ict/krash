import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles/tokens.css'
import './styles/layout.css'

// No <StrictMode>: its double-invoked effects would boot two workers and race
// for the session lock in development. The boot effect is intentionally once-only.
createRoot(document.getElementById('root')!).render(<App />)
