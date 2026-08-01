import { isValidPlacement, planeCells, randomPlacement } from './plane'
import type {
  CellState,
  Coord,
  GameMode,
  GameSnapshot,
  Orientation,
  Phase,
  PlayerId,
  PlayerState,
  SerializablePlayer,
  ShotResult,
} from './types'
import { GRID, key, PLANES_PER_PLAYER, label } from './types'

const COLORS = {
  p1: '#a78bfa', // violet (no green)
  p2: '#fb923c', // orange
}

function emptyPlayer(id: PlayerId, name: string): PlayerState {
  return {
    id,
    name,
    color: COLORS[id],
    planes: [],
    fleet: new Map(),
    received: new Map(),
    fired: new Map(),
    radarUsed: false,
    planesSunk: 0,
  }
}

function serializePlayer(p: PlayerState): SerializablePlayer {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    planes: p.planes.map((pl) => ({ ...pl, cells: [...pl.cells], headCell: { ...pl.headCell }, head: { ...pl.head } })),
    fleet: [...p.fleet.entries()],
    received: [...p.received.entries()],
    fired: [...p.fired.entries()],
    radarUsed: p.radarUsed,
    planesSunk: p.planesSunk,
  }
}

function deserializePlayer(s: SerializablePlayer): PlayerState {
  return {
    id: s.id,
    name: s.name,
    color: s.color,
    planes: s.planes.map((pl) => ({
      ...pl,
      cells: pl.cells.map((c) => ({ ...c })),
      headCell: { ...pl.headCell },
      head: { ...pl.head },
    })),
    fleet: new Map(s.fleet),
    received: new Map(s.received),
    fired: new Map(s.fired),
    radarUsed: s.radarUsed,
    planesSunk: s.planesSunk,
  }
}

export class GameEngine {
  phase: Phase = 'menu'
  mode: GameMode = 'local'
  currentPlayer: PlayerId = 'p1'
  placingPlayer: PlayerId = 'p1'
  winner: PlayerId | null = null
  turn = 0
  lastShot: ShotResult | null = null
  message = ''
  p1: PlayerState
  p2: PlayerState
  /** Cookie: radar revealed cells this game (for UI pulse) */
  lastRadar: Coord[] = []
  /** Pending orientation while placing */
  placeOrientation: Orientation = 0
  /** Ghost preview head */
  ghostHead: Coord | null = null
  listeners = new Set<() => void>()

