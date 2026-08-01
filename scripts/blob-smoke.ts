import { createUser, verifyLogin, storageMode, listLeaderboard } from '../server/db.ts'

async function main() {
  console.log('mode', storageMode())
  const u = 'persist_' + Date.now().toString(36)
  const created = await createUser(u, 'testpass123')
  console.log('created', created.username)
  const login = await verifyLogin(u, 'testpass123')
  console.log('login', login.username)
  console.log('leaders', (await listLeaderboard(5)).map((x) => x.username).join(','))
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
