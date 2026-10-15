import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/inter/900.css'
import './index.css'
import App from './App'

createRoot(document.getElementById('root')!).render(<App />)

// gancho para testes automatizados e depuração (F12)
import * as actions from './actions'
import { useEditor } from './state/store'
import * as commands from './state/commands'
import * as defaults from './state/defaults'
import * as topbar from './ui/TopBar'
;(window as unknown as Record<string, unknown>).__ed = { store: useEditor, actions, commands, defaults, topbar }
