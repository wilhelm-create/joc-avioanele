export interface PublicUser {
  id: string
  username: string
  createdAt: string
  wins: number
  losses: number
  gamesPlayed: number
}

export interface AuthResponse {
  user: PublicUser
  token: string
}
