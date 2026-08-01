import './style.css'
import { mountApp } from './ui/app'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('#app missing')
mountApp(root)

// PWA: register SW when available
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // vite-plugin-pwa injects virtual module in build; safe dynamic import
    import('virtual:pwa-register')
      .then(({ registerSW }) => {
        registerSW({ immediate: true })
      })
      .catch(() => {
        /* dev without SW */
      })
  })
}
