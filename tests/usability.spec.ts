import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Usability suite — website with accounts, responsive devices.
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

test.describe('Avioane website usability', () => {
  test('auth screen is default gate (not installable PWA chrome)', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Avioane/i })).toBeVisible()
    await expect(page.locator('[data-screen="auth"]')).toBeVisible()
    await expect(page.getByRole('button', { name: /Intră/i }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Cont nou/i })).toBeVisible()
    // no manifest = not installable PWA
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(0)
    const login = page.locator('[data-action="auth-submit"]')
    const box = await login.boundingBox()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  })

  test('register then home with stats', async ({ page }) => {
    const u = await registerFresh(page)
    await expect(page.locator('.user-chip')).toContainText(u.username)
    await expect(page.getByRole('button', { name: /Joacă acum/i })).toBeVisible()
    await expect(page.getByText(/victorii/i).first()).toBeVisible()
  })

  test('login with existing account', async ({ page, request }) => {
    const u = uniqueUser()
    const res = await request.post('http://127.0.0.1:3000/api/auth/register', {
      data: { username: u.username, password: u.password },
    })
    expect(res.ok()).toBeTruthy()

    await page.goto('/')
    await page.locator('#auth-user').fill(u.username)
    await page.locator('#auth-pass').fill(u.password)
    await page.locator('[data-action="auth-submit"]').click()
    await expect(page.locator('[data-screen="home"]')).toBeVisible({ timeout: 10000 })
  })

  test('mode select after auth', async ({ page }) => {
    await registerFresh(page)
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await expect(page.getByRole('button', { name: /Același device/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Creează cameră online/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Intră în cameră/i })).toBeVisible()
  })

  test('full local pass-and-play to placement', async ({ page }) => {
    await registerFresh(page)
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Același device/i }).click()
    await page.locator('#friend-name').fill('Bogdan')
    await page.getByRole('button', { name: /Începe plasarea/i }).click()
    await expect(page.locator('[data-screen="placement"]')).toBeVisible()
    await expect(page.locator('.cell')).toHaveCount(100)
  })

  test('rotate and auto-place both players into battle', async ({ page }) => {
    await registerFresh(page)
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Același device/i }).click()
    await page.getByRole('button', { name: /Începe plasarea/i }).click()

    const rotate = page.getByRole('button', { name: /Rotește/i })
    await rotate.click()
    await expect(rotate).toContainText('90')

    await page.getByRole('button', { name: /Auto/i }).click()
    await expect(page.locator('[data-screen="pass-device"]')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: /continuă/i }).click()
    await expect(page.locator('[data-screen="placement"]')).toBeVisible()
    await page.getByRole('button', { name: /Auto/i }).click()
    await expect(page.locator('[data-screen="pass-device"]')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: /continuă/i }).click()
    await expect(page.locator('[data-screen="battle"]')).toBeVisible({ timeout: 5000 })
  })

  test('battle radar cookie and touch targets', async ({ page }) => {
    await registerFresh(page)
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Același device/i }).click()
    await page.getByRole('button', { name: /Începe plasarea/i }).click()
    await page.getByRole('button', { name: /Auto/i }).click()
    await page.getByRole('button', { name: /continuă/i }).click()
    await page.getByRole('button', { name: /Auto/i }).click()
    await page.getByRole('button', { name: /continuă/i }).click()
    await expect(page.locator('[data-screen="battle"]')).toBeVisible()

    const enemy = page.locator('[data-board="enemy"]')
    await enemy.locator('.cell').first().click()
    if (await page.locator('[data-screen="pass-device"]').isVisible()) {
      await page.getByRole('button', { name: /continuă/i }).click()
    }
    if (await page.locator('[data-screen="battle"]').isVisible()) {
      const radar = page.getByRole('button', { name: /Radar/i })
      const rb = await radar.boundingBox()
      expect(rb!.height).toBeGreaterThanOrEqual(44)
      await radar.click()
    }
  })

  test('complete game reaches victory', async ({ page }) => {
    test.setTimeout(120_000)
    await registerFresh(page)
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Același device/i }).click()
    await page.getByRole('button', { name: /Începe plasarea/i }).click()
    await page.getByRole('button', { name: /Auto/i }).click()
    await page.getByRole('button', { name: /continuă/i }).click()
    await page.getByRole('button', { name: /Auto/i }).click()
    await page.getByRole('button', { name: /continuă/i }).click()
    await expect(page.locator('[data-screen="battle"]')).toBeVisible()

    for (let i = 0; i < 450; i++) {
      if (await page.locator('[data-screen="game-over"]').isVisible().catch(() => false)) break
      if (await page.locator('[data-screen="pass-device"]').isVisible().catch(() => false)) {
        await page.locator('[data-action="continue"]').click({ force: true })
        continue
      }
      if (!(await page.locator('[data-screen="battle"]').isVisible().catch(() => false))) continue
      const target = page
        .locator('[data-board="enemy"] .cell:not(.miss):not(.hit):not(.sunk):not(.radar)')
        .first()
      if ((await target.count()) === 0) break
      await target.click({ force: true })
    }
    await expect(page.locator('[data-screen="game-over"]')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: /Revanșă/i })).toBeVisible()
  })

  test('no green colors in CSS/source', async () => {
    const css = fs.readFileSync(path.resolve('src/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const banned = [/#22c55e/i, /#16a34a/i, /#4ade80/i, /#00ff00/i, /\bgreen\b/i, /\blime\b/i]
    for (const re of banned) {
      expect(css, String(re)).not.toMatch(re)
    }
  })

  test('responsive layout works on desktop viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await registerFresh(page)
    await expect(page.locator('.site-header')).toBeVisible()
    await expect(page.locator('.site-footer')).toBeVisible()
    const main = page.locator('main.main')
    const box = await main.boundingBox()
    expect(box!.width).toBeGreaterThan(400)
  })

  test('online host creates room code via API socket path', async ({ page }) => {
    await registerFresh(page)
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Creează cameră online/i }).click()
    await expect(page.locator('[data-screen="online-lobby"]')).toBeVisible({ timeout: 10000 })
    // room code appears when WS works
    await expect(page.locator('.room-code')).toBeVisible({ timeout: 15000 })
  })
})
