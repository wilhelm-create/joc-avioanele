/**
 * Durability helpers for users store — run: npx tsx server/db.durability.test.ts
 */
import { mergeUserLists, type UserRecord } from './db.ts'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function stub(partial: Partial<UserRecord> & Pick<UserRecord, 'id' | 'username'>): UserRecord {
  return {
    passwordHash: partial.passwordHash ?? 'hash',
    email: partial.email ?? '',
    emailVerified: partial.emailVerified ?? false,
    avatarDataUrl: partial.avatarDataUrl ?? '',
    emailVerifyToken: null,
    emailVerifyExpires: null,
    resetToken: null,
    resetExpires: null,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    wins: partial.wins ?? 0,
    losses: partial.losses ?? 0,
    gamesPlayed: partial.gamesPlayed ?? 0,
    ...partial,
    id: partial.id,
    username: partial.username,
  }
}

function testMergeKeepsBothSources() {
  const a = [stub({ id: '1', username: 'ana', wins: 2, gamesPlayed: 3 })]
  const b = [stub({ id: '2', username: 'bob', email: 'b@x.com', emailVerified: true })]
  const m = mergeUserLists([a, b])
  assert(m.length === 2, 'merge both')
  assert(m.some((u) => u.username === 'ana'), 'ana')
  assert(m.some((u) => u.username === 'bob'), 'bob')
  console.log('✓ merge both sources')
}

function testMergePrefersRicher() {
  const weak = stub({ id: '1', username: 'ana', wins: 0, email: '' })
  const rich = stub({
    id: '1',
    username: 'ana',
    wins: 5,
    gamesPlayed: 10,
    email: 'a@x.com',
    emailVerified: true,
  })
  const m = mergeUserLists([[weak], [rich]])
  assert(m.length === 1, 'one id')
  assert(m[0].wins === 5, 'richer wins')
  assert(m[0].email === 'a@x.com', 'email kept')
  console.log('✓ merge prefers richer')
}

function testMergeSameUsernameDifferentIds() {
  const a = stub({ id: 'a', username: 'same', wins: 1 })
  const b = stub({ id: 'b', username: 'same', wins: 9, email: 's@x.com' })
  const m = mergeUserLists([[a], [b]])
  assert(m.length === 1, 'dedupe username')
  assert(m[0].wins === 9, 'kept richer username twin')
  console.log('✓ merge same username')
}

function testEmptyPlusData() {
  const m = mergeUserLists([[], [stub({ id: '1', username: 'x' })], []])
  assert(m.length === 1, 'empty sources ignored')
  console.log('✓ empty sources')
}

function main() {
  testMergeKeepsBothSources()
  testMergePrefersRicher()
  testMergeSameUsernameDifferentIds()
  testEmptyPlusData()
  console.log('\nAll durability tests passed.')
}

main()
