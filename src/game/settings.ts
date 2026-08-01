/** Shared multiplayer game settings (host sets, both can edit before battle). */

export type Difficulty = 'easy' | 'medium' | 'hard' | 'impossible'

export interface GameSettings {
  difficulty: Difficulty
  /** Board size N×N (8–14) */
  gridSize: number
  /** Planes each player places */
  planesPerPlayer: number
  /** Extended wing span */
  longWings: boolean
  /** Fleet paint color (hex) */
  planeColor: string
}

export const MIN_GRID = 8
export const MAX_GRID = 14
export const MIN_PLANES = 1
export const MAX_PLANES = 12

export const DEFAULT_PLANE_COLOR = '#e8956a'

export const DEFAULT_SETTINGS: GameSettings = {
  difficulty: 'medium',
  gridSize: 10,
  planesPerPlayer: 3,
  longWings: false,
  planeColor: DEFAULT_PLANE_COLOR,
}

/** Presets when picking difficulty (sliders still editable). */
export const DIFFICULTY_PRESETS: Record<
  Difficulty,
  Pick<GameSettings, 'gridSize' | 'planesPerPlayer' | 'longWings'>
> = {
  easy: { gridSize: 10, planesPerPlayer: 3, longWings: false },
  medium: { gridSize: 12, planesPerPlayer: 5, longWings: false },
  hard: { gridSize: 14, planesPerPlayer: 8, longWings: true },
  impossible: { gridSize: 14, planesPerPlayer: 10, longWings: true },
}

export function colLabels(gridSize: number): string {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, gridSize)
}

export function clampSettings(raw: Partial<GameSettings> | null | undefined): GameSettings {
  const base = { ...DEFAULT_SETTINGS, ...(raw || {}) }
  let gridSize = Math.round(Number(base.gridSize) || DEFAULT_SETTINGS.gridSize)
  gridSize = Math.min(MAX_GRID, Math.max(MIN_GRID, gridSize))

  let planes = Math.round(Number(base.planesPerPlayer) || DEFAULT_SETTINGS.planesPerPlayer)
  // soft cap: leave room on board (rough)
  const maxForGrid = Math.min(MAX_PLANES, Math.max(MIN_PLANES, Math.floor((gridSize * gridSize) / 14)))
  planes = Math.min(maxForGrid, Math.max(MIN_PLANES, planes))

  const difficulty = (['easy', 'medium', 'hard', 'impossible'] as Difficulty[]).includes(
    base.difficulty as Difficulty,
  )
    ? (base.difficulty as Difficulty)
    : 'medium'

  let planeColor = String(base.planeColor || DEFAULT_PLANE_COLOR)
  if (!/^#[0-9a-fA-F]{6}$/.test(planeColor)) planeColor = DEFAULT_PLANE_COLOR

  return {
    difficulty,
    gridSize,
    planesPerPlayer: planes,
    longWings: Boolean(base.longWings),
    planeColor,
  }
}

export function settingsEqual(a: GameSettings, b: GameSettings): boolean {
  return (
    a.difficulty === b.difficulty &&
    a.gridSize === b.gridSize &&
    a.planesPerPlayer === b.planesPerPlayer &&
    a.longWings === b.longWings &&
    a.planeColor.toLowerCase() === b.planeColor.toLowerCase()
  )
}
