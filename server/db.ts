import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { get, put } from '@vercel/blob'
import { isValidEmailFormat } from './email.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LOCAL_DIR = path.join(__dirname, '..', 'data')
const LOCAL_FILE = path.join(LOCAL_DIR, 'users.json')
const LOCAL_BACKUP_DIR = path.join(LOCAL_DIR, 'users.backups')
/** Primary blob + durable mirror so a blocked/failed primary can still recover. */
const BLOB_PATH = 'avioane-users.json'
const BLOB_BACKUP_PATH = 'avioane-users.backup.json'
const MAX_LOCAL_BACKUPS = 30
/** Refuse writing a store that drops more than this fraction of known accounts. */
const MAX_SHRINK_RATIO = 0.5

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
  /** Optional durability metadata (ignored by older readers). */
  meta?: {
    savedAt?: string
    userCount?: number
  }
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
/** Highest non-empty user count seen this process — blocks accidental wipe. */
let peakUserCount = 0
let lastBlobOk = true
let lastBlobError = ''
let lastSaveAt = ''
let healInFlight = false

function empty(): DbShape {
  return { users: [] }
}

function parseDb(raw: string): DbShape {
  if (!raw || !raw.trim()) return empty()
  try {
    const data = JSON.parse(raw) as DbShape
    if (!data || !Array.isArray(data.users)) return empty()
    return {
      users: data.users.map((u) => normalizeUser(u as UserRecord)),
      meta: data.meta,
    }
  } catch {
    return empty()
  }
}

function userRichness(u: UserRecord): number {
  return (
    (u.passwordHash ? 100 : 0) +
    (u.email ? 20 : 0) +
    (u.emailVerified ? 10 : 0) +
    (u.avatarDataUrl ? 5 : 0) +
    (u.wins || 0) * 3 +
    (u.gamesPlayed || 0) +
    (u.losses || 0)
  )
}

/** Prefer the more complete / progressed account when merging duplicates by id. */
function pickRicher(a: UserRecord, b: UserRecord): UserRecord {
  const sa = userRichness(a)
  const sb = userRichness(b)
  if (sb > sa) return b
  if (sa > sb) return a
  // tie: keep password from whichever has one; prefer later createdAt
  const aTime = Date.parse(a.createdAt || '') || 0
  const bTime = Date.parse(b.createdAt || '') || 0
  return bTime >= aTime ? b : a
}

export function mergeUserLists(lists: UserRecord[][]): UserRecord[] {
  const byId = new Map<string, UserRecord>()
  const byName = new Map<string, string>() // username lower → id

  for (const list of lists) {
    for (const raw of list) {
      if (!raw || !raw.id || !raw.username) continue
      const u = normalizeUser(raw)
      const prev = byId.get(u.id)
      const chosen = prev ? pickRicher(prev, u) : u
      byId.set(u.id, chosen)

      const nameKey = chosen.username.toLowerCase()
      const existingId = byName.get(nameKey)
      if (!existingId) {
        byName.set(nameKey, chosen.id)
      } else if (existingId !== chosen.id) {
        // Same username, different ids — keep richer, drop the weaker id
        const other = byId.get(existingId)
        if (other) {
          const winner = pickRicher(other, chosen)
          const loserId = winner.id === chosen.id ? existingId : chosen.id
          byId.delete(loserId)
          byId.set(winner.id, winner)
          byName.set(nameKey, winner.id)
        }
      }
    }
  }
  return [...byId.values()]
}

function withMeta(db: DbShape): DbShape {
  return {
    users: db.users,
    meta: {
      savedAt: new Date().toISOString(),
      userCount: db.users.length,
    },
  }
}

function ensureLocalDirs() {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true })
  if (!fs.existsSync(LOCAL_BACKUP_DIR)) fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true })
}

