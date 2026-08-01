import './style.css'
import { initI18n } from './i18n'
import { mountApp } from './ui/app'

initI18n()

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('#app missing')
void mountApp(root)
