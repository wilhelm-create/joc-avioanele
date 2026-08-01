import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** On Vercel the app FS is read-only; persist under /tmp (warm instances keep data). */
const DATA_DIR = process.env.VERCEL
  ? path.join(os.tmpdir(), 'avioane-data')
  : path.join(__dirname, '..', 'data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')

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

function ensureStore(): DbShape {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(USERS_FILE)) {
    const empty: DbShape = { users: [] }
    fs.writeFileSync(USERS_FILE, JSON.stringify(empty, null, 2), 'utf8')
    return empty
  }
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) as DbShape
  } catch {
    const empty: DbShape = { users: [] }
    fs.writeFileSync(USERS_FILE, JSON.stringify(empty, null, 2), 'utf8')
    return empty
  }
}

function save(db: DbShape) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), 'utf8')
}

function publicUser(u: UserRecord) {
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    wins: u.wins,
    losses: u.losses,
    gamesPlayed: u.gamesPlayed,
  }
}

export type PublicUser = ReturnType<typeof publicUser>

export function findByUsername(username: string): UserRecord | undefined {
  const db = ensureStore()
  return db.users.find((u) => u.username.toLowerCase() === username.toLowerCase())
}

export function findById(id: string): UserRecord | undefined {
  const db = ensureStore()
  return db.users.find((u) => u.id === id)
}

export function createUser(username: string, password: string): PublicUser {
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
  if (findByUsername(clean)) {
    throw new Error('Username-ul este deja folosit')
  }

  const db = ensureStore()
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
  save(db)
  return publicUser(user)
}

export function verifyLogin(username: string, password: string): PublicUser {
  const user = findByUsername(username.trim())
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    throw new Error('Username sau parolă greșită')
  }
  return publicUser(user)
}

export function getPublic(id: string): PublicUser | null {
  const u = findById(id)
  return u ? publicUser(u) : null
}

export function recordMatch(winnerId: string, loserId: string) {
  const db = ensureStore()
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
  save(db)
}

export function listLeaderboard(limit = 20): PublicUser[] {
  const db = ensureStore()
  return [...db.users]
    .sort((a, b) => b.wins - a.wins || b.gamesPlayed - a.gamesPlayed)
    .slice(0, limit)
    .map(publicUser)
}
