export interface PublicUser {
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

export interface AuthResponse {
  user: PublicUser
  token: string
}

export interface RegisterPendingResponse {
  ok: true
  needsVerification: true
  user: { id: string; username: string; email: string }
  message: string
  debugVerifyLink?: string
}
