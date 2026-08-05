/**
 * Safe smoke: create + login without wiping the store.
 * Uses dual-write durable users DB (local + blob when configured).
 */
import {
  createUser,
  verifyLogin,
  storageMode,
  listLeaderboard,
  usersStorageHealth,
} from '../server/db.ts'

async function main() {
  const before = await usersStorageHealth()
  console.log('mode', storageMode())
  console.log('health_before', before)
  if (before.userCount === 0 && before.peakUserCount === 0) {
    console.warn('WARN: store appears empty — check blob/local backups before heavy ops')
  }

  const u = 'persist_' + Date.now().toString(36)
  const email = `${u}@example.com`
  const { user, verifyToken } = await createUser(u, 'testpass123', email)
  console.log('created', user.username, 'verifyToken_len', verifyToken.length)

  // Mark verified via login path only works without email gate — use verify token path if needed
  // For smoke with emailVerified=false, verifyLogin throws EMAIL_NOT_VERIFIED — expected.
  try {
    await verifyLogin(u, 'testpass123')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg !== 'EMAIL_NOT_VERIFIED') throw e
    console.log('login_blocked_until_verify ok')
  }

  const after = await usersStorageHealth()
  console.log('health_after', after)
  console.log(
    'leaders',
    (await listLeaderboard(5)).map((x) => x.username).join(','),
  )
  if (after.userCount < before.userCount) {
    throw new Error(`SMOKE_REGRESSION: userCount ${before.userCount} → ${after.userCount}`)
  }
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
