import type { AuthResponse, PublicUser, RegisterPendingResponse } from '../auth/types'
import { clearSession, getToken, setSession, updateStoredUser } from '../auth/session'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(path, { ...init, headers })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string }
  if (!res.ok) {
    if (res.status === 401) clearSession()
    const err = new Error(data.error || `Eroare ${res.status}`) as Error & { code?: string }
    err.code = data.code || data.error
    throw err
  }
  return data
}

export async function register(
  username: string,
  password: string,
  email: string,
): Promise<RegisterPendingResponse> {
  const data = await request<RegisterPendingResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, email }),
  })
  // Auto-verified path (no Resend) — same session as login
  if (data.token && data.user && 'emailVerified' in data.user) {
    setSession(data.token, data.user as PublicUser)
  }
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

export async function verifyEmail(token: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>('/api/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  setSession(data.token, data.user)
  return data
}

export async function resendVerification(username: string): Promise<{
  ok: boolean
  message: string
  debugVerifyLink?: string
}> {
  return request('/api/auth/resend-verification', {
    method: 'POST',
    body: JSON.stringify({ username }),
  })
}

export async function forgotPassword(email: string): Promise<{
  ok: boolean
  message: string
  debugResetLink?: string
}> {
  return request('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function resetPassword(token: string, password: string): Promise<AuthResponse> {
  const data = await request<AuthResponse>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
  setSession(data.token, data.user)
  return data
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

export async function changeEmail(email: string): Promise<{
  user: PublicUser
  needsVerification: boolean
  message: string
  debugVerifyLink?: string
}> {
  const data = await request<{
    user: PublicUser
    needsVerification: boolean
    message: string
    debugVerifyLink?: string
  }>('/api/auth/change-email', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  updateStoredUser(data.user)
  return data
}

export async function uploadAvatar(dataUrl: string): Promise<PublicUser> {
  const data = await request<{ user: PublicUser }>('/api/auth/avatar', {
    method: 'POST',
    body: JSON.stringify({ dataUrl }),
  })
  updateStoredUser(data.user)
  return data.user
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
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token || '')}`
}

export async function sendInviteSms(
  phone: string,
  roomCode: string,
  inviteUrl?: string,
): Promise<{ mode: 'twilio' | 'client'; body?: string; phone?: string }> {
  return request<{ mode: 'twilio' | 'client'; body?: string; phone?: string }>('/api/invite/sms', {
    method: 'POST',
    body: JSON.stringify({ phone, roomCode, inviteUrl }),
  })
}
