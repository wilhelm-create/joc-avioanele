/**
 * Summarize users in blob/local store (no secrets printed).
 * Usage: npx tsx scripts/inspect-users.ts
 */
import { get, list } from '@vercel/blob'
import fs from 'node:fs'
import path from 'node:path'

function loadEnv() {
  for (const f of ['.env.local', '.env', '.env.pull', '.env.vercel.pull']) {
    const p = path.resolve(f)
    if (!fs.existsSync(p)) continue
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#') || !line.includes('=')) continue
      const i = line.indexOf('=')
      const k = line.slice(0, i).trim()
      let v = line.slice(i + 1).trim()
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1)
      }
      if (k && !process.env[k]) process.env[k] = v
    }
  }
}

async function main() {
  loadEnv()
  const token = process.env.BLOB_READ_WRITE_TOKEN
  console.log('blob_token_set', Boolean(token))

  if (token) {
    try {
      const listed = await list({ token, limit: 200 })
      console.log(
        'blobs',
        listed.blobs.map((b) => ({
          pathname: b.pathname,
          size: b.size,
          uploadedAt: b.uploadedAt,
        })),
      )
    } catch (e) {
      console.log('list_err', e instanceof Error ? e.message : e)
    }

    try {
      // Prefer download URL from list (works for public blobs)
      const listed = await list({ token, prefix: 'avioane-users', limit: 20 })
      const hit = listed.blobs.find((b) => b.pathname === 'avioane-users.json')
      console.log('users_blob_meta', hit ? { size: hit.size, url: hit.url ? 'yes' : 'no', uploadedAt: hit.uploadedAt } : null)

      let body = ''
      // Private blobs need authenticated get() with the blob URL
      const targets = [
        hit?.url,
        hit?.downloadUrl,
        'avioane-users.json',
        hit?.pathname,
      ].filter(Boolean) as string[]

      for (const target of targets) {
        try {
          console.log('try_get', target.startsWith('http') ? 'url' : target)
          const result = await get(target, {
            access: 'private',
            useCache: false,
            token,
          })
          console.log('get_status', result?.statusCode, Boolean(result?.stream))
          if (result?.statusCode === 200 && result.stream) {
            body = await new Response(result.stream).text()
            break
          }
        } catch (e) {
          console.log('try_get_err', e instanceof Error ? e.message.slice(0, 120) : e)
        }
      }

      if (!body && hit?.url) {
        // Last resort: authorized fetch
        try {
          const res = await fetch(hit.url, {
            headers: { Authorization: `Bearer ${token}` },
          })
          console.log('auth_fetch_status', res.status)
          body = await res.text()
          if (body.startsWith('Your store') || body.startsWith('<!')) {
            console.log('auth_fetch_body_prefix', body.slice(0, 100))
            body = ''
          }
        } catch (e) {
          console.log('auth_fetch_err', e instanceof Error ? e.message : e)
        }
      }

      if (body) {
        const data = JSON.parse(body || '{}') as {
          users?: Array<{
            username?: string
            email?: string
            emailVerified?: boolean
            createdAt?: string
            wins?: number
            passwordHash?: string
          }>
        }
        const users = data.users || []
        console.log('blob_users_count', users.length)
        for (const u of users) {
          console.log(
            [
              u.username || '?',
              u.email || '(no-email)',
              u.emailVerified ? 'verified' : 'unverified',
              u.createdAt || '?',
              `wins=${u.wins ?? 0}`,
              u.passwordHash ? 'has_hash' : 'NO_HASH',
            ].join(' | '),
          )
        }
        const out = path.resolve('data', 'users.blob-snapshot.json')
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, JSON.stringify(data, null, 2), 'utf8')
        console.log('wrote', out)
      }
    } catch (e) {
      console.log('get_err', e instanceof Error ? e.message : e)
    }
  }

  const local = path.resolve('data', 'users.json')
  if (fs.existsSync(local)) {
    const data = JSON.parse(fs.readFileSync(local, 'utf8')) as {
      users?: Array<{ username?: string; email?: string }>
    }
    console.log('local_users_count', (data.users || []).length)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
