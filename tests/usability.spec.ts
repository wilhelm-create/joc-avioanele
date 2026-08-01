import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Usability — remote multiplayer + RO/EN.
 */

function uniqueUser() {
  const n = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  return { username: `u_${n}`.slice(0, 20), password: 'testpass123' }
}

async function forceLang(page: import('@playwright/test').Page, lang: 'ro' | 'en') {
  await page.addInitScript((l) => {
    localStorage.setItem('avioane_lang', l)
  }, lang)
}

async function registerFresh(page: import('@playwright/test').Page, lang: 'ro' | 'en' = 'ro') {
  await forceLang(page, lang)
  const u = uniqueUser()
  await page.goto('/')
  await expect(page.locator('[data-screen="auth"]')).toBeVisible({ timeout: 15000 })
  // Cont nou / Sign up
  await page.locator('[data-action="tab-register"]').click()
  await page.locator('#auth-user').fill(u.username)
  await page.locator('#auth-pass').fill(u.password)
  await page.locator('[data-action="auth-submit"]').click()
  await expect(page.locator('[data-screen="home"]')).toBeVisible({ timeout: 15000 })
  return u
}

test.describe('Avioane i18n + remote', () => {
  test('auth screen + language and theme toggles', async ({ page }) => {
    await forceLang(page, 'ro')
    await page.addInitScript(() => localStorage.setItem('avioane_theme', 'dark'))
    await page.goto('/')
    await expect(page.locator('[data-screen="auth"]')).toBeVisible()
    await expect(page.locator('.lang-toggle')).toBeVisible()
    await expect(page.locator('.theme-toggle')).toBeVisible()
    await expect(page.locator('[data-control="theme"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'RO' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'EN' })).toBeVisible()
    // switch to light
    await page.locator('[data-theme-opt="light"]').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    // switch to dark
    await page.locator('[data-theme-opt="dark"]').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.getByRole('button', { name: 'EN' }).click()
    await expect(page.getByText(/Sign in|Create account/i).first()).toBeVisible()
    await page.getByRole('button', { name: 'RO' }).click()
    await expect(page.getByText(/Autentificare|Creează cont/i).first()).toBeVisible()
  })

  test('home invite actions in English', async ({ page }) => {
    await registerFresh(page, 'en')
    await expect(page.getByRole('button', { name: /Invite a friend/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /invite code/i })).toBeVisible()
    await expect(page.locator('#main').getByRole('button', { name: /Leaderboard/i })).toBeVisible()
  })

  test('home invite actions in Romanian', async ({ page }) => {
    await registerFresh(page, 'ro')
    await expect(page.getByRole('button', { name: /Invită un prieten/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /cod \/ link/i })).toBeVisible()
  })

  test('host lobby SMS + link (RO)', async ({ page }) => {
    await registerFresh(page, 'ro')
    await page.getByRole('button', { name: /Invită un prieten/i }).click()
    await expect(page.locator('[data-screen="online-lobby"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.room-code')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('#invite-link')).toBeVisible()
    await expect(page.getByRole('button', { name: /Trimite SMS/i })).toBeVisible()
  })

  test('deep link join after auth', async ({ page, request }) => {
    const host = uniqueUser()
    const reg = await request.post('http://127.0.0.1:3000/api/auth/register', {
      data: { username: host.username, password: host.password },
    })
    const { token } = (await reg.json()) as { token: string }
    const roomRes = await request.post('http://127.0.0.1:3000/api/rooms/create', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const code = ((await roomRes.json()) as { room: { code: string } }).room.code

    await forceLang(page, 'en')
    await page.goto(`/?room=${code}`)
    await expect(page.locator('[data-screen="auth"]')).toBeVisible({ timeout: 10000 })
    await page.locator('[data-action="tab-register"]').click()
    const guest = uniqueUser()
    await page.locator('#auth-user').fill(guest.username)
    await page.locator('#auth-pass').fill(guest.password)
    await page.locator('[data-action="auth-submit"]').click()
    await expect(page.locator('[data-screen="online-lobby"], [data-screen="placement"]')).toBeVisible({
      timeout: 15000,
    })
  })

  test('no green in CSS', async () => {
    const css = fs.readFileSync(path.resolve('src/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const re of [/#22c55e/i, /\bgreen\b/i, /\blime\b/i]) {
      expect(css).not.toMatch(re)
    }
  })

  test('i18n locales include both languages', async () => {
    const src = fs.readFileSync(path.resolve('src/i18n/locales.ts'), 'utf8')
    expect(src).toMatch(/ro:\s*\{/)
    expect(src).toMatch(/en:\s*\{/)
    expect(src).toMatch(/inviteFriend/)
    expect(src).toMatch(/Invite a friend/)
  })
})
