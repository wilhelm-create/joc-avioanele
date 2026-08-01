/**
 * Durable multiplayer rooms — one Blob (or local file) per room code.
 * Avoids last-write-wins corruption from a single shared rooms.json on serverless.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { del, get, put } from '@vercel/blob'

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

export type Difficulty = 'easy' | 'medium' | 'hard' | 'impossible'

export interface GameSettings {
  difficulty: Difficulty
  gridSize: number
  planesPerPlayer: number
  longWings: boolean
  planeColor: string
}

export const DEFAULT_ROOM_SETTINGS: GameSettings = {
  difficulty: 'medium',
  gridSize: 10,
  planesPerPlayer: 3,
  longWings: false,
  planeColor: '#e8956a',
}

export function clampRoomSettings(raw: Partial<GameSettings> | null | undefined): GameSettings {
  const base = { ...DEFAULT_ROOM_SETTINGS, ...(raw || {}) }
  let gridSize = Math.round(Number(base.gridSize) || 10)
  gridSize = Math.min(14, Math.max(8, gridSize))
  let planes = Math.round(Number(base.planesPerPlayer) || 3)
  const maxForGrid = Math.min(12, Math.max(1, Math.floor((gridSize * gridSize) / 14)))
  planes = Math.min(maxForGrid, Math.max(1, planes))
  const difficulty = (['easy', 'medium', 'hard', 'impossible'] as Difficulty[]).includes(
    base.difficulty as Difficulty,
  )
    ? (base.difficulty as Difficulty)
    : 'medium'
  let planeColor = String(base.planeColor || '#e8956a')
  if (!/^#[0-9a-fA-F]{6}$/.test(planeColor)) planeColor = '#e8956a'
  return {
    difficulty,
    gridSize,
    planesPerPlayer: planes,
    longWings: Boolean(base.longWings),
    planeColor,
  }
}

export interface Room {
  code: string
  hostId: string
  players: Map<string, RoomPlayer>
  ready: Set<string>
  events: RoomEvent[]
  nextEventId: number
  createdAt: number
  settings: GameSettings
}

interface RoomJSON {
  code: string
  hostId: string
  players: RoomPlayer[]
  ready: string[]
  events: RoomEvent[]
  nextEventId: number
  createdAt: number
  settings?: GameSettings
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_DIR = path.join(__dirname, '..', 'data', 'rooms')
const MAX_AGE_MS = 4 * 60 * 60 * 1000 // 4h invite window
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN)

function roomPath(code: string) {
  return `avioane-room-${code.toUpperCase()}.json`
}

function playerPath(userId: string) {
  // keep pathname filesystem-safe
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '')
  return `avioane-player-${safe}.json`
}

function localRoomFile(code: string) {
  return path.join(LOCAL_DIR, `${code.toUpperCase()}.json`)
}

function localPlayerFile(userId: string) {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '')
  return path.join(LOCAL_DIR, `player-${safe}.json`)
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
    settings: room.settings || DEFAULT_ROOM_SETTINGS,
  }
}

function roomFromJson(j: RoomJSON): Room {
  return {
    code: j.code,
    hostId: j.hostId,
    players: new Map((j.players || []).map((p) => [p.userId, p])),
    ready: new Set(j.ready || []),
    events: j.events || [],
    nextEventId: j.nextEventId || 1,
    createdAt: j.createdAt,
    settings: clampRoomSettings(j.settings),
  }
}

function isExpired(room: Room | RoomJSON): boolean {
  return Date.now() - room.createdAt > MAX_AGE_MS
}

async function readBlobJson<T>(pathname: string): Promise<T | null> {
  try {
    const result = await get(pathname, { access: 'private', useCache: false })
    if (!result || result.statusCode !== 200 || !result.stream) return null
    const body = await new Response(result.stream).text()
    if (!body) return null
    return JSON.parse(body) as T
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not found|404|BlobNotFound/i.test(msg)) return null
    console.error('blob read failed', pathname, e)
    return null
  }
}

async function writeBlobJson(pathname: string, data: unknown) {
  await put(pathname, JSON.stringify(data), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

async function deleteBlob(pathname: string) {
  try {
    await del(pathname)
  } catch {
    /* ignore */
  }
}

function readLocalJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function writeLocalJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')
}

function deleteLocal(file: string) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch {
    /* ignore */
  }
}

async function loadRoom(code: string): Promise<Room | null> {
  const key = code.toUpperCase().trim()
  if (!key) return null
  const j = useBlob()
    ? await readBlobJson<RoomJSON>(roomPath(key))
    : readLocalJson<RoomJSON>(localRoomFile(key))
  if (!j) return null
  if (isExpired(j)) {
    await deleteRoomFiles(key)
    return null
  }
  return roomFromJson(j)
}

async function saveRoom(room: Room): Promise<void> {
  const j = roomToJson(room)
  if (useBlob()) await writeBlobJson(roomPath(room.code), j)
  else writeLocalJson(localRoomFile(room.code), j)
}

async function deleteRoomFiles(code: string) {
  const key = code.toUpperCase()
  if (useBlob()) await deleteBlob(roomPath(key))
  else deleteLocal(localRoomFile(key))
}

/** Player may belong to multiple rooms at once. */
interface PlayerIndex {
  /** Multi-room list */
  codes?: string[]
  /** Legacy single-room field */
  code?: string
}

async function getPlayerCodes(userId: string): Promise<string[]> {
  const j = useBlob()
    ? await readBlobJson<PlayerIndex>(playerPath(userId))
    : readLocalJson<PlayerIndex>(localPlayerFile(userId))
  if (!j) return []
  if (Array.isArray(j.codes) && j.codes.length) {
    return [...new Set(j.codes.map((c) => String(c).toUpperCase().trim()).filter(Boolean))]
  }
  if (j.code) return [String(j.code).toUpperCase().trim()]
  return []
}

async function setPlayerCodes(userId: string, codes: string[]): Promise<void> {
  const unique = [...new Set(codes.map((c) => c.toUpperCase().trim()).filter(Boolean))]
  if (unique.length === 0) {
    if (useBlob()) await deleteBlob(playerPath(userId))
    else deleteLocal(localPlayerFile(userId))
    return
  }
  const data: PlayerIndex = { codes: unique }
  if (useBlob()) await writeBlobJson(playerPath(userId), data)
  else writeLocalJson(localPlayerFile(userId), data)
}

async function addPlayerRoom(userId: string, code: string): Promise<void> {
  const codes = await getPlayerCodes(userId)
  const key = code.toUpperCase().trim()
  if (!codes.includes(key)) codes.push(key)
  await setPlayerCodes(userId, codes)
}

async function removePlayerRoom(userId: string, code: string): Promise<void> {
  const key = code.toUpperCase().trim()
  const codes = (await getPlayerCodes(userId)).filter((c) => c !== key)
  await setPlayerCodes(userId, codes)
}

