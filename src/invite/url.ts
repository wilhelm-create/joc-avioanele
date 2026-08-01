/** Invite deep-link helpers */

import { t } from '../i18n'

export function getInviteCodeFromLocation(): string | null {
  try {
    const u = new URL(window.location.href)
    const q = u.searchParams.get('room') || u.searchParams.get('c') || u.searchParams.get('cod')
    if (q && q.trim().length >= 4) return q.trim().toUpperCase()
    const m = u.pathname.match(/\/(?:joc|join|camera)\/([A-Za-z0-9]+)/i)
    if (m?.[1]) return m[1].toUpperCase()
  } catch {
    /* ignore */
  }
  return null
}

export function buildInviteUrl(roomCode: string): string {
  // query form works on any static host without extra SPA routes
  const root = `${window.location.origin}/`
  return `${root}?room=${encodeURIComponent(roomCode.toUpperCase())}`
}

export function buildInviteSmsBody(roomCode: string, hostName: string): string {
  const link = buildInviteUrl(roomCode)
  return t('smsBody', { host: hostName, link })
}

/** Opens the native SMS composer (works even if the friend is offline now). */
export function openNativeSms(phone: string, body: string) {
  const digits = phone.replace(/[^\d+]/g, '')
  if (!digits) throw new Error(t('invalidPhone'))
  const encoded = encodeURIComponent(body)
  // iOS prefers &body= after ?; Android accepts ?body=
  const href = `sms:${digits}?body=${encoded}`
  window.location.href = href
}

export function clearInviteFromUrl() {
  try {
    const u = new URL(window.location.href)
    if (!u.searchParams.has('room') && !u.searchParams.has('c') && !u.searchParams.has('cod')) {
      if (!/\/(?:joc|join|camera)\//i.test(u.pathname)) return
    }
    u.searchParams.delete('room')
    u.searchParams.delete('c')
    u.searchParams.delete('cod')
    const cleanPath = u.pathname.replace(/\/(?:joc|join|camera)\/[A-Za-z0-9]+/i, '/')
    window.history.replaceState({}, '', cleanPath + (u.search || '') + u.hash)
  } catch {
    /* ignore */
  }
}
