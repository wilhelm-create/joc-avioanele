/**
 * Transactional email via Resend (HTTPS API — works on Vercel serverless).
 *
 * Required for real inbox delivery (production):
 *   RESEND_API_KEY   — from https://resend.com
 *   EMAIL_FROM       — verified domain sender, e.g. "Avioane <noreply@yourdomain.com>"
 *   PUBLIC_APP_URL   — https://joc-avioanele.vercel.app (no trailing slash)
 *
 * Dev-only without key: EMAIL_ALLOW_LOG=1 → log link to console + return debugLink.
 * On Vercel/production, missing RESEND_API_KEY fails the send (no silent auto-verify).
 */

export type MailResult = {
  ok: boolean
  mode: 'resend' | 'log'
  /** Present in log mode so QA can open the link without a real inbox */
  debugLink?: string
  error?: string
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim())
}

function isProductionLike(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.NODE_ENV === 'production' ||
      process.env.REQUIRE_EMAIL_VERIFICATION === '1',
  )
}

/** Allow console/debug links only outside production-like hosts, or with explicit flag. */
function allowLogMode(): boolean {
  if (process.env.EMAIL_ALLOW_LOG === '1') return true
  if (process.env.EMAIL_ALLOW_LOG === '0') return false
  return !isProductionLike()
}

function appUrl(): string {
  return (process.env.PUBLIC_APP_URL || 'https://joc-avioanele.vercel.app').replace(/\/$/, '')
}

function fromAddress(): string {
  // Resend test sender works only for the account owner email until a domain is verified
  return process.env.EMAIL_FROM || 'Avioane <onboarding@resend.dev>'
}

export function isValidEmailFormat(email: string): boolean {
  const e = email.trim().toLowerCase()
  // Practical RFC-inspired check (not full RFC5322)
  if (e.length < 5 || e.length > 120) return false
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return false
  if (e.includes('..')) return false
  const domain = e.split('@')[1] || ''
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false
  // Block obvious disposable-test junk domains when strict (optional soft list)
  const blocked = ['mailinator.com', 'tempmail.com', 'throwaway.email', 'guerrillamail.com']
  if (blocked.some((d) => domain === d || domain.endsWith(`.${d}`))) return false
  return true
}

async function sendResend(to: string, subject: string, html: string, text: string): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY?.trim()
  if (!key) {
    if (!allowLogMode()) {
      console.error('RESEND_API_KEY missing — cannot send email in production')
      return { ok: false, mode: 'resend', error: 'EMAIL_NOT_CONFIGURED' }
    }
    console.info('[email:log]', { to, subject, text })
    return { ok: true, mode: 'log' }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [to],
        subject,
        html,
        text,
      }),
    })
    if (!res.ok) {
      const err = await res.text()
      console.error('Resend failed', res.status, err.slice(0, 300))
      return { ok: false, mode: 'resend', error: 'EMAIL_SEND_FAILED' }
    }
    return { ok: true, mode: 'resend' }
  } catch (e) {
    console.error('Resend error', e)
    return { ok: false, mode: 'resend', error: 'EMAIL_SEND_FAILED' }
  }
}

export async function sendVerifyEmail(to: string, username: string, token: string): Promise<MailResult> {
  const link = `${appUrl()}/?verify=${encodeURIComponent(token)}`
  const subject = 'Confirmă emailul — Avioane'
  const text = `Salut ${username}!\n\nConfirmă adresa de email deschizând linkul:\n${link}\n\nLinkul expiră în 24 de ore.`
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h1 style="font-size:1.25rem">✈ Avioane</h1>
      <p>Salut <strong>${escapeHtml(username)}</strong>!</p>
      <p>Confirmă adresa de email ca să poți juca:</p>
      <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#e8956a;color:#fff;border-radius:12px;text-decoration:none;font-weight:700">Confirmă emailul</a></p>
      <p style="color:#666;font-size:0.9rem">Sau copiază: ${link}</p>
      <p style="color:#666;font-size:0.85rem">Linkul expiră în 24 de ore.</p>
    </div>`
  const result = await sendResend(to, subject, html, text)
  if (result.mode === 'log') result.debugLink = link
  return result
}

export async function sendPasswordResetEmail(to: string, username: string, token: string): Promise<MailResult> {
  const link = `${appUrl()}/?reset=${encodeURIComponent(token)}`
  const subject = 'Resetare parolă — Avioane'
  const text = `Salut ${username}!\n\nResetează parola aici:\n${link}\n\nLinkul expiră în 1 oră. Dacă nu ai cerut tu asta, ignoră mesajul.`
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h1 style="font-size:1.25rem">✈ Avioane</h1>
      <p>Salut <strong>${escapeHtml(username)}</strong>!</p>
      <p>Ai cerut resetarea parolei:</p>
      <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#e8956a;color:#fff;border-radius:12px;text-decoration:none;font-weight:700">Resetează parola</a></p>
      <p style="color:#666;font-size:0.9rem">Sau copiază: ${link}</p>
      <p style="color:#666;font-size:0.85rem">Linkul expiră în 1 oră.</p>
    </div>`
  const result = await sendResend(to, subject, html, text)
  if (result.mode === 'log') result.debugLink = link
  return result
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
