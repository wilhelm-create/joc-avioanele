import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Remote multiplayer + invite flow (each player on own device).
 */

function uniqueUser() {
  const n = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  return { username: `u_${n}`.slice(0, 20), password: 'testpass123' }
}

async function registerFresh(page: import('@playwright/test').Page) {
  const u = uniqueUser()
  await page.goto('/')
  await expect(page.locator('[data-screen="auth"]')).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: /Cont nou/i }).click()
  await page.locator('#auth-user').fill(u.username)
  await page.locator('#auth-pass').fill(u.password)
  await page.getByRole('button', { name: /Înregistrează-te/i }).click()
  await expect(page.locator('[data-screen="home"]')).toBeVisible({ timeout: 15000 })
  return u
}

test.describe('Avioane remote invite usability', () => {
  test('auth gate — not pass-and-play messaging', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-screen="auth"]')).toBeVisible()
    await expect(page.getByText(/Nu se dă telefonul|device-ul lui|de pe telefonul/i).first()).toBeVisible()
  })

  test('home offers invite SMS/link and join — no pass & play', async ({ page }) => {
    await registerFresh(page)
    await expect(page.getByRole('button', { name: /Invită un prieten/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /cod \/ link/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /pass & play|Același device/i })).toHaveCount(0)
  })

  test('host creates room with invite link and SMS form', async ({ page }) => {
    await registerFresh(page)
    await page.getByRole('button', { name: /Invită un prieten/i }).click()
    await expect(page.locator('[data-screen="online-lobby"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.room-code')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('#invite-link')).toBeVisible()
    const link = await page.locator('#invite-link').inputValue()
    expect(link).toMatch(/\?room=[A-Z0-9]+/)
    await expect(page.getByRole('button', { name: /Trimite SMS/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Copiază link/i })).toBeVisible()
    await expect(page.getByText(/nu îi dai device-ul/i)).toBeVisible()
  })

  test('deep link room=CODE shows invite after auth', async ({ page, request }) => {
    // create room as host via API
    const host = uniqueUser()
    const reg = await request.post('http://127.0.0.1:3000/api/auth/register', {
      data: { username: host.username, password: host.password },
    })
    const { token } = (await reg.json()) as { token: string }
    const roomRes = await request.post('http://127.0.0.1:3000/api/rooms/create', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const roomJson = (await roomRes.json()) as { room: { code: string } }
    const code = roomJson.room.code

    // guest opens invite link while logged out
    await page.goto(`/?room=${code}`)
    await expect(page.locator('[data-screen="auth"]')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(new RegExp(code))).toBeVisible()

    const guest = uniqueUser()
    await page.getByRole('button', { name: /Cont nou/i }).click()
    await page.locator('#auth-user').fill(guest.username)
    await page.locator('#auth-pass').fill(guest.password)
    await page.getByRole('button', { name: /Înregistrează-te/i }).click()
    // should auto-join room
    await expect(page.locator('[data-screen="online-lobby"], [data-screen="placement"]')).toBeVisible({
      timeout: 15000,
    })
  })

  test('join by code from home', async ({ page, request }) => {
    const host = uniqueUser()
    const reg = await request.post('http://127.0.0.1:3000/api/auth/register', {
      data: { username: host.username, password: host.password },
    })
    const { token } = (await reg.json()) as { token: string }
    const roomRes = await request.post('http://127.0.0.1:3000/api/rooms/create', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const code = ((await roomRes.json()) as { room: { code: string } }).room.code

    await registerFresh(page)
    await page.getByRole('button', { name: /cod \/ link/i }).click()
    await page.locator('#join-code').fill(code)
    await page.getByRole('button', { name: /Intră în cameră/i }).click()
    await expect(page.locator('.room-code, [data-screen="placement"]')).toBeVisible({ timeout: 15000 })
  })

  test('invite SMS API returns client mode without Twilio', async ({ request }) => {
    const u = uniqueUser()
    const reg = await request.post('http://127.0.0.1:3000/api/auth/register', {
      data: { username: u.username, password: u.password },
    })
    const { token } = (await reg.json()) as { token: string }
    const roomRes = await request.post('http://127.0.0.1:3000/api/rooms/create', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const code = ((await roomRes.json()) as { room: { code: string } }).room.code
    const sms = await request.post('http://127.0.0.1:3000/api/invite/sms', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: '+40722123456',
        roomCode: code,
        inviteUrl: `https://example.com/?room=${code}`,
      },
    })
    expect(sms.ok()).toBeTruthy()
    const body = (await sms.json()) as { mode: string; body: string }
    expect(body.mode).toBe('client')
    expect(body.body).toContain(code)
  })

  test('no green in CSS', async () => {
    const css = fs.readFileSync(path.resolve('src/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const re of [/#22c55e/i, /\bgreen\b/i, /\blime\b/i]) {
      expect(css).not.toMatch(re)
    }
  })

  test('source has no pass-and-play handoff CTA', async () => {
    const app = fs.readFileSync(path.resolve('src/ui/app.ts'), 'utf8')
    expect(app).not.toMatch(/Sunt eu — continuă/)
    expect(app).not.toMatch(/Dă telefonul/)
    expect(app).toMatch(/Trimite SMS/)
    expect(app).toMatch(/buildInviteUrl|invite-link/)
  })

  test('responsive header on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await registerFresh(page)
    await expect(page.locator('.site-header')).toBeVisible()
  })
})
