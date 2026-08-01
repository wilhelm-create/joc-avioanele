import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { get, put } from '@vercel/blob'
import { isValidEmailFormat } from './email.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_DIR = path.join(__dirname, '..', 'data')
const LOCAL_FILE = path.join(LOCAL_DIR, 'users.json')
const BLOB_PATH = 'avioane-users.json'

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  email: string
  emailVerified: boolean
  /** data:image/...;base64,... or empty */
  avatarDataUrl: string
  emailVerifyToken: string | null
  emailVerifyExpires: number | null
  resetToken: string | null
  resetExpires: number | null
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
  email: string
  emailVerified: boolean
  avatarDataUrl: string
  createdAt: string
  wins: number
  losses: number
  gamesPlayed: number
}

function publicUser(u: UserRecord): PublicUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email || '',
    emailVerified: Boolean(u.emailVerified),
    avatarDataUrl: u.avatarDataUrl || '',
    createdAt: u.createdAt,
    wins: u.wins,
    losses: u.losses,
    gamesPlayed: u.gamesPlayed,
  }
}

/** Migrate legacy users missing email fields */
function normalizeUser(u: UserRecord): UserRecord {
  return {
    ...u,
    email: u.email || '',
    emailVerified: Boolean(u.emailVerified),
    avatarDataUrl: u.avatarDataUrl || '',
    emailVerifyToken: u.emailVerifyToken ?? null,
    emailVerifyExpires: u.emailVerifyExpires ?? null,
    resetToken: u.resetToken ?? null,
    resetExpires: u.resetExpires ?? null,
  }
}

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN)

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
  db.users = (db.users || []).map((u) => normalizeUser(u as UserRecord))
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

function token(): string {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
}

export async function findByUsername(username: string): Promise<UserRecord | undefined> {
  const db = await loadStore()
  return db.users.find((u) => u.username.toLowerCase() === username.toLowerCase())
}

export async function findByEmail(email: string): Promise<UserRecord | undefined> {
  const e = email.trim().toLowerCase()
  if (!e) return undefined
  const db = await loadStore()
  return db.users.find((u) => (u.email || '').toLowerCase() === e)
}

export async function findById(id: string): Promise<UserRecord | undefined> {
  const db = await loadStore()
  return db.users.find((u) => u.id === id)
}

export async function createUser(
  username: string,
  password: string,
  email: string,
): Promise<{ user: PublicUser; verifyToken: string }> {
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
  const mail = email.trim().toLowerCase()
  if (!isValidEmailFormat(mail)) {
    throw new Error('Adresă de email invalidă')
  }

  const db = await loadStore()
  if (db.users.some((u) => u.username.toLowerCase() === clean.toLowerCase())) {
    throw new Error('Username-ul este deja folosit')
  }
  if (db.users.some((u) => (u.email || '').toLowerCase() === mail)) {
    throw new Error('Email-ul este deja folosit')
  }

  const verifyToken = token()
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username: clean,
    passwordHash: bcrypt.hashSync(password, 10),
    email: mail,
    emailVerified: false,
    avatarDataUrl: '',
    emailVerifyToken: verifyToken,
    emailVerifyExpires: Date.now() + 24 * 60 * 60 * 1000,
    resetToken: null,
    resetExpires: null,
    createdAt: new Date().toISOString(),
    wins: 0,
    losses: 0,
    gamesPlayed: 0,
  }
  db.users.push(user)
  await saveStore(db)
  return { user: publicUser(user), verifyToken }
}

export async function verifyLogin(usernameOrEmail: string, password: string): Promise<PublicUser> {
  mem = null
  const id = usernameOrEmail.trim()
  let user = await findByUsername(id)
  if (!user && id.includes('@')) user = await findByEmail(id)
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    throw new Error('Username/email sau parolă greșită')
  }
  if (!user.emailVerified && user.email) {
    throw new Error('EMAIL_NOT_VERIFIED')
  }
  // Legacy users without email: mark verified and persist
  if (!user.email && !user.emailVerified) {
    const db = await loadStore()
    const u = db.users.find((x) => x.id === user.id)
    if (u) {
      u.emailVerified = true
      await saveStore(db)
      return publicUser(u)
    }
  }
  return publicUser(user)
}

