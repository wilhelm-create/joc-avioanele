import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
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
  getRoom,
  getRoomByUser,
  leaveAll,
  markReady,
  broadcast,
  send,
  roomPublic,
} from './rooms.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3000
const JWT_SECRET = process.env.JWT_SECRET || 'dev-avioane-secret-change-me'
const isProd = process.env.NODE_ENV === 'production'

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
  res.json({ ok: true, service: 'avioane' })
})

app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password } = req.body as { username?: string; password?: string }
    if (!username || !password) {
      res.status(400).json({ error: 'Username și parolă obligatorii' })
      return
    }
    const user = createUser(username, password)
    const token = signToken(user)
    res.status(201).json({ user, token })
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
    const token = signToken(user)
    res.json({ user, token })
  } catch (e) {
    res.status(401).json({ error: (e as Error).message })
  }
})

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = (req as express.Request & { user: PublicUser }).user
  // refresh stats
  const fresh = getPublic(user.id)
  res.json({ user: fresh })
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

// production: serve built SPA
const dist = path.join(__dirname, '..', 'dist')
if (isProd) {
  app.use(express.static(dist))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next()
    res.sendFile(path.join(dist, 'index.html'))
  })
}

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

interface AuthedSocket extends WebSocket {
  userId?: string
  username?: string
}

wss.on('connection', (ws: AuthedSocket, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`)
  const token = url.searchParams.get('token')
  if (!token) {
    send(ws, { type: 'error', error: 'Token lipsă' })
    ws.close()
    return
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string; username: string }
    const user = getPublic(payload.sub)
    if (!user) throw new Error('user')
    ws.userId = user.id
    ws.username = user.username
    send(ws, { type: 'welcome', user })
  } catch {
    send(ws, { type: 'error', error: 'Token invalid' })
    ws.close()
    return
  }

  ws.on('message', (raw) => {
    let msg: { type: string; [k: string]: unknown }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!ws.userId || !ws.username) return

    try {
      handleWs(ws, msg)
    } catch (e) {
      send(ws, { type: 'error', error: (e as Error).message })
    }
  })

  ws.on('close', () => {
    if (ws.userId) leaveAll(ws.userId)
  })
})

function handleWs(ws: AuthedSocket, msg: { type: string; [k: string]: unknown }) {
  const userId = ws.userId!
  const username = ws.username!

  switch (msg.type) {
    case 'create-room': {
      const room = createRoom({ ws, userId, username })
      send(ws, { type: 'room', room: roomPublic(room), role: 'p1' })
      break
    }
    case 'join-room': {
      const code = String(msg.code || '').toUpperCase()
      const room = joinRoom(code, { ws, userId, username })
      // refresh host socket if reconnecting not needed
      const client = room.clients.get(userId)!
      client.ws = ws
      send(ws, { type: 'room', room: roomPublic(room), role: client.role })
      broadcast(room, { type: 'room', room: roomPublic(room) })
      if (room.clients.size === 2) {
        broadcast(room, { type: 'both-joined', room: roomPublic(room) })
      }
      break
    }
    case 'leave-room': {
      leaveAll(userId)
      send(ws, { type: 'left' })
      break
    }
    case 'ready':
    case 'placement':
    case 'shot':
    case 'radar':
    case 'rematch':
    case 'chat': {
      const room = getRoomByUser(userId) || (msg.code ? getRoom(String(msg.code)) : undefined)
      if (!room) throw new Error('Nu ești într-o cameră')
      // keep ws fresh
      const me = room.clients.get(userId)
      if (me) me.ws = ws

      if (msg.type === 'ready') {
        const both = markReady(room.code, userId)
        broadcast(room, { type: 'ready', userId, room: roomPublic(room) })
        if (both) broadcast(room, { type: 'start-battle', room: roomPublic(room) })
        break
      }

      // relay game events to peer
      broadcast(room, { ...msg, from: userId, fromName: username }, userId)
      break
    }
    case 'ping': {
      send(ws, { type: 'pong' })
      break
    }
    default:
      send(ws, { type: 'error', error: `Tip necunoscut: ${msg.type}` })
  }
}

server.listen(PORT, () => {
  console.log(`Avioane server http://localhost:${PORT}  (ws /ws)`)
  if (!isProd) console.log('Dev: rulează și Vite pe 5173 cu proxy /api și /ws')
})
