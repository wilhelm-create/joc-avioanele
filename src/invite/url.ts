/** Invite deep-link + share helpers (WhatsApp / email / SMS — no phone field). */

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
  const root = `${window.location.origin}/`
  return `${root}?room=${encodeURIComponent(roomCode.toUpperCase())}`
}

export function buildInviteText(roomCode: string, hostName: string): string {
  const link = buildInviteUrl(roomCode)
  return t('smsBody', { host: hostName, link })
}

/** @deprecated use buildInviteText */
export function buildInviteSmsBody(roomCode: string, hostName: string): string {
  return buildInviteText(roomCode, hostName)
}

/** SMS composer without a pre-filled number — user picks the contact. */
export function openShareSms(body: string) {
  const encoded = encodeURIComponent(body)
  // Empty recipient: works on iOS/Android for picking a contact
  window.location.href = `sms:?&body=${encoded}`
}

export function openShareWhatsApp(body: string) {
  const encoded = encodeURIComponent(body)
  window.open(`https://wa.me/?text=${encoded}`, '_blank', 'noopener,noreferrer')
}

export function openShareEmail(subject: string, body: string) {
  const href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  window.location.href = href
}

export async function openSystemShare(title: string, text: string, url: string) {
  if (navigator.share) {
    await navigator.share({ title, text, url })
    return true
  }
  return false
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
