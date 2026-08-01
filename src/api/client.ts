import type { AuthResponse, PublicUser } from '../auth/types'
import { clearSession, getToken, setSession, updateStoredUser } from '../auth/session'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(path, { ...init, headers })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    if (res.status === 401) clearSession()
    throw new Error(data.error || `Eroare ${res.status}`)
  }
  return data
}

export async function register(username: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  setSession(data.token, data.user)
  return data
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  setSession(data.token, data.user)
  return data
}

export async function fetchMe(): Promise<PublicUser | null> {
  if (!getToken()) return null
  try {
    const data = await request<{ user: PublicUser }>('/api/auth/me')
    updateStoredUser(data.user)
    return data.user
  } catch {
    clearSession()
    return null
  }
}

export async function fetchLeaderboard(): Promise<PublicUser[]> {
  const data = await request<{ leaders: PublicUser[] }>('/api/leaderboard')
  return data.leaders
}

export async function reportMatch(winnerId: string, loserId: string): Promise<void> {
  await request('/api/match/result', {
    method: 'POST',
    body: JSON.stringify({ winnerId, loserId }),
  })
}

export function wsUrl(): string {
  const token = getToken()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // In dev, Vite proxies /ws → backend
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token || '')}`
}
