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
 * HTTP-polling multiplayer with fast battle updates (no full page reload).
 */
export class GameSocket {
  private handlers = new Set<(msg: ServerMessage) => void>()
  connected = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private afterId = 0
  private lastPlayerCount = 0
  private ticking = false
  /** If a tick was requested while one was in flight, run again after */
  private pendingTick = false
  /** Avoid re-emitting start-battle every poll once both are ready */
  private battleStartedEmitted = false
  /** Faster while in battle / waiting for shots */
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
    this.close()
    await this.api<{ ok: boolean }>('/api/health')
    this.connected = true
    this.afterId = 0
    this.lastPlayerCount = 0
    this.battleStartedEmitted = false
    this.schedulePoll(0)
    this.emit({ type: 'welcome', user: { id: '', username: '' } })
  }

  private emitStartBattle(room: RoomInfo) {
    if (this.battleStartedEmitted) return
    this.battleStartedEmitted = true
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
    this.ticking = true
    try {
      const data = await this.api<{
        room: RoomInfo | null
        events: Array<Record<string, unknown> & { id: number; type?: string }>
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
        if (typeof ev.id === 'number' && ev.id > this.afterId) this.afterId = ev.id
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
          // If room already shows both ready (race / missed start-battle event)
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

      // Critical: bothReady even if start-battle event was filtered (own from) or lost to race
      if (data.bothReady && data.room) {
        this.emitStartBattle(data.room)
      }
    } catch {
      /* transient network / cold start */
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

  private async sendAsync(msg: Outgoing) {
    try {
      if (msg.type === 'create-room') {
        const data = await this.api<{ room: RoomInfo; role: PlayerId }>('/api/rooms/create', {
          method: 'POST',
          body: '{}',
        })
        this.afterId = 0
        this.lastPlayerCount = data.room.players.length
        this.battleStartedEmitted = false
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
        this.battleStartedEmitted = false
        this.emit({ type: 'room', room: data.room, role: data.role })
        if (data.room.players.length >= 2) {
          this.emit({ type: 'both-joined', room: data.room })
        }
        return
      }
      if (msg.type === 'leave-room') {
        await this.api('/api/rooms/leave', { method: 'POST', body: '{}' })
        this.battleStartedEmitted = false
        this.emit({ type: 'left' })
        return
      }
      // Ready: use response bothReady — sender never receives own start-battle via poll filter
      if (msg.type === 'ready') {
        const data = await this.api<{ ok: boolean; room: RoomInfo; bothReady: boolean }>(
          '/api/rooms/event',
          { method: 'POST', body: JSON.stringify(msg) },
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
        body: JSON.stringify(msg),
      })
      // pull immediately so both peers stay in sync without waiting for interval
      void this.tick()
    } catch (e) {
      this.emit({ type: 'error', error: (e as Error).message })
    }
  }

  close() {
    this.connected = false
    this.stopPoll()
    this.lastPlayerCount = 0
    this.battleStartedEmitted = false
  }
}
