import { createRoom, joinRoom, getRoom } from '../server/rooms.ts'

async function main() {
  const h = 'host' + Date.now()
  const g = 'guest' + Date.now()
  console.log('blob?', !!process.env.BLOB_READ_WRITE_TOKEN)
  const room = await createRoom(h, 'HostUser')
  console.log('created', room.code)
  const mid = await getRoom(room.code)
  console.log('reload', !!mid, mid?.code)
  const joined = await joinRoom(room.code, g, 'GuestUser')
  console.log(
    'joined',
    joined.players.size,
    [...joined.players.values()].map((p) => p.role + ':' + p.username).join(', '),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
