import 'dotenv/config'
import { createServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import jwt from 'jsonwebtoken'
import { createApp, JWT_SECRET } from './app.js'
import { getPublic } from './db.js'
import {
  createRoom,
  joinRoom,
  getRoomByUser,
  leaveAll,
  markReady,
  pushEvent,
  roomPublic,
} from './rooms.js'

const PORT = Number(process.env.PORT) || 3000
const app = createApp()

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

interface AuthedSocket extends WebSocket {
  userId?: string
  username?: string
}

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

wss.on('connection', (ws: AuthedSocket, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`)
  const token = url.searchParams.get('token')
  if (!token) {
    send(ws, { type: 'error', error: 'Token lipsă' })
    ws.close()
    return
  }
  void (async () => {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { sub: string; username: string }
      const user = await getPublic(payload.sub)
      if (!user) throw new Error('user')
      ws.userId = user.id
      ws.username = user.username
      send(ws, { type: 'welcome', user })
    } catch {
      send(ws, { type: 'error', error: 'Token invalid' })
      ws.close()
    }
  })()

  ws.on('message', (raw) => {
    let msg: { type: string; [k: string]: unknown }
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!ws.userId || !ws.username) return
    void handleWs(ws, msg).catch((e) => {
      send(ws, { type: 'error', error: (e as Error).message })
    })
  })

  ws.on('close', () => {
    if (ws.userId) void leaveAll(ws.userId)
  })
})

async function handleWs(ws: AuthedSocket, msg: { type: string; [k: string]: unknown }) {
  const userId = ws.userId!
  const username = ws.username!

  switch (msg.type) {
    case 'create-room': {
      const room = await createRoom(userId, username)
      send(ws, { type: 'room', room: roomPublic(room), role: 'p1' })
      break
    }
    case 'join-room': {
      const room = await joinRoom(String(msg.code || ''), userId, username)
      const me = room.players.get(userId)!
      send(ws, { type: 'room', room: roomPublic(room), role: me.role })
      break
    }
    case 'leave-room': {
      await leaveAll(userId)
      send(ws, { type: 'left' })
      break
    }
    case 'ready':
    case 'placement':
    case 'shot':
    case 'radar':
    case 'rematch':
    case 'chat': {
      const room = await getRoomByUser(userId)
      if (!room) throw new Error('NOT_IN_ROOM')
      if (msg.type === 'ready') {
        const both = await markReady(room.code, userId)
        let updated = await pushEvent(room.code, userId, username, { type: 'ready', userId })
        if (both) {
          updated = await pushEvent(room.code, userId, username, { type: 'start-battle' })
        }
        if (updated) send(ws, { type: 'ready', userId, room: roomPublic(updated) })
        break
      }
      await pushEvent(room.code, userId, username, { ...msg })
      break
    }
    case 'ping':
      send(ws, { type: 'pong' })
      break
    default:
      send(ws, { type: 'error', error: `UNKNOWN_TYPE` })
  }
}

if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`Avioane server http://localhost:${PORT}  (ws /ws)`)
  })
}

export default app