function genCode(): string {
  let code = ''
  for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return code
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

/** Detach user from one room (keep room alive for the other player). */
async function detachFromRoom(userId: string, code: string): Promise<void> {
  const key = code.toUpperCase().trim()
  const room = await loadRoom(key)
  if (room?.players.has(userId)) {
    room.players.delete(userId)
    room.ready.delete(userId)
    pushEventSync(room, userId, '?', { type: 'peer-left', userId })
    await saveRoom(room)
  }
  await removePlayerRoom(userId, key)
}

export async function createRoom(userId: string, username: string): Promise<Room> {
  // Always create a NEW room so a player can host multiple games at once
  let code = genCode()
  for (let i = 0; i < 8; i++) {
    const clash = await loadRoom(code)
    if (!clash) break
    code = genCode()
  }

  const room: Room = {
    code,
    hostId: userId,
    players: new Map(),
    ready: new Set(),
    events: [],
    nextEventId: 1,
    createdAt: Date.now(),
    settings: { ...DEFAULT_ROOM_SETTINGS },
  }
  room.players.set(userId, { userId, username, role: 'p1', lastSeen: Date.now() })
  await saveRoom(room)
  await addPlayerRoom(userId, code)

  const verify = await loadRoom(code)
  if (!verify) {
    throw new Error('ROOM_SAVE_FAILED')
  }
  return verify
}

export async function joinRoom(code: string, userId: string, username: string): Promise<Room> {
  const key = code.toUpperCase().trim()
  if (key.length < 4) throw new Error('ROOM_NOT_FOUND')

  // retry read a few times (eventual consistency)
  let room: Room | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    room = await loadRoom(key)
    if (room) break
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
  }
  if (!room) throw new Error('ROOM_NOT_FOUND')

  if (room.players.has(userId)) {
    const p = room.players.get(userId)!
    p.lastSeen = Date.now()
    p.username = username
    await saveRoom(room)
    await addPlayerRoom(userId, room.code)
    return room
  }

  // host re-joining empty seat
  if (userId === room.hostId) {
    room.players.set(userId, { userId, username, role: 'p1', lastSeen: Date.now() })
    await saveRoom(room)
    await addPlayerRoom(userId, room.code)
    return room
  }

  if (room.players.size >= 2) throw new Error('ROOM_FULL')

  // Do NOT leave other games — multi-game support
  room.players.set(userId, { userId, username, role: 'p2', lastSeen: Date.now() })
  pushEventSync(room, userId, username, { type: 'player-joined', username })
  if (room.players.size >= 2) {
    pushEventSync(room, userId, username, { type: 'both-joined' })
  }
  await saveRoom(room)
  await addPlayerRoom(userId, room.code)
  return room
}

export async function getRoom(code: string): Promise<Room | undefined> {
  return (await loadRoom(code)) || undefined
}

/**
 * Resolve a room for the user.
 * @param preferredCode when set, that room (if member); else first valid membership
 */
export async function getRoomByUser(
  userId: string,
  preferredCode?: string | null,
): Promise<Room | undefined> {
  const codes = await getPlayerCodes(userId)
  if (!codes.length) return undefined

  const tryLoad = async (code: string): Promise<Room | undefined> => {
    const room = await loadRoom(code)
    if (!room) {
      await removePlayerRoom(userId, code)
      return undefined
    }
    if (!room.players.has(userId) && room.hostId === userId) {
      room.players.set(userId, {
        userId,
        username: 'Host',
        role: 'p1',
        lastSeen: Date.now(),
      })
      await saveRoom(room)
    }
    if (!room.players.has(userId)) {
      await removePlayerRoom(userId, code)
      return undefined
    }
    return room
  }

  if (preferredCode) {
    const key = preferredCode.toUpperCase().trim()
    if (codes.includes(key)) {
      const room = await tryLoad(key)
      if (room) return room
    }
  }

  for (const code of codes) {
    const room = await tryLoad(code)
    if (room) return room
  }
  return undefined
}

export type ActiveGameInfo = {
  code: string
  role: Role
  opponentName: string | null
  opponentUserId: string | null
  playersCount: number
  bothReady: boolean
  status: 'waiting' | 'placing' | 'battle'
}

/** All non-expired rooms this user is still in (for Active Games UI). */
export async function listActiveGames(userId: string): Promise<ActiveGameInfo[]> {
  const codes = await getPlayerCodes(userId)
  const out: ActiveGameInfo[] = []
  for (const code of codes) {
    const room = await loadRoom(code)
    if (!room) {
      await removePlayerRoom(userId, code)
      continue
    }
    const me = room.players.get(userId)
    if (!me && room.hostId !== userId) {
      await removePlayerRoom(userId, code)
      continue
    }
    const role: Role = me?.role ?? 'p1'
    const opponent = [...room.players.values()].find((p) => p.userId !== userId) || null
    let status: ActiveGameInfo['status'] = 'waiting'
    if (room.ready.size >= 2) status = 'battle'
    else if (room.players.size >= 2) status = 'placing'
    out.push({
      code: room.code,
      role,
      opponentName: opponent?.username ?? null,
      opponentUserId: opponent?.userId ?? null,
      playersCount: room.players.size,
      bothReady: room.ready.size >= 2,
      status,
    })
  }
  return out
}

/** Leave one room (or all if code omitted). Rooms stay for the other player. */
export async function leaveRoom(userId: string, code?: string | null): Promise<void> {
  if (code) {
    await detachFromRoom(userId, code)
    return
  }
  const codes = await getPlayerCodes(userId)
  for (const c of codes) await detachFromRoom(userId, c)
}

