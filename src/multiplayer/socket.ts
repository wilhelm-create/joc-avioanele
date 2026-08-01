import { wsUrl } from '../api/client'
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

export class GameSocket {
  private ws: WebSocket | null = null
  private handlers = new Set<(msg: ServerMessage) => void>()
  connected = false

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.close()
      const url = wsUrl()
      const ws = new WebSocket(url)
      this.ws = ws
      const t = window.setTimeout(() => reject(new Error('Timeout conexiune')), 12000)

      ws.onopen = () => {
        this.connected = true
      }
      ws.onmessage = (ev) => {
        let msg: ServerMessage
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage
        } catch {
          return
        }
        if (msg.type === 'welcome') {
          window.clearTimeout(t)
          resolve()
        }
        if (msg.type === 'error' && !this.connected) {
          window.clearTimeout(t)
          reject(new Error(msg.error))
        }
        for (const h of this.handlers) h(msg)
      }
      ws.onerror = () => {
        window.clearTimeout(t)
        reject(new Error('Conexiune WebSocket eșuată — pornește serverul'))
      }
      ws.onclose = () => {
        this.connected = false
      }
    })
  }

  onMessage(fn: (msg: ServerMessage) => void): () => void {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }

  send(msg: Outgoing) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    this.connected = false
  }
}
