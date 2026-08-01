import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'
import {
  createUser,
  verifyLogin,
  getPublic,
  listLeaderboard,
  recordMatch,
  storageMode,
  type PublicUser,
} from './db.js'
import {
  createRoom,
  joinRoom,
  getRoomByUser,
  leaveAll,
  markReady,
  pushEvent,
  pollEvents,
  roomPublic,
  heartbeat,
  cleanupRooms,
} from './rooms.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const JWT_SECRET = process.env.JWT_SECRET || 'dev-avioane-secret-change-me'

export function createApp() {
  const app = express()
  app.use(cors({ origin: true, credentials: true }))
  app.use(express.json({ limit: '64kb' }))

  function signToken(user: PublicUser): string {
    return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' })
  }

  async function authHeaderUser(req: express.Request): Promise<PublicUser | null> {
    const h = req.headers.authorization
    if (!h?.startsWith('Bearer ')) return null
    try {
      const payload = jwt.verify(h.slice(7), JWT_SECRET) as { sub: string }
      return await getPublic(payload.sub)
    } catch {
      return null
    }
  }

  function requireAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    void authHeaderUser(req).then((user) => {
      if (!user) {
        res.status(401).json({ error: 'Neautentificat' })
        return
      }
      ;(req as express.Request & { user: PublicUser }).user = user
      next()
    })
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'avioane',
      platform: process.env.VERCEL ? 'vercel' : 'node',
      storage: storageMode(),
    })
  })

  app.post('/api/auth/register', async (req, res) => {
    try {
      const { username, password } = req.body as { username?: string; password?: string }
      if (!username || !password) {
        res.status(400).json({ error: 'Username și parolă obligatorii' })
        return
      }
      const user = await createUser(username, password)
      res.status(201).json({ user, token: signToken(user) })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { username, password } = req.body as { username?: string; password?: string }
      if (!username || !password) {
        res.status(400).json({ error: 'Username și parolă obligatorii' })
        return
      }
      const user = await verifyLogin(username, password)
      res.json({ user, token: signToken(user) })
    } catch (e) {
      res.status(401).json({ error: (e as Error).message })
    }
  })

  app.get('/api/auth/me', requireAuth, async (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    res.json({ user: await getPublic(user.id) })
  })

  app.get('/api/leaderboard', async (_req, res) => {
    res.json({ leaders: await listLeaderboard(25) })
  })

  app.post('/api/match/result', requireAuth, async (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    const { winnerId, loserId } = req.body as { winnerId?: string; loserId?: string }
    if (!winnerId || !loserId) {
      res.status(400).json({ error: 'winnerId și loserId obligatorii' })
      return
    }
    if (user.id !== winnerId && user.id !== loserId) {
      res.status(403).json({ error: 'Nu poți raporta un meci străin' })
      return
    }
    await recordMatch(winnerId, loserId)
    res.json({ ok: true })
  })

  /**
   * SMS invite — if Twilio env vars are set, send server-side SMS.
   * Otherwise return { mode: 'client' } so the browser opens the native SMS app.
   */
  app.post('/api/invite/sms', requireAuth, async (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    const { phone, roomCode, inviteUrl } = req.body as {
      phone?: string
      roomCode?: string
      inviteUrl?: string
    }
    if (!phone || !roomCode) {
      res.status(400).json({ error: 'phone și roomCode obligatorii' })
      return
    }
    const digits = String(phone).replace(/[^\d+]/g, '')
    if (digits.length < 8) {
      res.status(400).json({ error: 'Număr de telefon invalid' })
      return
    }
    const code = String(roomCode).toUpperCase()
    const link =
      inviteUrl ||
      `${process.env.PUBLIC_APP_URL || 'https://joc-avioanele.vercel.app'}/?room=${encodeURIComponent(code)}`
    const body = `✈ Avioane: ${user.username} te invită! Deschide linkul și joacă de pe telefonul tău: ${link}`

    const sid = process.env.TWILIO_ACCOUNT_SID
    const token = process.env.TWILIO_AUTH_TOKEN
    const from = process.env.TWILIO_FROM

    if (sid && token && from) {
      try {
        const auth = Buffer.from(`${sid}:${token}`).toString('base64')
        const params = new URLSearchParams({ To: digits, From: from, Body: body })
        const tw = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
          },
        )
        if (!tw.ok) {
          const errText = await tw.text()
          res.status(502).json({ error: 'Twilio a eșuat', detail: errText.slice(0, 200) })
          return
        }
        res.json({ mode: 'twilio', ok: true })
        return
      } catch (e) {
        res.status(502).json({ error: (e as Error).message })
        return
      }
    }

    // No Twilio — client should open native SMS composer
    res.json({ mode: 'client', body, phone: digits })
  })

  /* ——— HTTP multiplayer (durable rooms on Blob/local) ——— */

  app.post('/api/rooms/create', requireAuth, async (req, res) => {
    try {
      const user = (req as express.Request & { user: PublicUser }).user
      const room = await createRoom(user.id, user.username)
      res.json({ room: roomPublic(room), role: 'p1' })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.post('/api/rooms/join', requireAuth, async (req, res) => {
    try {
      const user = (req as express.Request & { user: PublicUser }).user
      const code = String((req.body as { code?: string }).code || '').toUpperCase().trim()
      if (code.length < 4) {
        res.status(400).json({ error: 'ROOM_NOT_FOUND' })
        return
      }
      const room = await joinRoom(code, user.id, user.username)
      const me = room.players.get(user.id)!
      res.json({ room: roomPublic(room), role: me.role })
    } catch (e) {
      const msg = (e as Error).message
      res.status(400).json({ error: msg })
    }
  })

  app.post('/api/rooms/leave', requireAuth, async (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    await leaveAll(user.id)
    res.json({ ok: true })
  })

  app.get('/api/rooms/mine', requireAuth, async (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    await heartbeat(user.id)
    const room = await getRoomByUser(user.id)
    if (!room) {
      res.json({ room: null })
      return
    }
    const me = room.players.get(user.id)
    res.json({ room: roomPublic(room), role: me?.role ?? null })
  })

  app.get('/api/rooms/poll', requireAuth, async (req, res) => {
    try {
      const user = (req as express.Request & { user: PublicUser }).user
      await heartbeat(user.id)
      const room = await getRoomByUser(user.id)
      if (!room) {
        res.json({ room: null, events: [], bothJoined: false, bothReady: false })
        return
      }
      const after = Number(req.query.after || 0)
      const events = pollEvents(room, after).filter((e) => e.from !== user.id)
      res.json({
        room: roomPublic(room),
        events: events.map((e) => ({
          id: e.id,
          from: e.from,
          fromName: e.fromName,
          ...e.payload,
        })),
        bothJoined: room.players.size >= 2,
        bothReady: room.ready.size >= 2,
      })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  app.post('/api/rooms/event', requireAuth, async (req, res) => {
    try {
      const user = (req as express.Request & { user: PublicUser }).user
      let room = await getRoomByUser(user.id)
      if (!room) {
        res.status(400).json({ error: 'NOT_IN_ROOM' })
        return
      }
      const body = req.body as Record<string, unknown>
      const type = String(body.type || '')
      if (!type) {
        res.status(400).json({ error: 'MISSING_TYPE' })
        return
      }

      if (type === 'ready') {
        const both = await markReady(room.code, user.id)
        room = (await pushEvent(room.code, user.id, user.username, {
          type: 'ready',
          userId: user.id,
        }))!
        if (both) {
          room = (await pushEvent(room.code, user.id, user.username, { type: 'start-battle' }))!
        }
        res.json({ ok: true, room: roomPublic(room), bothReady: both })
        return
      }

      room = (await pushEvent(room.code, user.id, user.username, body))!
      res.json({ ok: true, room: roomPublic(room) })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  // static SPA in production (non-Vercel Node host)
  if (process.env.NODE_ENV === 'production' && !process.env.VERCEL) {
    const dist = path.join(__dirname, '..', 'dist')
    app.use(express.static(dist))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) return next()
      res.sendFile(path.join(dist, 'index.html'))
    })
  }

  if (!(globalThis as { __avioaneCleanup?: boolean }).__avioaneCleanup) {
    ;(globalThis as { __avioaneCleanup?: boolean }).__avioaneCleanup = true
    setInterval(() => {
      void cleanupRooms()
    }, 15 * 60 * 1000)
  }

  return app
}

export { JWT_SECRET }
