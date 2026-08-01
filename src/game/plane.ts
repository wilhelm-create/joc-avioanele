import type { Coord, Orientation } from './types'
import { GRID, inBounds } from './types'

/**
 * Classic Romanian plane (10 cells).
 * Origin = cockpit/head. Shape points "up" at orientation 0:
 *
 *       H
 *   W W W W W
 *       B
 *     T T T
 */
const BASE: Coord[] = [
  { r: 0, c: 0 }, // head
  { r: 1, c: -2 },
  { r: 1, c: -1 },
  { r: 1, c: 0 },
  { r: 1, c: 1 },
  { r: 1, c: 2 },
  { r: 2, c: 0 }, // body
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

/** Absolute cells for a plane with head at `head` and given orientation */
export function planeCells(head: Coord, orientation: Orientation): Coord[] {
  return BASE.map((p) => {
    const d = rotate(p.r, p.c, orientation)
    return { r: head.r + d.r, c: head.c + d.c }
  })
}

export function isValidPlacement(
  head: Coord,
  orientation: Orientation,
  occupied: Set<string>,
): boolean {
  const cells = planeCells(head, orientation)
  for (const cell of cells) {
    if (!inBounds(cell.r, cell.c)) return false
    if (occupied.has(`${cell.r},${cell.c}`)) return false
  }
  return true
}

export function nextOrientation(o: Orientation): Orientation {
  return ((o + 90) % 360) as Orientation
}

/** Try to place randomly (for auto-place cookie helper) */
export function randomPlacement(
  occupied: Set<string>,
  rng: () => number = Math.random,
): { head: Coord; orientation: Orientation } | null {
  const orients: Orientation[] = [0, 90, 180, 270]
  for (let attempt = 0; attempt < 400; attempt++) {
    const head = {
      r: Math.floor(rng() * GRID),
      c: Math.floor(rng() * GRID),
    }
    const orientation = orients[Math.floor(rng() * 4)]
    if (isValidPlacement(head, orientation, occupied)) {
      return { head, orientation }
    }
  }
  return null
}

export const PLANE_CELL_COUNT = BASE.length
