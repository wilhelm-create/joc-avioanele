/**
 * Virtual opponent for vs-AI mode.
 * Difficulty controls search quality (not only board size presets).
 */
import type { Difficulty } from './settings'
import type { CellState, Coord } from './types'
import { key } from './types'

export type FiredMap = Map<string, CellState>

const DIRS: Coord[] = [
  { r: -1, c: 0 },
  { r: 1, c: 0 },
  { r: 0, c: -1 },
  { r: 0, c: 1 },
]

function inGrid(r: number, c: number, n: number): boolean {
  return r >= 0 && r < n && c >= 0 && c < n
}

/** Cell not yet shot (radar = known water, skip for attacks). */
function isOpen(fired: FiredMap, r: number, c: number): boolean {
  const st = fired.get(key(r, c))
  return st === undefined
}

function openCells(fired: FiredMap, gridSize: number): Coord[] {
  const out: Coord[] = []
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (isOpen(fired, r, c)) out.push({ r, c })
    }
  }
  return out
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

function pickRandom(cells: Coord[], rng: () => number): Coord | null {
  if (!cells.length) return null
  return cells[Math.floor(rng() * cells.length)]
}

/** Hits that still need hunting (body hits, not fully sunk). */
function activeHits(fired: FiredMap, gridSize: number): Coord[] {
  const hits: Coord[] = []
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (fired.get(key(r, c)) === 'hit') hits.push({ r, c })
    }
  }
  return hits
}

function neighbors(r: number, c: number, gridSize: number): Coord[] {
  const out: Coord[] = []
  for (const d of DIRS) {
    const nr = r + d.r
    const nc = c + d.c
    if (inGrid(nr, nc, gridSize)) out.push({ r: nr, c: nc })
  }
  return out
}

/**
 * Hunt: prefer extending a line of hits; else any open adjacent to a hit.
 */
function huntCandidates(fired: FiredMap, gridSize: number): Coord[] {
  const hits = activeHits(fired, gridSize)
  if (!hits.length) return []

  const scored = new Map<string, number>()

  // Line extension: two+ hits same row or column
  for (let i = 0; i < hits.length; i++) {
    for (let j = i + 1; j < hits.length; j++) {
      const a = hits[i]
      const b = hits[j]
      if (a.r === b.r) {
        const row = a.r
        const cMin = Math.min(a.c, b.c)
        const cMax = Math.max(a.c, b.c)
        // extend ends
        for (const c of [cMin - 1, cMax + 1]) {
          if (inGrid(row, c, gridSize) && isOpen(fired, row, c)) {
            const k = key(row, c)
            scored.set(k, (scored.get(k) ?? 0) + 5)
          }
        }
        // fill gaps
        for (let c = cMin + 1; c < cMax; c++) {
          if (isOpen(fired, row, c)) {
            const k = key(row, c)
            scored.set(k, (scored.get(k) ?? 0) + 8)
          }
        }
      } else if (a.c === b.c) {
        const col = a.c
        const rMin = Math.min(a.r, b.r)
        const rMax = Math.max(a.r, b.r)
        for (const r of [rMin - 1, rMax + 1]) {
          if (inGrid(r, col, gridSize) && isOpen(fired, r, col)) {
            const k = key(r, col)
            scored.set(k, (scored.get(k) ?? 0) + 5)
          }
        }
        for (let r = rMin + 1; r < rMax; r++) {
          if (isOpen(fired, r, col)) {
            const k = key(r, col)
            scored.set(k, (scored.get(k) ?? 0) + 8)
          }
        }
      }
    }
  }

  // Adjacent to any hit
  for (const h of hits) {
    for (const n of neighbors(h.r, h.c, gridSize)) {
      if (!isOpen(fired, n.r, n.c)) continue
      const k = key(n.r, n.c)
      scored.set(k, (scored.get(k) ?? 0) + 2)
    }
  }

  const ranked = [...scored.entries()]
    .map(([k, score]) => {
      const [r, c] = k.split(',').map(Number)
      return { r, c, score }
    })
    .sort((a, b) => b.score - a.score)

  return ranked.map(({ r, c }) => ({ r, c }))
}

/** Checkerboard parity search — denser coverage for plane shapes. */
function parityCandidates(fired: FiredMap, gridSize: number, offset: number): Coord[] {
  const primary: Coord[] = []
  const secondary: Coord[] = []
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (!isOpen(fired, r, c)) continue
      if ((r + c) % 2 === offset) primary.push({ r, c })
      else secondary.push({ r, c })
    }
  }
  return primary.length ? primary : secondary
}

