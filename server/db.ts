import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { get, put } from '@vercel/blob'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_DIR = path.join(__dirname, '..', 'data')
const LOCAL_FILE = path.join(LOCAL_DIR, 'users.json')
const BLOB_PATH = 'avioane-users.json'

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  createdAt: string
  wins: number
  losses: number
  gamesPlayed: number
}

interface DbShape {
  users: UserRecord[]
}

export type PublicUser = {
  id: string
  username: string
  createdAt: string
  wins: number
  losses: number
  gamesPlayed: number
}

function publicUser(u: UserRecord): PublicUser {
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    wins: u.wins,
    losses: u.losses,
    gamesPlayed: u.gamesPlayed,
  }
}

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN)

/** In-process cache (per warm instance) */
let mem: DbShape | null = null
let memAt = 0
const CACHE_MS = 2000

function empty(): DbShape {
  return { users: [] }
}

function loadLocal(): DbShape {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true })
  if (!fs.existsSync(LOCAL_FILE)) {
    const e = empty()
    fs.writeFileSync(LOCAL_FILE, JSON.stringify(e, null, 2), 'utf8')
    return e
  }
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8')) as DbShape
  } catch {
    return empty()
  }
}

function saveLocal(db: DbShape) {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true })
  fs.writeFileSync(LOCAL_FILE, JSON.stringify(db, null, 2), 'utf8')
}

async function loadBlob(): Promise<DbShape> {
  try {
    const result = await get(BLOB_PATH, { access: 'private', useCache: false })
    if (!result || result.statusCode !== 200 || !result.stream) return empty()
    const body = await new Response(result.stream).text()
    if (!body) return empty()
    const data = JSON.parse(body) as DbShape
    if (!data || !Array.isArray(data.users)) return empty()
    return data
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not found|404|BlobNotFound/i.test(msg)) return empty()
    console.error('blob load failed', e)
    return empty()
  }
}

async function saveBlob(db: DbShape) {
  await put(BLOB_PATH, JSON.stringify(db), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

async function loadStore(): Promise<DbShape> {
  if (mem && Date.now() - memAt < CACHE_MS) return mem
  const db = useBlob() ? await loadBlob() : loadLocal()
  mem = db
  memAt = Date.now()
  return db
}

async function saveStore(db: DbShape) {
  mem = db
  memAt = Date.now()
  if (useBlob()) await saveBlob(db)
  else saveLocal(db)
}

export async function findByUsername(username: string): Promise<UserRecord | undefined> {
  const db = await loadStore()
  return db.users.find((u) => u.username.toLowerCase() === username.toLowerCase())
}

export async function findById(id: string): Promise<UserRecord | undefined> {
  const db = await loadStore()
  return db.users.find((u) => u.id === id)
}

export async function createUser(username: string, password: string): Promise<PublicUser> {
  const clean = username.trim()
  if (clean.length < 3 || clean.length > 20) {
    throw new Error('Username-ul trebuie să aibă 3–20 caractere')
  }
  if (!/^[a-zA-Z0-9_ăâîșțĂÂÎȘȚ.-]+$/u.test(clean)) {
    throw new Error('Username: doar litere, cifre, _ . -')
  }
  if (password.length < 6) {
    throw new Error('Parola trebuie să aibă minim 6 caractere')
  }
  const db = await loadStore()
  if (db.users.some((u) => u.username.toLowerCase() === clean.toLowerCase())) {
    throw new Error('Username-ul este deja folosit')
  }

  const user: UserRecord = {
    id: crypto.randomUUID(),
    username: clean,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
    wins: 0,
    losses: 0,
    gamesPlayed: 0,
  }
  db.users.push(user)
  await saveStore(db)
  return publicUser(user)
}

export async function verifyLogin(username: string, password: string): Promise<PublicUser> {
  // force fresh read for login (avoid stale empty cache after cold start race)
  mem = null
  const user = await findByUsername(username.trim())
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    throw new Error('Username sau parolă greșită')
  }
  return publicUser(user)
}

export async function getPublic(id: string): Promise<PublicUser | null> {
  const u = await findById(id)
  return u ? publicUser(u) : null
}

export async function recordMatch(winnerId: string, loserId: string) {
  mem = null
  const db = await loadStore()
  const w = db.users.find((u) => u.id === winnerId)
  const l = db.users.find((u) => u.id === loserId)
  if (w) {
    w.wins++
    w.gamesPlayed++
  }
  if (l) {
    l.losses++
    l.gamesPlayed++
  }
  await saveStore(db)
}

export async function listLeaderboard(limit = 20): Promise<PublicUser[]> {
  const db = await loadStore()
  return [...db.users]
    .sort((a, b) => b.wins - a.wins || b.gamesPlayed - a.gamesPlayed)
    .slice(0, limit)
    .map(publicUser)
}

export function storageMode(): 'blob' | 'local' {
  return useBlob() ? 'blob' : 'local'
}
