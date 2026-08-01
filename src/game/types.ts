/** Grid size: classic Romanian Avioane board */
export const GRID = 10
export const PLANES_PER_PLAYER = 3
export const COLS = 'ABCDEFGHIJ'

export type CellState =
  | 'empty'
  | 'plane'
  | 'head'
  | 'miss'
  | 'hit'
  | 'sunk'
  | 'radar' // cookie: revealed empty water via radar

export type Orientation = 0 | 90 | 180 | 270

export interface Coord {
  r: number
  c: number
}

export interface PlanePlacement {
  id: number
  head: Coord
  orientation: Orientation
  cells: Coord[]
  headCell: Coord
  sunk: boolean
}

export interface ShotResult {
  coord: Coord
  kind: 'miss' | 'hit' | 'sunk' | 'already'
  planeId?: number
  sunkCells?: Coord[]
}

export type PlayerId = 'p1' | 'p2'

export interface PlayerState {
  id: PlayerId
  name: string
  color: string
  planes: PlanePlacement[]
  /** own fleet cells: key "r,c" */
  fleet: Map<string, { planeId: number; isHead: boolean }>
  /** shots received on this player's board */
  received: Map<string, CellState>
  /** shots this player fired at opponent */
  fired: Map<string, CellState>
  radarUsed: boolean
  planesSunk: number
}

export type Phase =
  | 'menu'
  | 'mode-select'
  | 'name-entry'
  | 'online-lobby'
  | 'placement'
  | 'pass-device'
  | 'battle'
  | 'game-over'

export type GameMode = 'local' | 'online-host' | 'online-join'

export interface GameSnapshot {
  phase: Phase
  mode: GameMode
  currentPlayer: PlayerId
  placingPlayer: PlayerId
  winner: PlayerId | null
  turn: number
  lastShot: ShotResult | null
  message: string
  p1: SerializablePlayer
  p2: SerializablePlayer
}

export interface SerializablePlayer {
  id: PlayerId
  name: string
  color: string
  planes: PlanePlacement[]
  fleet: [string, { planeId: number; isHead: boolean }][]
  received: [string, CellState][]
  fired: [string, CellState][]
  radarUsed: boolean
  planesSunk: number
}

export function key(r: number, c: number): string {
  return `${r},${c}`
}

export function parseKey(k: string): Coord {
  const [r, c] = k.split(',').map(Number)
  return { r, c }
}

export function inBounds(r: number, c: number): boolean {
  return r >= 0 && r < GRID && c >= 0 && c < GRID
}

export function label(coord: Coord): string {
  return `${COLS[coord.c]}${coord.r + 1}`
}
