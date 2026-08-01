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

/** Local / long-running Node: HTTP + optional WebSocket upgrade */
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
      const room = createRoom(userId, username)
      send(ws, { type: 'room', room: roomPublic(room), role: 'p1' })
      break
    }
    case 'join-room': {
      const room = joinRoom(String(msg.code || ''), userId, username)
      const me = room.players.get(userId)!
      send(ws, { type: 'room', room: roomPublic(room), role: me.role })
      // notify via event log; WS peers poll or we fan-out if we tracked sockets — use events only for HTTP
      // For WS, re-send room update by scanning is hard without socket map; push event for HTTP clients
      if (room.players.size === 2) {
        pushEvent(room, userId, username, { type: 'both-joined' })
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
      const room = getRoomByUser(userId)
      if (!room) throw new Error('Nu ești într-o cameră')
      if (msg.type === 'ready') {
        const both = markReady(room.code, userId)
        pushEvent(room, userId, username, { type: 'ready', userId })
        if (both) pushEvent(room, userId, username, { type: 'start-battle' })
        send(ws, { type: 'ready', userId, room: roomPublic(room) })
        break
      }
      pushEvent(room, userId, username, { ...msg })
      break
    }
    case 'ping':
      send(ws, { type: 'pong' })
      break
    default:
      send(ws, { type: 'error', error: `Tip necunoscut: ${msg.type}` })
  }
}

// Only listen when not imported as Vercel handler
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`Avioane server http://localhost:${PORT}  (ws /ws)`)
  })
}

export default app
