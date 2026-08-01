import type { Coord, Orientation } from './types'
import { GRID, inBounds } from './types'

/**
 * Classic Romanian plane (10 cells). Origin = cockpit.
 * Long wings add one cell each side on the wing row.
 */
const BASE_SHORT: Coord[] = [
  { r: 0, c: 0 },
  { r: 1, c: -2 },
  { r: 1, c: -1 },
  { r: 1, c: 0 },
  { r: 1, c: 1 },
  { r: 1, c: 2 },
  { r: 2, c: 0 },
  { r: 3, c: -1 },
  { r: 3, c: 0 },
  { r: 3, c: 1 },
]

const BASE_LONG: Coord[] = [
  { r: 0, c: 0 },
  { r: 1, c: -3 },
  { r: 1, c: -2 },
  { r: 1, c: -1 },
  { r: 1, c: 0 },
  { r: 1, c: 1 },
  { r: 1, c: 2 },
  { r: 1, c: 3 },
  { r: 2, c: 0 },
  { r: 3, c: -1 },
  { r: 3, c: 0 },
  { r: 3, c: 1 },
]

function rotate(dr: number, dc: number, o: Orientation): Coord {
  switch (o) {
    case 0:
      return { r: dr, c: dc }
    case 90:
      return { r: dc, c: -dr }
    case 180:
      return { r: -dr, c: -dc }
    case 270:
      return { r: -dc, c: dr }
  }
}

function baseShape(longWings: boolean): Coord[] {
  return longWings ? BASE_LONG : BASE_SHORT
}

export function planeCells(
  head: Coord,
  orientation: Orientation,
  longWings = false,
): Coord[] {
  return baseShape(longWings).map((p) => {
    const d = rotate(p.r, p.c, orientation)
    return { r: head.r + d.r, c: head.c + d.c }
  })
}

export function isValidPlacement(
  head: Coord,
  orientation: Orientation,
  occupied: Set<string>,
  gridSize = GRID,
  longWings = false,
): boolean {
  const cells = planeCells(head, orientation, longWings)
  for (const cell of cells) {
    if (!inBounds(cell.r, cell.c, gridSize)) return false
    if (occupied.has(`${cell.r},${cell.c}`)) return false
  }
  return true
}

export function nextOrientation(o: Orientation): Orientation {
  return ((o + 90) % 360) as Orientation
}

export function randomPlacement(
  occupied: Set<string>,
  rng: () => number = Math.random,
  gridSize = GRID,
  longWings = false,
): { head: Coord; orientation: Orientation } | null {
  const orients: Orientation[] = [0, 90, 180, 270]
  for (let attempt = 0; attempt < 600; attempt++) {
    const head = {
      r: Math.floor(rng() * gridSize),
      c: Math.floor(rng() * gridSize),
    }
    const orientation = orients[Math.floor(rng() * 4)]
    if (isValidPlacement(head, orientation, occupied, gridSize, longWings)) {
      return { head, orientation }
    }
  }
  return null
}

export const PLANE_CELL_COUNT = BASE_SHORT.length
export const PLANE_CELL_COUNT_LONG = BASE_LONG.length