function loadLocalFile(filePath: string): DbShape {
  try {
    if (!fs.existsSync(filePath)) return empty()
    return parseDb(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return empty()
  }
}

function loadLocal(): DbShape {
  ensureLocalDirs()
  if (!fs.existsSync(LOCAL_FILE)) {
    // Do NOT write empty on first missing file when we might still recover from blob/backups
    return empty()
  }
  return loadLocalFile(LOCAL_FILE)
}

function listLocalBackupFiles(): string[] {
  ensureLocalDirs()
  try {
    return fs
      .readdirSync(LOCAL_BACKUP_DIR)
      .filter((f) => f.startsWith('users-') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map((f) => path.join(LOCAL_BACKUP_DIR, f))
  } catch {
    return []
  }
}

function loadRecentLocalBackups(limit = 5): DbShape[] {
  return listLocalBackupFiles()
    .slice(0, limit)
    .map((f) => loadLocalFile(f))
    .filter((d) => d.users.length > 0)
}

function rotateLocalBackup(db: DbShape) {
  if (!db.users.length) return
  ensureLocalDirs()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(LOCAL_BACKUP_DIR, `users-${stamp}.json`)
  try {
    fs.writeFileSync(dest, JSON.stringify(withMeta(db), null, 2), 'utf8')
    const all = listLocalBackupFiles()
    for (const old of all.slice(MAX_LOCAL_BACKUPS)) {
      try {
        fs.unlinkSync(old)
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    console.error('local backup rotate failed', e)
  }
}

function saveLocal(db: DbShape) {
  ensureLocalDirs()
  const payload = withMeta(db)
  // Atomic-ish write: temp + rename
  const tmp = `${LOCAL_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  fs.renameSync(tmp, LOCAL_FILE)
}

async function loadBlobPath(pathname: string): Promise<DbShape> {
  try {
    const result = await get(pathname, { access: 'private', useCache: false })
    if (!result || result.statusCode !== 200 || !result.stream) return empty()
    const body = await new Response(result.stream).text()
    return parseDb(body)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/not found|404|BlobNotFound/i.test(msg)) return empty()
    lastBlobOk = false
    lastBlobError = msg.slice(0, 200)
    console.error('blob load failed', pathname, msg)
    return empty()
  }
}

async function putBlobPath(pathname: string, db: DbShape) {
  await put(pathname, JSON.stringify(withMeta(db)), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

/**
 * Guard: never persist a catastrophic shrink (e.g. blob read failed → empty → save).
 * Allows natural empty only when we never had users in this process and file was empty.
 */
function assertSafeToSave(db: DbShape) {
  const n = db.users.length
  if (peakUserCount > 0 && n === 0) {
    throw new Error(
      `USERS_SAVE_REFUSED_EMPTY: refusing to wipe ${peakUserCount} known account(s)`,
    )
  }
  if (peakUserCount >= 4 && n < peakUserCount * MAX_SHRINK_RATIO) {
    throw new Error(
      `USERS_SAVE_REFUSED_SHRINK: ${peakUserCount} → ${n} accounts (possible data loss)`,
    )
  }
}

async function loadStore(): Promise<DbShape> {
  if (mem && Date.now() - memAt < CACHE_MS) return mem

  const sources: UserRecord[][] = []
  let blobPrimaryEmpty = true
  let blobReadFailed = false

  if (useBlob()) {
    const primary = await loadBlobPath(BLOB_PATH)
    if (primary.users.length) {
      sources.push(primary.users)
      blobPrimaryEmpty = false
      lastBlobOk = true
      lastBlobError = ''
    } else if (lastBlobError) {
      blobReadFailed = true
    }

    const backup = await loadBlobPath(BLOB_BACKUP_PATH)
    if (backup.users.length) sources.push(backup.users)
  }

  const local = loadLocal()
  if (local.users.length) sources.push(local.users)

  for (const b of loadRecentLocalBackups(5)) {
    sources.push(b.users)
  }

  const mergedUsers = mergeUserLists(sources)
  const db: DbShape = { users: mergedUsers }

  if (mergedUsers.length > peakUserCount) peakUserCount = mergedUsers.length

  mem = db
  memAt = Date.now()

  // Heal: if we recovered accounts locally but primary blob is empty/unreadable,
  // re-publish so the next cold start on another instance sees them.
  if (
    useBlob() &&
    mergedUsers.length > 0 &&
    (blobPrimaryEmpty || blobReadFailed) &&
    !healInFlight
  ) {
    healInFlight = true
    void (async () => {
      try {
        await putBlobPath(BLOB_PATH, db)
        await putBlobPath(BLOB_BACKUP_PATH, db)
        lastBlobOk = true
        lastBlobError = ''
        console.info('users store healed to blob (%d accounts)', mergedUsers.length)
      } catch (e) {
        lastBlobOk = false
        lastBlobError = e instanceof Error ? e.message.slice(0, 200) : String(e)
        console.error('users blob heal failed', lastBlobError)
      } finally {
        healInFlight = false
      }
    })()
  }

  return db
}

async function saveStore(db: DbShape) {
  // Re-read every durable source and merge BEFORE writing.
  // Critical on Vercel serverless: a cold start that saw "empty" must not
  // clobber a fuller blob/local when registering a new user.
  const sources: UserRecord[][] = [db.users]
  sources.push(loadLocal().users)
  for (const b of loadRecentLocalBackups(5)) sources.push(b.users)

  if (useBlob()) {
    const remote = await loadBlobPath(BLOB_PATH)
    const remoteBak = await loadBlobPath(BLOB_BACKUP_PATH)
    if (remote.users.length) sources.push(remote.users)
    if (remoteBak.users.length) sources.push(remoteBak.users)
  }

  const snapshot: DbShape = {
    users: mergeUserLists(sources).map((u) => normalizeUser(u)),
  }

  if (snapshot.users.length > peakUserCount) peakUserCount = snapshot.users.length
  assertSafeToSave(snapshot)

  // 1) Local rotating backup of previous main file
  const previous = loadLocal()
  if (previous.users.length) rotateLocalBackup(previous)

  // 2) Always write local first (survives blob outages on long-running hosts)
  saveLocal(snapshot)
  rotateLocalBackup(snapshot)

  // 3) Dual-write to blob primary + backup when configured
  if (useBlob()) {
    try {
      await putBlobPath(BLOB_PATH, snapshot)
      await putBlobPath(BLOB_BACKUP_PATH, snapshot)
      lastBlobOk = true
      lastBlobError = ''
    } catch (e) {
      lastBlobOk = false
      lastBlobError = e instanceof Error ? e.message.slice(0, 200) : String(e)
      console.error(
        'blob save failed — local users.json kept (%d accounts)',
        snapshot.users.length,
        lastBlobError,
      )
      // Do not throw: registration/login must succeed if local persisted.
    }
  }

  mem = snapshot
  // keep caller's in-memory db array in sync if they hold the same reference
  db.users = snapshot.users
  memAt = Date.now()
  lastSaveAt = new Date().toISOString()
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

export function storageMode(): 'blob' | 'local' | 'dual' {
  return useBlob() ? 'dual' : 'local'
}

export type UsersStorageHealth = {
  mode: 'blob' | 'local' | 'dual'
  userCount: number
  peakUserCount: number
  blobConfigured: boolean
  blobOk: boolean
  blobError: string
  lastSaveAt: string
  localBackupCount: number
}

/** Non-secret health for /api/health — proves accounts are still on disk. */
export async function usersStorageHealth(): Promise<UsersStorageHealth> {
  const db = await loadStore()
  return {
    mode: storageMode(),
    userCount: db.users.length,
    peakUserCount,
    blobConfigured: useBlob(),
    blobOk: useBlob() ? lastBlobOk : true,
    blobError: lastBlobError,
    lastSaveAt,
    localBackupCount: listLocalBackupFiles().length,
  }
}
