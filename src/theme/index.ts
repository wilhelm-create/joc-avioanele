export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'avioane_theme'
const listeners = new Set<() => void>()

let current: Theme = 'dark'

function detectInitial(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* ignore */
  }
  try {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light'
  } catch {
    /* ignore */
  }
  return 'dark'
}

export function initTheme() {
  current = detectInitial()
  applyTheme()
}

export function getTheme(): Theme {
  return current
}

export function setTheme(theme: Theme) {
  if (theme === current) return
  current = theme
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* ignore */
  }
  applyTheme()
  for (const fn of listeners) fn()
}

export function toggleTheme(): Theme {
  setTheme(current === 'dark' ? 'light' : 'dark')
  return current
}

export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function applyTheme() {
  const root = document.documentElement
  root.dataset.theme = current
  root.style.colorScheme = current
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', current === 'light' ? '#f6f1ea' : '#1c2438')
  }
  const scheme = document.querySelector('meta[name="color-scheme"]')
  if (scheme) scheme.setAttribute('content', current)
}
