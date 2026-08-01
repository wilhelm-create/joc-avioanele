import { Peer, type DataConnection } from 'peerjs'
import type { GameEngine } from '../game/engine'
import type { Coord, GameSnapshot, PlayerId, SerializablePlayer } from '../game/types'

export type NetMessage =
  | { type: 'hello'; name: string; role: 'host' | 'guest' }
  | { type: 'hello-ack'; name: string }
  | { type: 'placement'; player: PlayerId; data: SerializablePlayer }
  | { type: 'ready'; player: PlayerId }
  | { type: 'shot'; player: PlayerId; coord: Coord }
  | { type: 'radar'; player: PlayerId }
  | { type: 'sync'; snapshot: GameSnapshot }
  | { type: 'rematch' }
  | { type: 'chat'; text: string }

export interface OnlineSession {
  peerId: string
  role: 'host' | 'guest'
  connected: boolean
  remoteName: string
  destroy: () => void
  send: (msg: NetMessage) => void
}

function roomToPeerId(code: string): string {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return `avioane-${clean}`
}

export function generateRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return code
}

export async function hostGame(
  engine: GameEngine,
  name: string,
  roomCode: string,
  onStatus: (s: string) => void,
  onRemoteEvent: (msg: NetMessage) => void,
): Promise<OnlineSession> {
  const peerId = roomToPeerId(roomCode)
  const peer = new Peer(peerId, {
    debug: 0,
  })

  let conn: DataConnection | null = null
  let connected = false
  let remoteName = 'Oaspete'

  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('Timeout la deschiderea camerei')), 15000)
    peer.on('open', () => {
      window.clearTimeout(t)
      onStatus(`Cameră ${roomCode} — așteaptă prietenul`)
      resolve()
    })
    peer.on('error', (err) => {
      window.clearTimeout(t)
      reject(err)
    })
  })

  peer.on('connection', (c) => {
    if (conn) {
      c.close()
      return
    }
    conn = c
    wire(c)
  })

  function wire(c: DataConnection) {
    c.on('open', () => {
      connected = true
      onStatus('Prieten conectat!')
      c.send({ type: 'hello', name, role: 'host' } satisfies NetMessage)
    })
    c.on('data', (raw) => {
      const msg = raw as NetMessage
      if (msg.type === 'hello') {
        remoteName = msg.name
        engine.p2.name = msg.name
        c.send({ type: 'hello-ack', name } satisfies NetMessage)
        engine.beginOnlinePlacement()
      }
      onRemoteEvent(msg)
    })
    c.on('close', () => {
      connected = false
      onStatus('Conexiune pierdută')
    })
  }

  return {
    peerId,
    role: 'host',
    get connected() {
      return connected
    },
    get remoteName() {
      return remoteName
    },
    destroy: () => {
      conn?.close()
      peer.destroy()
    },
    send: (msg) => {
      if (conn?.open) conn.send(msg)
    },
  }
}

export async function joinGame(
  engine: GameEngine,
  name: string,
  roomCode: string,
  onStatus: (s: string) => void,
  onRemoteEvent: (msg: NetMessage) => void,
): Promise<OnlineSession> {
  const hostId = roomToPeerId(roomCode)
  const peer = new Peer({ debug: 0 })

  let conn: DataConnection | null = null
  let connected = false
  let remoteName = 'Gazdă'

  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('Timeout la conectare')), 15000)
    peer.on('open', () => {
      window.clearTimeout(t)
      resolve()
    })
    peer.on('error', (err) => {
      window.clearTimeout(t)
      reject(err)
    })
  })

  conn = peer.connect(hostId, { reliable: true })
  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('Camera nu a fost găsită')), 12000)
    conn!.on('open', () => {
      window.clearTimeout(t)
      connected = true
      onStatus('Conectat la gazdă!')
      conn!.send({ type: 'hello', name, role: 'guest' } satisfies NetMessage)
      resolve()
    })
    conn!.on('error', (err) => {
      window.clearTimeout(t)
      reject(err)
    })
  })

  conn.on('data', (raw) => {
    const msg = raw as NetMessage
    if (msg.type === 'hello' || msg.type === 'hello-ack') {
      remoteName = msg.name
      engine.p1.name = msg.name
    }
    if (msg.type === 'hello-ack') {
      engine.beginOnlinePlacement()
    }
    onRemoteEvent(msg)
  })
  conn.on('close', () => {
    connected = false
    onStatus('Conexiune pierdută')
  })

  return {
    peerId: peer.id,
    role: 'guest',
    get connected() {
      return connected
    },
    get remoteName() {
      return remoteName
    },
    destroy: () => {
      conn?.close()
      peer.destroy()
    },
    send: (msg) => {
      if (conn?.open) conn.send(msg)
    },
  }
}
