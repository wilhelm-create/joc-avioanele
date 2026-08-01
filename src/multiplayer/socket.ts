import { getToken } from '../auth/session'
import type { Coord, PlayerId, SerializablePlayer } from '../game/types'

export type ServerMessage =
  | { type: 'welcome'; user: { id: string; username: string } }
  | { type: 'room'; room: RoomInfo; role?: PlayerId }
  | { type: 'both-joined'; room: RoomInfo }
  | { type: 'ready'; userId: string; room: RoomInfo }
  | { type: 'start-battle'; room: RoomInfo }
  | { type: 'peer-left'; userId: string }
  | { type: 'left' }
  | { type: 'error'; error: string }
  | { type: 'pong' }
  | {
      type: 'placement'
      player: PlayerId
      data: SerializablePlayer
      from?: string
    }
  | { type: 'shot'; player: PlayerId; coord: Coord; from?: string }
  | { type: 'radar'; player: PlayerId; from?: string }
  | { type: 'rematch'; from?: string }
  | { type: 'chat'; text: string; fromName?: string }
  | { type: 'player-joined'; username?: string }

export interface RoomInfo {
  code: string
  players: { userId: string; username: string; role: PlayerId; ready: boolean }[]
}

export type Outgoing =
  | { type: 'create-room' }
  | { type: 'join-room'; code: string }
  | { type: 'leave-room' }
  | { type: 'ready' }
  | { type: 'placement'; player: PlayerId; data: SerializablePlayer }
  | { type: 'shot'; player: PlayerId; coord: Coord }
  | { type: 'radar'; player: PlayerId }
  | { type: 'rematch' }
  | { type: 'ping' }

/**
 * HTTP-polling multiplayer (works on Vercel serverless).
 * Locally also works via Vite proxy → Express.
 */
export class GameSocket {
  private handlers = new Set<(msg: ServerMessage) => void>()
  connected = false
  private pollTimer: number | null = null
  private afterId = 0
  private lastPlayerCount = 0

  private emit(msg: ServerMessage) {
    for (const h of this.handlers) h(msg)
  }

  private async api<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    headers.set('Content-Type', 'application/json')
    const token = getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    const res = await fetch(path, { ...init, headers })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string }
    if (!res.ok) throw new Error(data.error || `Eroare ${res.status}`)
    return data
  }

  async connect(): Promise<void> {
    this.close()
    // health check proves API is up
    await this.api<{ ok: boolean }>('/api/health')
    this.connected = true
    this.afterId = 0
    this.startPoll()
    this.emit({ type: 'welcome', user: { id: '', username: '' } })
  }

  private startPoll() {
    this.stopPoll()
    const tick = async () => {
      if (!this.connected) return
      try {
        const data = await this.api<{
          room: RoomInfo | null
          events: Array<ServerMessage & { id: number }>
          bothJoined: boolean
          bothReady: boolean
        }>(`/api/rooms/poll?after=${this.afterId}`)

        if (data.room) {
          if (data.room.players.length !== this.lastPlayerCount) {
            this.lastPlayerCount = data.room.players.length
            this.emit({ type: 'room', room: data.room })
            if (data.bothJoined && data.room.players.length >= 2) {
              this.emit({ type: 'both-joined', room: data.room })
            }
          }
        }

        for (const ev of data.events) {
          if (ev.id > this.afterId) this.afterId = ev.id
          const { id: _id, ...rest } = ev
          void _id
          // normalize event shapes
          if (rest.type === 'both-joined' && data.room) {
            this.emit({ type: 'both-joined', room: data.room })
          } else if (rest.type === 'start-battle' && data.room) {
            this.emit({ type: 'start-battle', room: data.room })
          } else if (rest.type === 'ready' && data.room) {
            this.emit({
              type: 'ready',
              userId: String(rest.userId || ''),
              room: data.room,
            })
          } else if (rest.type === 'peer-left') {
            this.emit({ type: 'peer-left', userId: String(rest.userId || '') })
          } else {
            this.emit(rest as ServerMessage)
          }
        }

        if (data.bothReady && data.room) {
          // start-battle should also arrive as event; belt-and-suspenders
        }
      } catch {
        /* transient */
      }
    }
    void tick()
    this.pollTimer = window.setInterval(() => void tick(), 900)
  }

  private stopPoll() {
    if (this.pollTimer != null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  onMessage(fn: (msg: ServerMessage) => void): () => void {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  send(msg: Outgoing) {
    void this.sendAsync(msg)
  }

  private async sendAsync(msg: Outgoing) {
    try {
      if (msg.type === 'create-room') {
        const data = await this.api<{ room: RoomInfo; role: PlayerId }>('/api/rooms/create', {
          method: 'POST',
          body: '{}',
        })
        this.afterId = 0
        this.lastPlayerCount = data.room.players.length
        this.emit({ type: 'room', room: data.room, role: data.role })
        return
      }
      if (msg.type === 'join-room') {
        const data = await this.api<{ room: RoomInfo; role: PlayerId }>('/api/rooms/join', {
          method: 'POST',
          body: JSON.stringify({ code: msg.code }),
        })
        this.afterId = 0
        this.lastPlayerCount = data.room.players.length
        this.emit({ type: 'room', room: data.room, role: data.role })
        if (data.room.players.length >= 2) {
          this.emit({ type: 'both-joined', room: data.room })
        }
        return
      }
      if (msg.type === 'leave-room') {
        await this.api('/api/rooms/leave', { method: 'POST', body: '{}' })
        this.emit({ type: 'left' })
        return
      }
      // game events
      await this.api('/api/rooms/event', {
        method: 'POST',
        body: JSON.stringify(msg),
      })
    } catch (e) {
      this.emit({ type: 'error', error: (e as Error).message })
    }
  }

  close() {
    this.connected = false
    this.stopPoll()
    this.lastPlayerCount = 0
  }
}