  constructor() {
    this.p1 = emptyPlayer('p1', 'Jucător 1')
    this.p2 = emptyPlayer('p2', 'Jucător 2')
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Notify UI listeners (public for screens that change phase directly). */
  notify() {
    for (const fn of this.listeners) fn()
  }

  private emit() {
    this.notify()
  }

  player(id: PlayerId): PlayerState {
    return id === 'p1' ? this.p1 : this.p2
  }

  opponent(id: PlayerId): PlayerState {
    return id === 'p1' ? this.p2 : this.p1
  }

  setNames(p1: string, p2: string) {
    this.p1.name = p1.trim() || 'Jucător 1'
    this.p2.name = p2.trim() || 'Jucător 2'
    this.emit()
  }

  startLocal() {
    this.mode = 'local'
    this.phase = 'placement'
    this.placingPlayer = 'p1'
    this.currentPlayer = 'p1'
    this.winner = null
    this.turn = 0
    this.lastShot = null
    this.p1 = emptyPlayer('p1', this.p1.name)
    this.p2 = emptyPlayer('p2', this.p2.name)
    this.placeOrientation = 0
    this.ghostHead = null
    this.message = `${this.p1.name}, plasează cele 3 avioane`
    this.emit()
  }

  startOnlineHost(name: string) {
    this.mode = 'online-host'
    this.p1.name = name.trim() || 'Gazdă'
    this.p2.name = 'Oaspete'
    this.phase = 'online-lobby'
    this.message = 'Așteaptă prietenul…'
    this.emit()
  }

  startOnlineJoin(name: string) {
    this.mode = 'online-join'
    this.p1.name = 'Gazdă'
    this.p2.name = name.trim() || 'Oaspete'
    this.phase = 'online-lobby'
    this.message = 'Conectare…'
    this.emit()
  }

  beginOnlinePlacement() {
    this.phase = 'placement'
    this.placingPlayer = this.mode === 'online-host' ? 'p1' : 'p2'
    this.currentPlayer = 'p1'
    this.winner = null
    this.turn = 0
    this.lastShot = null
    const keepNames = { p1: this.p1.name, p2: this.p2.name }
    this.p1 = emptyPlayer('p1', keepNames.p1)
    this.p2 = emptyPlayer('p2', keepNames.p2)
    this.placeOrientation = 0
    this.message = 'Plasează cele 3 avioane pe grila ta'
    this.emit()
  }

  rotateGhost() {
    this.placeOrientation = ((this.placeOrientation + 90) % 360) as Orientation
    this.emit()
  }

  /** Update ghost without notifying UI (UI paints ghost in-place to avoid full re-renders). */
  setGhost(head: Coord | null) {
    this.ghostHead = head
  }

  private occupiedSet(p: PlayerState): Set<string> {
    return new Set(p.fleet.keys())
  }

  canPlaceAt(head: Coord, forPlayer?: PlayerId): boolean {
    const p = this.player(forPlayer ?? this.placingPlayer)
    return isValidPlacement(head, this.placeOrientation, this.occupiedSet(p))
  }

  placePlane(head: Coord, silent = false): boolean {
    if (this.phase !== 'placement') return false
    const p = this.player(this.placingPlayer)
    if (p.planes.length >= PLANES_PER_PLAYER) return false
    if (!isValidPlacement(head, this.placeOrientation, this.occupiedSet(p))) return false

    const cells = planeCells(head, this.placeOrientation)
    const id = p.planes.length
    const placement = {
      id,
      head: { ...head },
      orientation: this.placeOrientation,
      cells,
      headCell: { ...head },
      sunk: false,
    }
    p.planes.push(placement)
    for (const cell of cells) {
      const isHead = cell.r === head.r && cell.c === head.c
      p.fleet.set(key(cell.r, cell.c), { planeId: id, isHead })
    }

    if (p.planes.length >= PLANES_PER_PLAYER) {
      this.onPlacementComplete(silent)
    } else {
      this.message = `Avion ${p.planes.length}/${PLANES_PER_PLAYER} plasat. Mai ai ${PLANES_PER_PLAYER - p.planes.length}.`
    }
    this.ghostHead = null
    if (!silent) this.emit()
    return true
  }

  /** Cookie helper: auto-place remaining planes (single UI notify at end). */
  autoPlaceRemaining(): boolean {
    if (this.phase !== 'placement') return false
    const p = this.player(this.placingPlayer)
    const silent = true
    while (p.planes.length < PLANES_PER_PLAYER) {
      const result = randomPlacement(this.occupiedSet(p))
      if (!result) {
        this.message = 'Nu am găsit loc liber — încearcă din nou sau roteste manual'
        this.emit()
        return false
      }
      this.placeOrientation = result.orientation
      if (!this.placePlane(result.head, silent)) {
        this.emit()
        return false
      }
    }
    this.emit()
    return true
  }

  clearPlacement() {
    if (this.phase !== 'placement') return
    const p = this.player(this.placingPlayer)
    p.planes = []
    p.fleet.clear()
    this.message = 'Grila ștearsă — plasează din nou'
    this.emit()
  }

  private onPlacementComplete(silent = false) {
    if (this.mode === 'local') {
      if (this.placingPlayer === 'p1') {
        this.phase = 'pass-device'
        this.message = `Gata, ${this.p1.name}! Dă telefonul lui ${this.p2.name}`
        if (!silent) this.emit()
        return
      }
      // both placed
      this.phase = 'pass-device'
      this.message = `Amândoi ați plasat! ${this.p1.name} începe. Dă telefonul`
      this.currentPlayer = 'p1'
      if (!silent) this.emit()
      return
    }
    // online: wait for both — external multiplayer sync handles transition
    this.message = 'Flota e gata. Așteaptă adversarul…'
    if (!silent) this.emit()
  }

  continueAfterPass() {
    if (this.phase !== 'pass-device') return
    if (this.mode === 'local' && this.placingPlayer === 'p1' && this.p2.planes.length < PLANES_PER_PLAYER) {
      this.placingPlayer = 'p2'
      this.phase = 'placement'
      this.placeOrientation = 0
      this.message = `${this.p2.name}, plasează cele 3 avioane (fără să te uite ${this.p1.name}!)`
      this.emit()
      return
    }
    // start battle
    this.phase = 'battle'
    this.currentPlayer = 'p1'
    this.turn = 1
    this.message = `Rândul lui ${this.p1.name} — atacă grila adversarului!`
    this.emit()
  }

  /** Mark online player ready and start battle if both ready */
  markOnlineReady(who: PlayerId) {
    // placement already done for `who`; check both
    if (this.p1.planes.length >= PLANES_PER_PLAYER && this.p2.planes.length >= PLANES_PER_PLAYER) {
      this.phase = 'battle'
      this.currentPlayer = 'p1'
      this.turn = 1
      this.message = `Bătălia începe! Atacă ${this.p1.name}`
      this.emit()
      return true
    }
    this.message = who === 'p1' ? 'Gazdă gata — așteaptă oaspetele' : 'Oaspete gata — așteaptă gazda'
    this.emit()
    return false
  }

  applyRemotePlacement(who: PlayerId, snapshot: SerializablePlayer) {
    const p = deserializePlayer(snapshot)
    if (who === 'p1') this.p1 = p
    else this.p2 = p
    this.emit()
  }

  fire(at: Coord, by?: PlayerId): ShotResult {
    if (this.phase !== 'battle') {
      return { coord: at, kind: 'already' }
    }
    const shooterId = by ?? this.currentPlayer
    if (shooterId !== this.currentPlayer) {
      return { coord: at, kind: 'already' }
    }
    const shooter = this.player(shooterId)
    const target = this.opponent(shooterId)
    const k = key(at.r, at.c)

    if (shooter.fired.has(k) && shooter.fired.get(k) !== 'radar') {
      this.message = 'Ai mai tras aici — alege altă celulă'
      this.emit()
      return { coord: at, kind: 'already' }
    }
    // allow firing on radar-revealed water (it's still a miss confirmation) — but radar marks empty
    if (shooter.fired.get(k) === 'miss' || shooter.fired.get(k) === 'hit' || shooter.fired.get(k) === 'sunk') {
      this.message = 'Ai mai tras aici'
      this.emit()
      return { coord: at, kind: 'already' }
    }

    const fleetCell = target.fleet.get(k)
    let result: ShotResult

    if (!fleetCell) {
      shooter.fired.set(k, 'miss')
      target.received.set(k, 'miss')
      result = { coord: at, kind: 'miss' }
      this.message = `${label(at)} — apă!`
    } else {
      const plane = target.planes[fleetCell.planeId]
      if (plane.sunk) {
        return { coord: at, kind: 'already' }
      }

      if (fleetCell.isHead) {
        // Destroy entire plane
        plane.sunk = true
        target.planesSunk++
        const sunkCells = [...plane.cells]
        for (const cell of sunkCells) {
          const ck = key(cell.r, cell.c)
          shooter.fired.set(ck, 'sunk')
          target.received.set(ck, 'sunk')
        }
        result = {
          coord: at,
          kind: 'sunk',
          planeId: plane.id,
          sunkCells,
        }
        this.message = `${label(at)} — CABINĂ! Avion doborât! (${target.planesSunk}/3)`
      } else {
        shooter.fired.set(k, 'hit')
        target.received.set(k, 'hit')
        result = { coord: at, kind: 'hit', planeId: plane.id }
        this.message = `${label(at)} — lovit!`
      }
    }

    this.lastShot = result

    if (target.planesSunk >= PLANES_PER_PLAYER) {
      this.winner = shooterId
      this.phase = 'game-over'
      this.message = `${shooter.name} câștigă! Toate avioanele au fost doborâte.`
      this.emit()
      return result
    }

    // switch turn
    if (this.mode === 'local') {
      this.phase = 'pass-device'
      this.currentPlayer = shooterId === 'p1' ? 'p2' : 'p1'
      this.turn++
      this.message = `${result.kind === 'miss' ? 'Apă' : result.kind === 'sunk' ? 'Avion doborât' : 'Lovit'}! Dă telefonul lui ${this.player(this.currentPlayer).name}`
    } else {
      this.currentPlayer = shooterId === 'p1' ? 'p2' : 'p1'
      this.turn++
      this.message = `Rândul lui ${this.player(this.currentPlayer).name}`
    }

    this.emit()
    return result
  }

  /**
   * Cookie #1 — Radar Pulse: once per player per game, reveal up to 5 empty
   * opponent cells as water (does not spend a turn).
   */
  useRadar(by?: PlayerId): Coord[] {
    const id = by ?? this.currentPlayer
    if (this.phase !== 'battle' || id !== this.currentPlayer) return []
    const shooter = this.player(id)
    const target = this.opponent(id)
    if (shooter.radarUsed) {
      this.message = 'Radarul a fost deja folosit'
      this.emit()
      return []
    }

    const candidates: Coord[] = []
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const k = key(r, c)
        if (shooter.fired.has(k)) continue
        if (target.fleet.has(k)) continue
        candidates.push({ r, c })
      }
    }

