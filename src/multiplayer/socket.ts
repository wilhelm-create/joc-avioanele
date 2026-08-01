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

export interface ActiveGame {
  code: string
  role: PlayerId
  opponentName: string | null
  opponentUserId: string | null
  playersCount: number
  bothReady: boolean
  status: 'waiting' | 'placing' | 'battle'
}

export type Outgoing =
  | { type: 'create-room' }
  | { type: 'join-room'; code: string }
  | { type: 'leave-room'; code?: string }
  | { type: 'ready' }
  | { type: 'placement'; player: PlayerId; data: SerializablePlayer }
  | { type: 'shot'; player: PlayerId; coord: Coord }
  | { type: 'radar'; player: PlayerId }
  | { type: 'rematch' }
  | { type: 'ping' }

/**
 * HTTP-polling multiplayer. Supports multiple concurrent rooms per user;
 * only the active room is polled for events.
 */
export class GameSocket {
  private handlers = new Set<(msg: ServerMessage) => void>()
  connected = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  /** Currently focused room code */
  activeCode: string | null = null
  private afterByRoom = new Map<string, number>()
  private battleStartedByRoom = new Map<string, boolean>()
  private lastPlayerCountByRoom = new Map<string, number>()
  private ticking = false
  private pendingTick = false
  pollMs = 400

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
    if (this.connected) return
    await this.api<{ ok: boolean }>('/api/health')
    this.connected = true
    this.schedulePoll(0)
    this.emit({ type: 'welcome', user: { id: '', username: '' } })
  }

  /** Focus polling / events on this room (multi-game). */
  setActiveRoom(code: string | null) {
    this.activeCode = code ? code.toUpperCase().trim() : null
  }

  getAfterId(code: string): number {
    return this.afterByRoom.get(code.toUpperCase()) || 0
  }

  setAfterId(code: string, id: number) {
    this.afterByRoom.set(code.toUpperCase(), id)
  }

  private emitStartBattle(room: RoomInfo) {
    const key = room.code.toUpperCase()
    if (this.battleStartedByRoom.get(key)) return
    this.battleStartedByRoom.set(key, true)
    this.emit({ type: 'start-battle', room })
  }

  setFastPoll(fast: boolean) {
    this.pollMs = fast ? 350 : 700
  }

  private schedulePoll(delay: number) {
    this.stopPoll()
    if (!this.connected) return
    this.pollTimer = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.connected) this.schedulePoll(this.pollMs)
      })
    }, delay)
  }

  private stopPoll() {
    if (this.pollTimer != null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async tick() {
    if (!this.connected) return
    if (this.ticking) {
      this.pendingTick = true
      return
    }
    // No active room → nothing to poll (home / multi-game idle)
    if (!this.activeCode) return

    this.ticking = true
    const code = this.activeCode
    try {
      const after = this.afterByRoom.get(code) || 0
      const q = new URLSearchParams({ after: String(after), code })
      const data = await this.api<{
        room: RoomInfo | null
        events: Array<Record<string, unknown> & { id: number; type?: string }>
        bothJoined: boolean
        bothReady: boolean
      }>(`/api/rooms/poll?${q}`)

      if (data.room) {
        const prev = this.lastPlayerCountByRoom.get(code) ?? 0
        if (data.room.players.length !== prev) {
          this.lastPlayerCountByRoom.set(code, data.room.players.length)
          this.emit({ type: 'room', room: data.room })
          if (data.bothJoined && data.room.players.length >= 2) {
            this.emit({ type: 'both-joined', room: data.room })
          }
        }
      }

      for (const ev of data.events) {
        if (typeof ev.id === 'number' && ev.id > (this.afterByRoom.get(code) || 0)) {
          this.afterByRoom.set(code, ev.id)
        }
        const type = String(ev.type || '')
        if (type === 'both-joined' && data.room) {
          this.emit({ type: 'both-joined', room: data.room })
        } else if (type === 'start-battle' && data.room) {
          this.emitStartBattle(data.room)
        } else if (type === 'ready' && data.room) {
          this.emit({
            type: 'ready',
            userId: String(ev.userId || ''),
            room: data.room,
          })
          if (data.room.players.filter((p) => p.ready).length >= 2) {
            this.emitStartBattle(data.room)
          }
        } else if (type === 'peer-left') {
          this.emit({ type: 'peer-left', userId: String(ev.userId || '') })
        } else if (type === 'shot') {
          const coord = ev.coord as Coord
          const player = ev.player as PlayerId
          if (
            coord &&
            typeof coord.r === 'number' &&
            typeof coord.c === 'number' &&
            (player === 'p1' || player === 'p2')
          ) {
            this.emit({ type: 'shot', player, coord, from: String(ev.from || '') })
          }
        } else if (type === 'placement') {
          this.emit({
            type: 'placement',
            player: ev.player as PlayerId,
            data: ev.data as SerializablePlayer,
            from: String(ev.from || ''),
          })
        } else if (type === 'radar') {
          this.emit({
            type: 'radar',
            player: ev.player as PlayerId,
            from: String(ev.from || ''),
          })
        } else if (type === 'rematch') {
          this.emit({ type: 'rematch', from: String(ev.from || '') })
        } else if (type) {
          this.emit(ev as unknown as ServerMessage)
        }
      }

      if (data.bothReady && data.room) {
        this.emitStartBattle(data.room)
      }
    } catch {
      /* transient */
    } finally {
      this.ticking = false
      if (this.pendingTick && this.connected) {
        this.pendingTick = false
        void this.tick()
      }
    }
  }

  onMessage(fn: (msg: ServerMessage) => void): () => void {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  send(msg: Outgoing) {
    void this.sendAsync(msg)
  }

  private roomPayload(extra: Record<string, unknown> = {}) {
    return {
      ...extra,
      ...(this.activeCode ? { code: this.activeCode } : {}),
    }
  }

  private async sendAsync(msg: Outgoing) {
    try {
      if (msg.type === 'create-room') {
        const data = await this.api<{ room: RoomInfo; role: PlayerId }>('/api/rooms/create', {
          method: 'POST',
          body: '{}',
        })
        this.activeCode = data.room.code
        this.afterByRoom.set(data.room.code, 0)
        this.battleStartedByRoom.set(data.room.code, false)
        this.lastPlayerCountByRoom.set(data.room.code, data.room.players.length)
        this.emit({ type: 'room', room: data.room, role: data.role })
        void this.tick()
        return
      }
      if (msg.type === 'join-room') {
        const data = await this.api<{ room: RoomInfo; role: PlayerId }>('/api/rooms/join', {
          method: 'POST',
          body: JSON.stringify({ code: msg.code }),
        })
        this.activeCode = data.room.code
        this.afterByRoom.set(data.room.code, 0)
        this.battleStartedByRoom.set(data.room.code, false)
        this.lastPlayerCountByRoom.set(data.room.code, data.room.players.length)
        this.emit({ type: 'room', room: data.room, role: data.role })
        if (data.room.players.length >= 2) {
          this.emit({ type: 'both-joined', room: data.room })
        }
        void this.tick()
        return
      }
      if (msg.type === 'leave-room') {
        const code = msg.code || this.activeCode || undefined
        await this.api('/api/rooms/leave', {
          method: 'POST',
          body: JSON.stringify(code ? { code } : {}),
        })
        if (code) {
          this.afterByRoom.delete(code)
          this.battleStartedByRoom.delete(code)
          this.lastPlayerCountByRoom.delete(code)
          if (this.activeCode === code) this.activeCode = null
        } else {
          this.activeCode = null
        }
        this.emit({ type: 'left' })
        return
      }
      if (msg.type === 'ready') {
        const data = await this.api<{ ok: boolean; room: RoomInfo; bothReady: boolean }>(
          '/api/rooms/event',
          { method: 'POST', body: JSON.stringify(this.roomPayload(msg as unknown as Record<string, unknown>)) },
        )
        if (data.room) {
          this.emit({ type: 'ready', userId: '', room: data.room })
          if (data.bothReady) this.emitStartBattle(data.room)
        }
        void this.tick()
        return
      }
      await this.api('/api/rooms/event', {
        method: 'POST',
        body: JSON.stringify(this.roomPayload(msg as unknown as Record<string, unknown>)),
      })
      void this.tick()
    } catch (e) {
      this.emit({ type: 'error', error: (e as Error).message })
    }
  }

  async fetchActiveGames(): Promise<ActiveGame[]> {
    try {
      const data = await this.api<{ games: ActiveGame[] }>('/api/rooms/active')
      return data.games || []
    } catch {
      return []
    }
  }

  close() {
    this.connected = false
    this.stopPoll()
    // keep afterIds so resume works; clear active focus only
    this.activeCode = null
  }
}
