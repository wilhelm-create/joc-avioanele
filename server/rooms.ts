/**
 * In-memory rooms + event log for multiplayer.
 * Works with WebSocket (local) and HTTP polling (Vercel).
 */

export type Role = 'p1' | 'p2'

export interface RoomPlayer {
  userId: string
  username: string
  role: Role
  lastSeen: number
}

export interface RoomEvent {
  id: number
  at: number
  from: string
  fromName: string
  payload: Record<string, unknown>
}

export interface Room {
  code: string
  hostId: string
  players: Map<string, RoomPlayer>
  ready: Set<string>
  events: RoomEvent[]
  nextEventId: number
  createdAt: number
}

type GlobalStore = { rooms: Map<string, Room>; userRoom: Map<string, string> }

function store(): GlobalStore {
  const g = globalThis as typeof globalThis & { __avioaneRooms?: GlobalStore }
  if (!g.__avioaneRooms) {
    g.__avioaneRooms = { rooms: new Map(), userRoom: new Map() }
  }
  return g.__avioaneRooms
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateCode(): string {
  let code = ''
  for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  if (store().rooms.has(code)) return generateCode()
  return code
}

function touch(p: RoomPlayer) {
  p.lastSeen = Date.now()
}

export function createRoom(userId: string, username: string): Room {
  leaveAll(userId)
  const code = generateCode()
  const room: Room = {
    code,
    hostId: userId,
    players: new Map(),
    ready: new Set(),
    events: [],
    nextEventId: 1,
    createdAt: Date.now(),
  }
  room.players.set(userId, { userId, username, role: 'p1', lastSeen: Date.now() })
  store().rooms.set(code, room)
  store().userRoom.set(userId, code)
  return room
}

export function joinRoom(code: string, userId: string, username: string): Room {
  const room = store().rooms.get(code.toUpperCase())
  if (!room) throw new Error('Camera nu există')
  if (room.players.has(userId)) {
    touch(room.players.get(userId)!)
    store().userRoom.set(userId, room.code)
    return room
  }
  if (room.players.size >= 2) throw new Error('Camera e plină')
  leaveAll(userId)
  room.players.set(userId, { userId, username, role: 'p2', lastSeen: Date.now() })
  store().userRoom.set(userId, room.code)
  pushEvent(room, userId, username, { type: 'player-joined', username })
  return room
}

export function getRoom(code: string): Room | undefined {
  return store().rooms.get(code.toUpperCase())
}

export function getRoomByUser(userId: string): Room | undefined {
  const code = store().userRoom.get(userId)
  return code ? store().rooms.get(code) : undefined
}

export function leaveAll(userId: string) {
  const s = store()
  const code = s.userRoom.get(userId)
  if (!code) return
  const room = s.rooms.get(code)
  s.userRoom.delete(userId)
  if (!room) return
  room.players.delete(userId)
  room.ready.delete(userId)
  if (room.players.size === 0) {
    s.rooms.delete(code)
  } else {
    pushEvent(room, userId, '?', { type: 'peer-left', userId })
  }
}

export function markReady(code: string, userId: string): boolean {
  const room = store().rooms.get(code.toUpperCase())
  if (!room || !room.players.has(userId)) return false
  room.ready.add(userId)
  return room.ready.size >= 2
}

export function pushEvent(
  room: Room,
  from: string,
  fromName: string,
  payload: Record<string, unknown>,
): RoomEvent {
  const ev: RoomEvent = {
    id: room.nextEventId++,
    at: Date.now(),
    from,
    fromName,
    payload,
  }
  room.events.push(ev)
  // keep last 200 events
  if (room.events.length > 200) room.events.splice(0, room.events.length - 200)
  return ev
}

export function pollEvents(room: Room, afterId: number): RoomEvent[] {
  return room.events.filter((e) => e.id > afterId)
}

export function roomPublic(room: Room) {
  return {
    code: room.code,
    players: [...room.players.values()].map((p) => ({
      userId: p.userId,
      username: p.username,
      role: p.role,
      ready: room.ready.has(p.userId),
    })),
  }
}

export function heartbeat(userId: string) {
  const room = getRoomByUser(userId)
  if (!room) return
  const p = room.players.get(userId)
  if (p) touch(p)
}

/** drop stale rooms (2h) */
export function cleanupRooms() {
  const maxAge = 2 * 60 * 60 * 1000
  const now = Date.now()
  const s = store()
  for (const [code, room] of s.rooms) {
    if (now - room.createdAt > maxAge) {
      for (const uid of room.players.keys()) s.userRoom.delete(uid)
      s.rooms.delete(code)
    }
  }
}
