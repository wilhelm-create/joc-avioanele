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
import { key, label } from './types'
import {
  clampSettings,
  colLabels,
  DEFAULT_SETTINGS,
  type GameSettings,
} from './settings'
import { t } from '../i18n'

const COLORS = {
  p1: '#e8956a',
  p2: '#5bb4e5',
}

function emptyPlayer(id: PlayerId, name: string, color?: string): PlayerState {
  return {
    id,
    name,
    color: color || COLORS[id],
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
  /** Shared multiplayer / local match settings */
  settings: GameSettings = { ...DEFAULT_SETTINGS }
  /** Cookie: radar revealed cells this game (for UI pulse) */
  lastRadar: Coord[] = []
  /** Pending orientation while placing */
  placeOrientation: Orientation = 0
  /** Ghost preview head */
  ghostHead: Coord | null = null
  listeners = new Set<() => void>()

  constructor() {
    this.p1 = emptyPlayer('p1', 'Jucător 1', this.settings.planeColor)
    this.p2 = emptyPlayer('p2', 'Jucător 2', COLORS.p2)
  }

  get gridSize(): number {
    return this.settings.gridSize
  }

  get planesPerPlayer(): number {
    return this.settings.planesPerPlayer
  }

  get cols(): string {
    return colLabels(this.gridSize)
  }

  get longWings(): boolean {
    return this.settings.longWings
  }

  /** Apply settings; clears fleets if geometry changed (only before battle). */
  applySettings(raw: Partial<GameSettings>, silent = false) {
    const next = clampSettings(raw)
    const geometryChanged =
      next.gridSize !== this.settings.gridSize ||
      next.planesPerPlayer !== this.settings.planesPerPlayer ||
      next.longWings !== this.settings.longWings
    this.settings = next
    this.p1.color = next.planeColor
    // Never wipe fleets once shots are flying
    const canResetFleets =
      this.phase === 'placement' ||
      this.phase === 'online-lobby' ||
      this.phase === 'menu'
    if (geometryChanged && canResetFleets) {
      this.p1.planes = []
      this.p1.fleet.clear()
      this.p2.planes = []
      this.p2.fleet.clear()
      this.ghostHead = null
      this.message = t('engineSettingsUpdated')
    }
    if (!silent) this.emit()
  }

  /** True if this player has a placed fleet */
  hasFleet(id: PlayerId): boolean {
    return this.player(id).planes.length > 0
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
    this.message = t('enginePlacing', { name: this.p1.name })
    this.emit()
  }

  startOnlineHost(name: string) {
    this.mode = 'online-host'
    this.p1.name = name.trim() || 'Gazdă'
    this.p2.name = 'Oaspete'
    this.phase = 'online-lobby'
    this.message = t('preparingRoom')
    this.emit()
  }

  startOnlineJoin(name: string) {
    this.mode = 'online-join'
    this.p1.name = 'Gazdă'
    this.p2.name = name.trim() || 'Oaspete'
    this.phase = 'online-lobby'
    this.message = t('preparingRoom')
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
    this.message = t('enginePlaceOnline')
    this.emit()
  }

  /** Rotate placement ghost; does not re-render whole UI (caller repaints ghost). */
  rotateGhost() {
    this.placeOrientation = ((this.placeOrientation + 90) % 360) as Orientation
  }

  setOrientation(o: Orientation) {
    this.placeOrientation = o
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
    return isValidPlacement(
      head,
      this.placeOrientation,
      this.occupiedSet(p),
      this.gridSize,
      this.longWings,
    )
  }

  placePlane(head: Coord, silent = false): boolean {
    if (this.phase !== 'placement') return false
    const p = this.player(this.placingPlayer)
    if (p.planes.length >= this.planesPerPlayer) {
      this.ghostHead = null
      return false
    }
    if (
      !isValidPlacement(
        head,
        this.placeOrientation,
        this.occupiedSet(p),
        this.gridSize,
        this.longWings,
      )
    ) {
      return false
    }

    const cells = planeCells(head, this.placeOrientation, this.longWings)
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

    this.ghostHead = null
    if (p.planes.length >= this.planesPerPlayer) {
      this.message = t('engineAllPlaced')
    } else {
      this.message = t('enginePlanePlaced', {
        n: p.planes.length,
        total: this.planesPerPlayer,
        left: this.planesPerPlayer - p.planes.length,
      })
    }
    if (!silent) this.emit()
    return true
  }

  /**
   * Pick up a placed plane (tap / drag to move). Removes it and restores ghost + orientation.
   * @returns original head + orientation for cancel / drag offset, or null
   */
  pickUpPlaneAt(
    coord: Coord,
    silent = false,
  ): { head: Coord; orientation: Orientation } | null {
    if (this.phase !== 'placement') return null
    const p = this.player(this.placingPlayer)
    const cell = p.fleet.get(key(coord.r, coord.c))
    if (!cell) return null
    const plane = p.planes[cell.planeId]
    if (!plane) return null

    const orientation = plane.orientation
    const head = { ...plane.head }
    this.placeOrientation = orientation

    for (const c of plane.cells) {
      p.fleet.delete(key(c.r, c.c))
    }
    p.planes.splice(cell.planeId, 1)
    // reindex plane ids so fleet map stays consistent
    p.planes.forEach((pl, i) => {
      pl.id = i
      for (const c of pl.cells) {
        const isHead = c.r === pl.head.r && c.c === pl.head.c
        p.fleet.set(key(c.r, c.c), { planeId: i, isHead })
      }
    })

    this.ghostHead = head
    this.message = t('enginePlanePickedUp', {
      n: p.planes.length,
      total: this.planesPerPlayer,
    })
    if (!silent) this.emit()
    return { head, orientation }
  }

  /** Place back at a previous head/orientation (drag cancel). */
  restorePlane(head: Coord, orientation: Orientation, silent = false): boolean {
    if (this.phase !== 'placement') return false
    const prev = this.placeOrientation
    this.placeOrientation = orientation
    const ok = this.placePlane(head, silent)
    if (!ok) this.placeOrientation = prev
    return ok
  }

  /** Explicit confirm — only then leave placement / wait for opponent. */
  confirmPlacement(silent = false): boolean {
    if (this.phase !== 'placement') return false
    const p = this.player(this.placingPlayer)
    if (p.planes.length < this.planesPerPlayer) {
      this.message = t('engineNeedAllPlanes', { n: this.planesPerPlayer })
      if (!silent) this.emit()
      return false
    }
    this.onPlacementComplete(silent)
    return true
  }

  /** Cookie helper: auto-place remaining planes (does not confirm — user presses Done). */
  autoPlaceRemaining(): boolean {
    if (this.phase !== 'placement') return false
    const p = this.player(this.placingPlayer)
    const silent = true
    while (p.planes.length < this.planesPerPlayer) {
      const result = randomPlacement(
        this.occupiedSet(p),
        Math.random,
        this.gridSize,
        this.longWings,
      )
      if (!result) {
        this.message = t('engineNoSpace')
        this.emit()
        return false
      }
      this.placeOrientation = result.orientation
      if (!this.placePlane(result.head, silent)) {
        this.emit()
        return false
      }
    }
    this.message = t('engineAllPlaced')
    this.emit()
    return true
  }

  clearPlacement() {
    if (this.phase !== 'placement') return
    const p = this.player(this.placingPlayer)
    p.planes = []
    p.fleet.clear()
    this.message = t('engineGridCleared')
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
    this.message = t('engineFleetReady')
    if (!silent) this.emit()
  }

  continueAfterPass() {
    if (this.phase !== 'pass-device') return
    if (this.mode === 'local' && this.placingPlayer === 'p1' && this.p2.planes.length < this.planesPerPlayer) {
      this.placingPlayer = 'p2'
      this.phase = 'placement'
      this.placeOrientation = 0
      this.message = `${this.p2.name}, plasează cele ${this.planesPerPlayer} avioane (fără să te uite ${this.p1.name}!)`
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
    if (this.p1.planes.length >= this.planesPerPlayer && this.p2.planes.length >= this.planesPerPlayer) {
      this.phase = 'battle'
      this.currentPlayer = 'p1'
      this.turn = 1
      this.message = t('engineBattleStart', { name: this.p1.name })
      this.emit()
      return true
    }
    this.message = who === 'p1' ? t('engineHostReady') : t('engineGuestReady')
    this.emit()
    return false
  }

  applyRemotePlacement(who: PlayerId, snapshot: SerializablePlayer) {
    const p = deserializePlayer(snapshot)
    if (who === 'p1') this.p1 = p
    else this.p2 = p
    this.emit()
  }

  /**
   * @param opts.force — apply even if turn pointer is desynced (remote multiplayer)
   * @param opts.silent — don't notify UI listeners (caller does soft update)
   */
  fire(
    at: Coord,
    by?: PlayerId,
    opts?: { force?: boolean; silent?: boolean },
  ): ShotResult {
    if (this.phase !== 'battle') {
      return { coord: at, kind: 'already' }
    }
    const shooterId = by ?? this.currentPlayer
    if (!opts?.force && shooterId !== this.currentPlayer) {
      return { coord: at, kind: 'already' }
    }
    // remote force: align turn so state stays consistent
    if (opts?.force) this.currentPlayer = shooterId

    const shooter = this.player(shooterId)
    const target = this.opponent(shooterId)
    const k = key(at.r, at.c)

    if (shooter.fired.has(k) && shooter.fired.get(k) !== 'radar') {
      this.message = t('engineAlreadyShot')
      if (!opts?.silent) this.emit()
      return { coord: at, kind: 'already' }
    }
    if (shooter.fired.get(k) === 'miss' || shooter.fired.get(k) === 'hit' || shooter.fired.get(k) === 'sunk') {
      this.message = t('engineAlreadyHere')
      if (!opts?.silent) this.emit()
      return { coord: at, kind: 'already' }
    }

    const fleetCell = target.fleet.get(k)
    let result: ShotResult

    if (!fleetCell) {
      shooter.fired.set(k, 'miss')
      target.received.set(k, 'miss')
      result = { coord: at, kind: 'miss' }
      this.message = t('engineMiss', { cell: label(at, this.cols) })
    } else {
      const plane = target.planes[fleetCell.planeId]
      if (plane.sunk) {
        return { coord: at, kind: 'already' }
      }

      if (fleetCell.isHead) {
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
        this.message = t('engineSunk', { cell: label(at, this.cols), n: target.planesSunk })
      } else {
        shooter.fired.set(k, 'hit')
        target.received.set(k, 'hit')
        result = { coord: at, kind: 'hit', planeId: plane.id }
        this.message = t('engineHit', { cell: label(at, this.cols) })
      }
    }

    this.lastShot = result

    if (target.planesSunk >= this.planesPerPlayer) {
      this.winner = shooterId
      this.phase = 'game-over'
      this.message = t('engineWin', { name: shooter.name })
      if (!opts?.silent) this.emit()
      return result
    }

    if (this.mode === 'local') {
      this.phase = 'pass-device'
      this.currentPlayer = shooterId === 'p1' ? 'p2' : 'p1'
      this.turn++
      this.message = `${result.kind === 'miss' ? 'Apă' : result.kind === 'sunk' ? 'Avion doborât' : 'Lovit'}! Dă telefonul lui ${this.player(this.currentPlayer).name}`
    } else {
      this.currentPlayer = shooterId === 'p1' ? 'p2' : 'p1'
      this.turn++
      this.message = t('engineTurn', { name: this.player(this.currentPlayer).name })
    }

    if (!opts?.silent) this.emit()
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
      this.message = t('engineRadarUsed')
      this.emit()
      return []
    }

    const candidates: Coord[] = []
    for (let r = 0; r < this.gridSize; r++) {
      for (let c = 0; c < this.gridSize; c++) {
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
        ? t('engineRadarOk', { n: revealed.length })
        : t('engineRadarEmpty')
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
    if (this.p1.planes.length < this.planesPerPlayer || this.p2.planes.length < this.planesPerPlayer) {
      this.continueAfterPass()
      return
    }
    this.phase = 'battle'
    this.message = t('engineAttackTurn', { name: this.player(this.currentPlayer).name })
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
      settings: { ...this.settings },
      p1: serializePlayer(this.p1),
      p2: serializePlayer(this.p2),
    }
  }

  loadSnapshot(s: GameSnapshot, silent = false) {
    this.phase = s.phase
    this.mode = s.mode
    this.currentPlayer = s.currentPlayer
    this.placingPlayer = s.placingPlayer
    this.winner = s.winner
    this.turn = s.turn
    this.lastShot = s.lastShot
    this.message = s.message
    if (s.settings) this.settings = clampSettings(s.settings)
    this.p1 = deserializePlayer(s.p1)
    this.p2 = deserializePlayer(s.p2)
    if (!silent) this.emit()
  }

  /** View helpers for UI */
  getGhostCells(): Coord[] {
    if (!this.ghostHead || this.phase !== 'placement') return []
    return planeCells(this.ghostHead, this.placeOrientation, this.longWings)
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