    // shuffle
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
    }

    const revealed = candidates.slice(0, 5)
    for (const cell of revealed) {
      const k = key(cell.r, cell.c)
      shooter.fired.set(k, 'radar')
      // do not mark on target.received so opponent board still clean
    }
    shooter.radarUsed = true
    this.lastRadar = revealed
    this.message =
      revealed.length > 0
        ? `📡 Radar: ${revealed.length} zone de apă confirmate!`
        : 'Radar: nu a mai rămas apă necunoscută'
    this.emit()
    return revealed
  }

  /** After pass screen in battle, enter battle view for current player */
  resumeBattleFromPass() {
    if (this.phase !== 'pass-device') return
    if (this.winner) {
      this.phase = 'game-over'
      this.emit()
      return
    }
    // if still in placement flow, handled by continueAfterPass
    if (this.p1.planes.length < PLANES_PER_PLAYER || this.p2.planes.length < PLANES_PER_PLAYER) {
      this.continueAfterPass()
      return
    }
    this.phase = 'battle'
    this.message = `Rândul lui ${this.player(this.currentPlayer).name} — atacă!`
    this.emit()
  }

  rematch() {
    const names = { p1: this.p1.name, p2: this.p2.name }
    const mode = this.mode
    this.p1 = emptyPlayer('p1', names.p1)
    this.p2 = emptyPlayer('p2', names.p2)
    this.winner = null
    this.turn = 0
    this.lastShot = null
    this.lastRadar = []
    this.placeOrientation = 0
    this.ghostHead = null
    if (mode === 'local') {
      this.startLocal()
    } else {
      this.mode = mode
      this.beginOnlinePlacement()
    }
  }

  backToMenu() {
    const names = { p1: this.p1.name, p2: this.p2.name }
    this.phase = 'menu'
    this.mode = 'local'
    this.p1 = emptyPlayer('p1', names.p1)
    this.p2 = emptyPlayer('p2', names.p2)
    this.winner = null
    this.message = ''
    this.emit()
  }

  snapshot(): GameSnapshot {
    return {
      phase: this.phase,
      mode: this.mode,
      currentPlayer: this.currentPlayer,
      placingPlayer: this.placingPlayer,
      winner: this.winner,
      turn: this.turn,
      lastShot: this.lastShot,
      message: this.message,
      p1: serializePlayer(this.p1),
      p2: serializePlayer(this.p2),
    }
  }

  loadSnapshot(s: GameSnapshot) {
    this.phase = s.phase
    this.mode = s.mode
    this.currentPlayer = s.currentPlayer
    this.placingPlayer = s.placingPlayer
    this.winner = s.winner
    this.turn = s.turn
    this.lastShot = s.lastShot
    this.message = s.message
    this.p1 = deserializePlayer(s.p1)
    this.p2 = deserializePlayer(s.p2)
    this.emit()
  }

  /** View helpers for UI */
  getGhostCells(): Coord[] {
    if (!this.ghostHead || this.phase !== 'placement') return []
    return planeCells(this.ghostHead, this.placeOrientation)
  }

  isGhostValid(): boolean {
    if (!this.ghostHead) return false
    return this.canPlaceAt(this.ghostHead)
  }

  cellDisplayOwn(p: PlayerState, r: number, c: number): CellState | 'plane' | 'head' {
    const k = key(r, c)
    const rec = p.received.get(k)
    if (rec) return rec
    const f = p.fleet.get(k)
    if (f) return f.isHead ? 'head' : 'plane'
    return 'empty'
  }

  cellDisplayEnemy(shooter: PlayerState, r: number, c: number): CellState {
    const k = key(r, c)
    return shooter.fired.get(k) ?? 'empty'
  }
}

export type { CellState, Coord, PlayerId, ShotResult }