export async function verifyEmailToken(tokenStr: string): Promise<PublicUser> {
  mem = null
  const db = await loadStore()
  const user = db.users.find((u) => u.emailVerifyToken === tokenStr)
  if (!user) throw new Error('Link invalid sau expirat')
  if (!user.emailVerifyExpires || user.emailVerifyExpires < Date.now()) {
    throw new Error('Linkul de verificare a expirat')
  }
  user.emailVerified = true
  user.emailVerifyToken = null
  user.emailVerifyExpires = null
  await saveStore(db)
  return publicUser(user)
}

export async function resendVerification(usernameOrEmail: string): Promise<{ user: UserRecord; verifyToken: string }> {
  mem = null
  const id = usernameOrEmail.trim()
  let user = await findByUsername(id)
  if (!user && id.includes('@')) user = await findByEmail(id)
  if (!user) throw new Error('Cont negăsit')
  if (user.emailVerified) throw new Error('Email deja confirmat')
  if (!user.email) throw new Error('Contul nu are email')
  const db = await loadStore()
  const u = db.users.find((x) => x.id === user!.id)!
  const verifyToken = token()
  u.emailVerifyToken = verifyToken
  u.emailVerifyExpires = Date.now() + 24 * 60 * 60 * 1000
  await saveStore(db)
  return { user: u, verifyToken }
}

export async function requestPasswordReset(email: string): Promise<{ user: UserRecord; resetToken: string } | null> {
  mem = null
  const user = await findByEmail(email)
  // Always opaque — don't reveal if email exists
  if (!user) return null
  const db = await loadStore()
  const u = db.users.find((x) => x.id === user.id)!
  const resetToken = token()
  u.resetToken = resetToken
  u.resetExpires = Date.now() + 60 * 60 * 1000
  await saveStore(db)
  return { user: u, resetToken }
}

export async function resetPasswordWithToken(tokenStr: string, newPassword: string): Promise<PublicUser> {
  if (newPassword.length < 6) throw new Error('Parola trebuie să aibă minim 6 caractere')
  mem = null
  const db = await loadStore()
  const user = db.users.find((u) => u.resetToken === tokenStr)
  if (!user) throw new Error('Link invalid sau expirat')
  if (!user.resetExpires || user.resetExpires < Date.now()) {
    throw new Error('Linkul de resetare a expirat')
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10)
  user.resetToken = null
  user.resetExpires = null
  await saveStore(db)
  return publicUser(user)
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 6) throw new Error('Parola nouă trebuie să aibă minim 6 caractere')
  mem = null
  const db = await loadStore()
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error('Cont negăsit')
  if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
    throw new Error('Parola actuală este greșită')
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10)
  await saveStore(db)
}

export async function changeEmail(
  userId: string,
  newEmail: string,
): Promise<{ user: PublicUser; verifyToken: string }> {
  const mail = newEmail.trim().toLowerCase()
  if (!isValidEmailFormat(mail)) throw new Error('Adresă de email invalidă')
  mem = null
  const db = await loadStore()
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error('Cont negăsit')
  if (db.users.some((u) => u.id !== userId && (u.email || '').toLowerCase() === mail)) {
    throw new Error('Email-ul este deja folosit')
  }
  const verifyToken = token()
  user.email = mail
  user.emailVerified = false
  user.emailVerifyToken = verifyToken
  user.emailVerifyExpires = Date.now() + 24 * 60 * 60 * 1000
  await saveStore(db)
  return { user: publicUser(user), verifyToken }
}

const MAX_AVATAR_CHARS = 180_000 // ~135KB base64

export async function setAvatar(userId: string, dataUrl: string): Promise<PublicUser> {
  const raw = (dataUrl || '').trim()
  if (!raw) {
    mem = null
    const db = await loadStore()
    const user = db.users.find((u) => u.id === userId)
    if (!user) throw new Error('Cont negăsit')
    user.avatarDataUrl = ''
    await saveStore(db)
    return publicUser(user)
  }
  if (!raw.startsWith('data:image/')) {
    throw new Error('Doar imagini (JPEG/PNG/WebP)')
  }
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(raw)) {
    throw new Error('Format acceptat: JPEG, PNG sau WebP')
  }
  if (raw.length > MAX_AVATAR_CHARS) {
    throw new Error('Imaginea e prea mare (max ~120 KB)')
  }
  mem = null
  const db = await loadStore()
  const user = db.users.find((u) => u.id === userId)
  if (!user) throw new Error('Cont negăsit')
  user.avatarDataUrl = raw
  await saveStore(db)
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
