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

  function authHeaderUser(req: express.Request): PublicUser | null {
    const h = req.headers.authorization
    if (!h?.startsWith('Bearer ')) return null
    try {
      const payload = jwt.verify(h.slice(7), JWT_SECRET) as { sub: string }
      return getPublic(payload.sub)
    } catch {
      return null
    }
  }

  function requireAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    const user = authHeaderUser(req)
    if (!user) {
      res.status(401).json({ error: 'Neautentificat' })
      return
    }
    ;(req as express.Request & { user: PublicUser }).user = user
    next()
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'avioane', platform: process.env.VERCEL ? 'vercel' : 'node' })
  })

  app.post('/api/auth/register', (req, res) => {
    try {
      const { username, password } = req.body as { username?: string; password?: string }
      if (!username || !password) {
        res.status(400).json({ error: 'Username și parolă obligatorii' })
        return
      }
      const user = createUser(username, password)
      res.status(201).json({ user, token: signToken(user) })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  app.post('/api/auth/login', (req, res) => {
    try {
      const { username, password } = req.body as { username?: string; password?: string }
      if (!username || !password) {
        res.status(400).json({ error: 'Username și parolă obligatorii' })
        return
      }
      const user = verifyLogin(username, password)
      res.json({ user, token: signToken(user) })
    } catch (e) {
      res.status(401).json({ error: (e as Error).message })
    }
  })

  app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    res.json({ user: getPublic(user.id) })
  })

  app.get('/api/leaderboard', (_req, res) => {
    res.json({ leaders: listLeaderboard(25) })
  })

  app.post('/api/match/result', requireAuth, (req, res) => {
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
    recordMatch(winnerId, loserId)
    res.json({ ok: true })
  })

  /* ——— HTTP multiplayer (Vercel-safe) ——— */

  app.post('/api/rooms/create', requireAuth, (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    const room = createRoom(user.id, user.username)
    res.json({ room: roomPublic(room), role: 'p1' })
  })

  app.post('/api/rooms/join', requireAuth, (req, res) => {
    try {
      const user = (req as express.Request & { user: PublicUser }).user
      const code = String((req.body as { code?: string }).code || '').toUpperCase()
      const room = joinRoom(code, user.id, user.username)
      const me = room.players.get(user.id)!
      res.json({ room: roomPublic(room), role: me.role })
    } catch (e) {
      res.status(400).json({ error: (e as Error).message })
    }
  })

  app.post('/api/rooms/leave', requireAuth, (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    leaveAll(user.id)
    res.json({ ok: true })
  })

  app.get('/api/rooms/mine', requireAuth, (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    heartbeat(user.id)
    const room = getRoomByUser(user.id)
    if (!room) {
      res.json({ room: null })
      return
    }
    const me = room.players.get(user.id)
    res.json({ room: roomPublic(room), role: me?.role ?? null })
  })

  app.get('/api/rooms/poll', requireAuth, (req, res) => {
    const user = (req as express.Request & { user: PublicUser }).user
    heartbeat(user.id)
    const room = getRoomByUser(user.id)
    if (!room) {
      res.json({ room: null, events: [], bothJoined: false })
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
  })

  app.post('/api/rooms/event', requireAuth, (req, res) => {
    try {
      const user = (req as express.Request & { user: PublicUser }).user
      const room = getRoomByUser(user.id)
      if (!room) {
        res.status(400).json({ error: 'Nu ești într-o cameră' })
        return
      }
      const body = req.body as Record<string, unknown>
      const type = String(body.type || '')
      if (!type) {
        res.status(400).json({ error: 'type lipsă' })
        return
      }

      if (type === 'ready') {
        const both = markReady(room.code, user.id)
        pushEvent(room, user.id, user.username, { type: 'ready', userId: user.id })
        if (both) {
          pushEvent(room, user.id, user.username, { type: 'start-battle' })
        }
        res.json({ ok: true, room: roomPublic(room), bothReady: both })
        return
      }

      pushEvent(room, user.id, user.username, body)
      res.json({ ok: true })
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

  // periodic cleanup
  if (!(globalThis as { __avioaneCleanup?: boolean }).__avioaneCleanup) {
    ;(globalThis as { __avioaneCleanup?: boolean }).__avioaneCleanup = true
    setInterval(cleanupRooms, 15 * 60 * 1000)
  }

  return app
}

export { JWT_SECRET }
