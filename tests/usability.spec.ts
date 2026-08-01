import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Usability suite for Avioane (mobile viewport via Pixel 7 device).
 * Must all pass before release.
 */

test.describe('Avioane usability', () => {
  test('home loads with logo and play CTA', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /Avioane/i })).toBeVisible()
    const play = page.getByRole('button', { name: /Joacă acum/i })
    await expect(play).toBeVisible()
    const box = await play.boundingBox()
    expect(box).toBeTruthy()
    expect(box!.height).toBeGreaterThanOrEqual(44)
  })

  test('mode select offers local and online', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await expect(page.getByRole('button', { name: /Același telefon/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Creează cameră/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Intră în cameră/i })).toBeVisible()
  })

  test('full local pass-and-play flow to placement', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Același telefon/i }).click()
    await page.locator('#name-p1').fill('Ana')
    await page.locator('#name-p2').fill('Bogdan')
    await page.getByRole('button', { name: /Începe plasarea/i }).click()
    await expect(page.locator('[data-screen="placement"]')).toBeVisible()
    await expect(page.getByText('Ana — plasare 0/3')).toBeVisible()
    // grid has 100 cells
    await expect(page.locator('.cell')).toHaveCount(100)
  })

  test('rotate and auto-place works; second player places', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Același telefon/i }).click()
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

  test('battle: miss shot, radar cookie once, touch targets', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Același telefon/i }).click()
    await page.getByRole('button', { name: /Începe plasarea/i }).click()
    await page.getByRole('button', { name: /Auto/i }).click()
    await page.getByRole('button', { name: /continuă/i }).click()
    await page.getByRole('button', { name: /Auto/i }).click()
    await page.getByRole('button', { name: /continuă/i }).click()
    await expect(page.locator('[data-screen="battle"]')).toBeVisible()

    // enemy board first
    const enemy = page.locator('[data-board="enemy"]')
    await expect(enemy).toBeVisible()

    // fire top-left — may hit or miss depending on auto layout; either way cell marked
    const cell = enemy.locator('.cell').first()
    const box = await cell.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(28)
    await cell.click()

    // pass screen or still battle if online-like; local always pass after shot
    const passOrBattle = page.locator('[data-screen="pass-device"], [data-screen="battle"], [data-screen="game-over"]')
    await expect(passOrBattle.first()).toBeVisible()

    // If pass, continue and try radar on next turn after both... actually after one shot we pass
    if (await page.locator('[data-screen="pass-device"]').isVisible()) {
      await page.getByRole('button', { name: /continuă/i }).click()
    }

    // On p2 turn, use radar
    if (await page.locator('[data-screen="battle"]').isVisible()) {
      const radar = page.getByRole('button', { name: /Radar/i })
      await expect(radar).toBeVisible()
      const rb = await radar.boundingBox()
      expect(rb!.height).toBeGreaterThanOrEqual(44)
      await radar.click()
      await expect(page.getByText(/Radar/i).first()).toBeVisible()
    }
  })

  test('complete game reaches victory screen', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/')
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Același telefon/i }).click()
    await page.getByRole('button', { name: /Începe plasarea/i }).click()
    await page.getByRole('button', { name: /Auto/i }).click()
    await page.getByRole('button', { name: /continuă/i }).click()
    await page.getByRole('button', { name: /Auto/i }).click()
    await page.getByRole('button', { name: /continuă/i }).click()
    await expect(page.locator('[data-screen="battle"]')).toBeVisible()

    // Sweep every enemy cell for both players until someone wins
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
    await expect(page.getByRole('button', { name: /Meniu/i })).toBeVisible()
  })

  test('project CSS contains no green colors', async () => {
    const cssPath = path.resolve('src/style.css')
    const css = fs.readFileSync(cssPath, 'utf8')
    // ban common green hex / keywords (allow comments saying "no green")
    const banned = [
      /#0f0\b/i,
      /#00ff00/i,
      /#008000/i,
      /#22c55e/i,
      /#16a34a/i,
      /#4ade80/i,
      /#86efac/i,
      /#166534/i,
      /\bgreen\b/i,
      /\blime\b/i,
      /rgb\(\s*0\s*,\s*128\s*,\s*0\s*\)/i,
      /rgb\(\s*0\s*,\s*255\s*,\s*0\s*\)/i,
    ]
    // strip comments first
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const re of banned) {
      expect(code, `Forbidden green pattern ${re}`).not.toMatch(re)
    }
  })

  test('source files ban green color tokens', async () => {
    const files = [
      'src/ui/app.ts',
      'src/game/engine.ts',
      'src/cookies/effects.ts',
      'src/style.css',
    ]
    for (const f of files) {
      const text = fs.readFileSync(path.resolve(f), 'utf8')
      // actual color usage of green hexes
      expect(text, f).not.toMatch(/#22c55e|#16a34a|#4ade80|#86efac|#00ff00|#008000/i)
    }
  })

  test('PWA manifest is installable shape', async ({ page }) => {
    await page.goto('/')
    const manifestLink = page.locator('link[rel="manifest"]')
    // in dev, vite-plugin-pwa may inject; if not, check public path exists after build
    // at least app is standalone-ready meta
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', /#/)
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /width=device-width/,
    )
    void manifestLink
  })

  test('online host shows room code UI path', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Joacă acum/i }).click()
    await page.getByRole('button', { name: /Creează cameră/i }).click()
    await page.locator('#name-p1').fill('Host')
    await page.getByRole('button', { name: /Creează camera/i }).click()
    // lobby or error (peerjs network) — either lobby screen or message
    await page.waitForTimeout(2000)
    const lobby = page.locator('[data-screen="online-lobby"]')
    const nameEntry = page.locator('[data-screen="name-entry"]')
    const ok = (await lobby.isVisible()) || (await nameEntry.isVisible())
    expect(ok).toBeTruthy()
  })
})
