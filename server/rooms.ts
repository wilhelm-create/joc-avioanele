/**
 * Durable rooms for multiplayer (Vercel Blob or local file).
 * In-memory-only broke invites: guest hit a different serverless instance.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { get, put } from '@vercel/blob'

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

interface RoomJSON {
  code: string
  hostId: string
  players: RoomPlayer[]
  ready: string[]
  events: RoomEvent[]
  nextEventId: number
  createdAt: number
}

interface RoomsFile {
  rooms: RoomJSON[]
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_DIR = path.join(__dirname, '..', 'data')
const LOCAL_FILE = path.join(LOCAL_DIR, 'rooms.json')
const BLOB_PATH = 'avioane-rooms.json'
const MAX_AGE_MS = 2 * 60 * 60 * 1000
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN)

/** serialize lock: queue writes so concurrent requests don't clobber */
let chain: Promise<void> = Promise.resolve()

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function emptyFile(): RoomsFile {
  return { rooms: [] }
}

function roomToJson(room: Room): RoomJSON {
  return {
    code: room.code,
    hostId: room.hostId,
    players: [...room.players.values()],
    ready: [...room.ready],
    events: room.events.slice(-200),
    nextEventId: room.nextEventId,
    createdAt: room.createdAt,
  }
}

function roomFromJson(j: RoomJSON): Room {
  return {
    code: j.code,
    hostId: j.hostId,
    players: new Map(j.players.map((p) => [p.userId, p])),
    ready: new Set(j.ready),
    events: j.events || [],
    nextEventId: j.nextEventId || 1,
    createdAt: j.createdAt,
  }
}

function loadLocal(): RoomsFile {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true })
  if (!fs.existsSync(LOCAL_FILE)) {
    const e = emptyFile()
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(e), 'utf8')
    return e
  }
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')) as RoomsFile
  } catch {
    return emptyFile()
  }
}

function saveLocal(data: RoomsFile) {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true })
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(data), 'utf8')
}

async function loadBlob(): Promise<RoomsFile> {
  try {
    const result = await get(BLOB_PATH, { access: 'private', useCache: false })
    if (!result || result.statusCode !== 200 || !result.stream) return emptyFile()
    const body = await new Response(result.stream).text()
    if (!body) return emptyFile()
    const data = JSON.parse(body) as RoomsFile
    if (!data || !Array.isArray(data.rooms)) return emptyFile()
    return data
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not found|404|BlobNotFound/i.test(msg)) return emptyFile()
    console.error('rooms blob load failed', e)
    return emptyFile()
  }
}

async function saveBlob(data: RoomsFile) {
  await put(BLOB_PATH, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

async function loadAll(): Promise<Map<string, Room>> {
  const file = useBlob() ? await loadBlob() : loadLocal()
  const map = new Map<string, Room>()
  const now = Date.now()
  for (const j of file.rooms) {
    if (now - j.createdAt > MAX_AGE_MS) continue
    map.set(j.code.toUpperCase(), roomFromJson(j))
  }
  return map
}

async function saveAll(map: Map<string, Room>) {
  const file: RoomsFile = {
    rooms: [...map.values()].map(roomToJson),
  }
  if (useBlob()) await saveBlob(file)
  else saveLocal(file)
}

function genCode(existing: Map<string, Room>): string {
  let code = ''
  for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  if (existing.has(code)) return genCode(existing)
  return code
}

function touch(p: RoomPlayer) {
  p.lastSeen = Date.now()
}

function removeUserFromMap(map: Map<string, Room>, userId: string) {
  for (const room of map.values()) {
    if (!room.players.has(userId)) continue
    room.players.delete(userId)
    room.ready.delete(userId)
    if (room.players.size === 0) {
      map.delete(room.code)
    } else {
      pushEventSync(room, userId, '?', { type: 'peer-left', userId })
    }
  }
}

function pushEventSync(
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
  if (room.events.length > 200) room.events.splice(0, room.events.length - 200)
  return ev
}

export async function createRoom(userId: string, username: string): Promise<Room> {
  return withLock(async () => {
    const map = await loadAll()
    removeUserFromMap(map, userId)
    const code = genCode(map)
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
    map.set(code, room)
    await saveAll(map)
    return room
  })
}

export async function joinRoom(code: string, userId: string, username: string): Promise<Room> {
  return withLock(async () => {
    const map = await loadAll()
    const key = code.toUpperCase().trim()
    const room = map.get(key)
    if (!room) {
      const err = new Error('ROOM_NOT_FOUND')
      throw err
    }
    if (room.players.has(userId)) {
      touch(room.players.get(userId)!)
      await saveAll(map)
      return room
    }
    if (room.players.size >= 2) throw new Error('ROOM_FULL')
    removeUserFromMap(map, userId)
    room.players.set(userId, { userId, username, role: 'p2', lastSeen: Date.now() })
    pushEventSync(room, userId, username, { type: 'player-joined', username })
    if (room.players.size >= 2) {
      pushEventSync(room, userId, username, { type: 'both-joined' })
    }
    await saveAll(map)
    return room
  })
}

export async function getRoom(code: string): Promise<Room | undefined> {
  const map = await loadAll()
  return map.get(code.toUpperCase())
}

export async function getRoomByUser(userId: string): Promise<Room | undefined> {
  const map = await loadAll()
  for (const room of map.values()) {
    if (room.players.has(userId)) return room
  }
  return undefined
}

export async function leaveAll(userId: string): Promise<void> {
  return withLock(async () => {
    const map = await loadAll()
    removeUserFromMap(map, userId)
    await saveAll(map)
  })
}

export async function markReady(code: string, userId: string): Promise<boolean> {
  return withLock(async () => {
    const map = await loadAll()
    const room = map.get(code.toUpperCase())
    if (!room || !room.players.has(userId)) return false
    room.ready.add(userId)
    await saveAll(map)
    return room.ready.size >= 2
  })
}

export async function pushEvent(
  code: string,
  from: string,
  fromName: string,
  payload: Record<string, unknown>,
): Promise<Room | undefined> {
  return withLock(async () => {
    const map = await loadAll()
    const room = map.get(code.toUpperCase())
    if (!room) return undefined
    pushEventSync(room, from, fromName, payload)
    await saveAll(map)
    return room
  })
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

/** Lightweight presence — avoid Blob write on every poll. */
export async function heartbeat(_userId: string): Promise<void> {
  // no-op: durable rooms don't need frequent lastSeen writes
  void _userId
}

export async function cleanupRooms(): Promise<void> {
  return withLock(async () => {
    const map = await loadAll()
    // loadAll already drops expired; persist cleaned set
    await saveAll(map)
  })
}

/** Sync helpers for local WS path that still expects Room objects */
export function generateCode(): string {
  let code = ''
  for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return code
}
