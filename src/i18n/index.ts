import { locales, type Lang } from './locales'

export type { Lang }

const STORAGE_KEY = 'avioane_lang'

let current: Lang = 'ro'
const listeners = new Set<() => void>()

function detectInitial(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'ro' || saved === 'en') return saved
  } catch {
    /* ignore */
  }
  try {
    const nav = (navigator.language || 'ro').toLowerCase()
    if (nav.startsWith('en')) return 'en'
  } catch {
    /* ignore */
  }
  return 'ro'
}

export function initI18n() {
  current = detectInitial()
  applyDocumentLang()
}

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang) {
  if (lang === current) return
  current = lang
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* ignore */
  }
  applyDocumentLang()
  for (const fn of listeners) fn()
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function applyDocumentLang() {
  try {
    document.documentElement.lang = current
    document.title = t('appName')
  } catch {
    /* ignore */
  }
}

/** Translate key with optional {param} interpolation */
export function t(key: string, params?: Record<string, string | number>): string {
  const table = locales[current] || locales.ro
  let s = table[key] ?? locales.ro[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v))
    }
  }
  return s
}

export function toggleLang(): Lang {
  setLang(current === 'ro' ? 'en' : 'ro')
  return current
}
