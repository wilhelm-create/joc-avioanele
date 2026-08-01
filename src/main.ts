import './style.css'
import { mountApp } from './ui/app'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('#app missing')
void mountApp(root)
