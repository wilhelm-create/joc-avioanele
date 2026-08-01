import type { WebSocket } from 'ws'

export type Role = 'p1' | 'p2'

export interface RoomClient {
  ws: WebSocket
  userId: string
  username: string
  role: Role
}

export interface Room {
  code: string
  hostId: string
  clients: Map<string, RoomClient> // userId -> client
  ready: Set<string>
  createdAt: number
}

const rooms = new Map<string, Room>()

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateCode(): string {
  let code = ''
  for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  if (rooms.has(code)) return generateCode()
  return code
}

export function createRoom(host: Omit<RoomClient, 'role'>): Room {
  // leave any previous room
  leaveAll(host.userId)

  const code = generateCode()
  const room: Room = {
    code,
    hostId: host.userId,
    clients: new Map(),
    ready: new Set(),
    createdAt: Date.now(),
  }
  room.clients.set(host.userId, { ...host, role: 'p1' })
  rooms.set(code, room)
  return room
}

export function joinRoom(code: string, guest: Omit<RoomClient, 'role'>): Room {
  const room = rooms.get(code.toUpperCase())
  if (!room) throw new Error('Camera nu există')
  if (room.clients.size >= 2) throw new Error('Camera e plină')
  if (room.clients.has(guest.userId)) return room

  leaveAll(guest.userId)
  room.clients.set(guest.userId, { ...guest, role: 'p2' })
  return room
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase())
}

export function getRoomByUser(userId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.clients.has(userId)) return room
  }
  return undefined
}

export function leaveAll(userId: string) {
  for (const [code, room] of rooms) {
    if (!room.clients.has(userId)) continue
    room.clients.delete(userId)
    room.ready.delete(userId)
    if (room.clients.size === 0) {
      rooms.delete(code)
    } else {
      broadcast(room, { type: 'peer-left', userId })
    }
  }
}

export function markReady(code: string, userId: string): boolean {
  const room = rooms.get(code.toUpperCase())
  if (!room || !room.clients.has(userId)) return false
  room.ready.add(userId)
  return room.ready.size >= 2
}

export function broadcast(room: Room, msg: unknown, exceptUserId?: string) {
  const raw = JSON.stringify(msg)
  for (const c of room.clients.values()) {
    if (exceptUserId && c.userId === exceptUserId) continue
    if (c.ws.readyState === 1) c.ws.send(raw)
  }
}

export function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

export function roomPublic(room: Room) {
  return {
    code: room.code,
    players: [...room.clients.values()].map((c) => ({
      userId: c.userId,
      username: c.username,
      role: c.role,
      ready: room.ready.has(c.userId),
    })),
  }
}

/** cleanup stale empty-ish rooms older than 2h */
export function cleanupRooms() {
  const maxAge = 2 * 60 * 60 * 1000
  const now = Date.now()
  for (const [code, room] of rooms) {
    if (now - room.createdAt > maxAge) rooms.delete(code)
  }
}

setInterval(cleanupRooms, 15 * 60 * 1000)