export async function leaveAll(userId: string): Promise<void> {
  await leaveRoom(userId, null)
}

/**
 * Mark player ready. Retries + merges ready set to survive concurrent Blob writes
 * (both players finishing placement at the same time).
 */
export async function markReady(code: string, userId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const room = await loadRoom(code)
    if (!room || !room.players.has(userId)) return false
    const prior = new Set(room.ready)
    room.ready.add(userId)
    await saveRoom(room)

    const again = await loadRoom(code)
    if (!again) return false
    let missing = false
    for (const id of prior) {
      if (!again.ready.has(id)) {
        again.ready.add(id)
        missing = true
      }
    }
    if (!again.ready.has(userId)) {
      again.ready.add(userId)
      missing = true
    }
    if (missing) {
      await saveRoom(again)
      continue
    }
    return again.ready.size >= 2
  }
  const room = await loadRoom(code)
  return Boolean(room && room.ready.size >= 2)
}

/**
 * Append event with merge-retry so concurrent placement/ready/shot writes
 * do not clobber each other on Blob last-write-wins.
 */
export async function pushEvent(
  code: string,
  from: string,
  fromName: string,
  payload: Record<string, unknown>,
): Promise<Room | undefined> {
  let lastEvId = -1
  for (let attempt = 0; attempt < 8; attempt++) {
    const room = await loadRoom(code)
    if (!room) return undefined

    // Keep ready set from disk (may have been updated by concurrent markReady)
    const readySnap = new Set(room.ready)
    const playersSnap = new Map(room.players)

    const maxExisting = room.events.reduce((m, e) => Math.max(m, e.id), 0)
    room.nextEventId = Math.max(room.nextEventId, maxExisting + 1)
    const ev = pushEventSync(room, from, fromName, payload)
    lastEvId = ev.id
    await saveRoom(room)

    const again = await loadRoom(code)
    if (!again) return undefined

    // merge ready + players
    for (const id of readySnap) again.ready.add(id)
    for (const [uid, pl] of playersSnap) {
      if (!again.players.has(uid)) again.players.set(uid, pl)
    }
    // merge events by id
    const byId = new Map<number, RoomEvent>()
    for (const e of again.events) byId.set(e.id, e)
    for (const e of room.events) byId.set(e.id, e)
    again.events = [...byId.values()].sort((a, b) => a.id - b.id).slice(-200)
    again.nextEventId = Math.max(
      again.nextEventId,
      room.nextEventId,
      again.events.reduce((m, e) => Math.max(m, e.id + 1), 1),
    )

    await saveRoom(again)

    if (again.events.some((e) => e.id === lastEvId)) return again
  }
  return (await loadRoom(code)) ?? undefined
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
    settings: clampRoomSettings(room.settings),
  }
}

/**
 * Update match settings. Clears ready flags so both must re-confirm fleets
 * if geometry (grid / planes / wings) changed.
 */
export async function updateRoomSettings(
  code: string,
  userId: string,
  raw: Partial<GameSettings>,
): Promise<Room | undefined> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const room = await loadRoom(code)
    if (!room || !room.players.has(userId)) return undefined
    const next = clampRoomSettings({ ...room.settings, ...raw })
    const geometryChanged =
      next.gridSize !== room.settings.gridSize ||
      next.planesPerPlayer !== room.settings.planesPerPlayer ||
      next.longWings !== room.settings.longWings
    room.settings = next
    if (geometryChanged) {
      room.ready.clear()
    }
    pushEventSync(room, userId, room.players.get(userId)?.username || '?', {
      type: 'settings',
      settings: next,
      geometryChanged,
    })
    await saveRoom(room)
    const again = await loadRoom(code)
    if (again && again.settings.gridSize === next.gridSize) return again
  }
  return loadRoom(code) ?? undefined
}

export async function heartbeat(_userId: string): Promise<void> {
  void _userId
}

export async function cleanupRooms(): Promise<void> {
  // expired rooms are dropped lazily on loadRoom
}

export function generateCode(): string {
  return genCode()
}