/**
 * Prefer cells slightly inward (heads of planes rarely sit on pure corners
 * with no room for body) — mild bias for hard/impossible.
 */
function centerBiasScore(r: number, c: number, gridSize: number): number {
  const mid = (gridSize - 1) / 2
  const dist = Math.abs(r - mid) + Math.abs(c - mid)
  const max = gridSize
  return max - dist
}

export class AiOpponent {
  /** Which checkerboard color to prefer when searching. */
  private parity = 0
  private rng: () => number

  constructor(rng: () => number = Math.random) {
    this.rng = rng
    this.parity = rng() < 0.5 ? 0 : 1
  }

  reset(rng?: () => number) {
    if (rng) this.rng = rng
    this.parity = this.rng() < 0.5 ? 0 : 1
  }

  /**
   * Pick next shot cell. Never returns a cell already shot or marked radar.
   */
  chooseShot(difficulty: Difficulty, gridSize: number, fired: FiredMap): Coord {
    const open = openCells(fired, gridSize)
    if (!open.length) return { r: 0, c: 0 }

    const hunt = huntCandidates(fired, gridSize)

    switch (difficulty) {
      case 'easy': {
        // Often ignores obvious follow-ups → feels weak
        if (hunt.length && this.rng() < 0.35) {
          return hunt[0]
        }
        return pickRandom(open, this.rng)!
      }
      case 'medium': {
        if (hunt.length) {
          // Slight noise: not always the best adjacent
          const top = hunt.slice(0, Math.min(4, hunt.length))
          return pickRandom(top, this.rng)!
        }
        return pickRandom(open, this.rng)!
      }
      case 'hard': {
        if (hunt.length) return hunt[0]
        const parity = parityCandidates(fired, gridSize, this.parity)
        shuffleInPlace(parity, this.rng)
        // mild center preference among parity cells
        parity.sort(
          (a, b) =>
            centerBiasScore(b.r, b.c, gridSize) - centerBiasScore(a.r, a.c, gridSize) +
            (this.rng() - 0.5) * 2,
        )
        return parity[0] ?? pickRandom(open, this.rng)!
      }
      case 'impossible': {
        if (hunt.length) {
          // Always best hunt target
          return hunt[0]
        }
        const parity = parityCandidates(fired, gridSize, this.parity)
        // Score: parity + center + avoid edges a bit
        let best = parity[0] ?? open[0]
        let bestScore = -1e9
        const pool = parity.length ? parity : open
        for (const cell of pool) {
          let s = centerBiasScore(cell.r, cell.c, gridSize) * 2
          // Prefer cells with more open neighbors (space for a plane)
          let openN = 0
          for (const n of neighbors(cell.r, cell.c, gridSize)) {
            if (isOpen(fired, n.r, n.c) || fired.get(key(n.r, n.c)) === undefined) openN++
            // known water nearby is fine; sunk/hit nearby is good (but hunt already handled)
            const st = fired.get(key(n.r, n.c))
            if (st === 'miss' || st === 'radar') s -= 0.3
          }
          s += openN * 0.5
          s += this.rng() * 0.4 // tiny jitter
          if (s > bestScore) {
            bestScore = s
            best = cell
          }
        }
        return best
      }
    }
  }

  /**
   * Whether AI should spend its free radar this turn (before shooting).
   */
  shouldUseRadar(
    difficulty: Difficulty,
    radarUsed: boolean,
    turn: number,
    fired: FiredMap,
    gridSize: number,
  ): boolean {
    if (radarUsed) return false
    const open = openCells(fired, gridSize).length
    const total = gridSize * gridSize
    const hits = activeHits(fired, gridSize).length

    switch (difficulty) {
      case 'easy':
        return false
      case 'medium':
        // Occasional late radar when still hunting cold
        return turn >= 8 && hits === 0 && open > total * 0.45 && this.rng() < 0.22
      case 'hard':
        return turn >= 5 && hits === 0 && open > total * 0.4 && this.rng() < 0.45
      case 'impossible':
        // Early info advantage
        return turn >= 2 && turn <= 6 && hits === 0 && this.rng() < 0.75
    }
  }
}

/** Singleton used by the UI battle loop (reset on new match). */
export const aiOpponent = new AiOpponent()
