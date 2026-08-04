/**
 * Lightweight node-runnable game logic checks (no browser).
 * Run: npx tsx src/game/engine.test.ts
 */
import { GameEngine } from './engine'
import { AiOpponent } from './ai'
import { planeCells, isValidPlacement, PLANE_CELL_COUNT } from './plane'
import type { CellState, Orientation } from './types'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function testPlaneShape() {
  const cells = planeCells({ r: 2, c: 4 }, 0)
  assert(cells.length === PLANE_CELL_COUNT, 'plane has 10 cells')
  assert(cells[0].r === 2 && cells[0].c === 4, 'head at origin')
  assert(isValidPlacement({ r: 0, c: 0 }, 0, new Set(), 10, false) === false, 'out of bounds top-left')
  assert(isValidPlacement({ r: 0, c: 4 }, 0, new Set(), 10, false) === true, 'valid top center')
  const long = planeCells({ r: 4, c: 4 }, 0, true)
  assert(long.length === 12, 'long wings 12 cells')
  console.log('✓ plane shape')
}

function testRotations() {
  const orients: Orientation[] = [0, 90, 180, 270]
  for (const o of orients) {
    const cells = planeCells({ r: 4, c: 4 }, o)
    assert(cells.length === 10, 'rotation ' + o)
  }
  console.log('✓ rotations')
}

function testFullLocalGame() {
  const g = new GameEngine()
  g.setNames('Ana', 'Bogdan')
  g.startLocal()
  assert(g.phase === 'placement', 'placement p1')
  assert(g.autoPlaceRemaining(), 'auto p1')
  assert(g.phase === 'placement', 'still placement until confirm')
  assert(g.p1.planes.length === 3, 'p1 has 3 planes')
  // pick up and re-place / drag-cancel restore
  const head0 = { ...g.p1.planes[0].head }
  const o0 = g.p1.planes[0].orientation
  const lifted = g.pickUpPlaneAt(head0)
  assert(lifted, 'pick up plane')
  assert(g.p1.planes.length === 2, 'one less after pick up')
  assert(g.restorePlane(lifted!.head, lifted!.orientation), 'restore after drag cancel')
  assert(g.p1.planes.length === 3, 'restored to 3')
  assert(g.confirmPlacement(), 'confirm p1')
  assert(g.phase === 'pass-device', 'pass after p1 confirm')
  g.continueAfterPass()
  assert(g.phase === 'placement', 'placement p2')
  assert(g.placingPlayer === 'p2', 'p2 placing')
  assert(g.autoPlaceRemaining(), 'auto p2')
  assert(g.confirmPlacement(), 'confirm p2')
  g.continueAfterPass()
  // after both placed, continueAfterPass sets pass again then resume
  if (g.phase === 'pass-device') g.resumeBattleFromPass()
  assert(g.phase === 'battle', 'battle starts')
  assert(g.currentPlayer === 'p1', 'p1 first')

  // Sink all p2 planes by hitting cockpits on p1 turns only
  let shots = 0
  const heads = g.p2.planes.map((p) => ({ ...p.headCell }))
  for (const head of heads) {
    while (g.phase === 'pass-device') g.resumeBattleFromPass()
    if (g.phase === 'game-over') break
    // If somehow p2's turn, skip with a dummy miss far away then pass back
    if (g.currentPlayer !== 'p1') {
      // p2 fires a safe miss if possible
      outer: for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
          if (!g.p2.fired.has(`${r},${c}`) && !g.p1.fleet.has(`${r},${c}`)) {
            g.fire({ r, c }, 'p2')
            break outer
          }
        }
      }
      while (g.phase === 'pass-device') g.resumeBattleFromPass()
    }
    assert(g.currentPlayer === 'p1', 'p1 should shoot heads')
    const res = g.fire(head, 'p1')
    shots++
    assert(res.kind === 'sunk', 'sunk head got ' + res.kind + ' at ' + head.r + ',' + head.c)
    if (g.phase === 'pass-device') g.resumeBattleFromPass()
  }
  assert(g.phase === 'game-over', 'game over after 3 sinks')
  assert(g.winner === 'p1', 'p1 wins')
  assert(shots === 3, 'exactly 3 cockpit shots')
  console.log('✓ full local game, shots=', shots)
}

function testRadarCookie() {
  const g = new GameEngine()
  g.startLocal()
  g.autoPlaceRemaining()
  g.confirmPlacement()
  g.continueAfterPass()
  g.autoPlaceRemaining()
  g.confirmPlacement()
  g.continueAfterPass()
  if (g.phase === 'pass-device') g.resumeBattleFromPass()
  const revealed = g.useRadar('p1')
  assert(revealed.length > 0 && revealed.length <= 5, 'radar reveals up to 5')
  assert(g.p1.radarUsed, 'radar used flag')
  const again = g.useRadar('p1')
  assert(again.length === 0, 'radar once only')
  console.log('✓ radar cookie')
}

function testNoGreenInCss() {
  // checked in playwright; here just placeholder
  console.log('✓ (css checked in usability suite)')
}

function testVsAiGame() {
  const g = new GameEngine()
  g.applySettings({ difficulty: 'easy', gridSize: 10, planesPerPlayer: 3, longWings: false })
  g.startVsAi('Tester')
  assert(g.mode === 'vs-ai', 'mode vs-ai')
  assert(g.phase === 'placement', 'placement')
  assert(g.autoPlaceRemaining(), 'human auto place')
  assert(g.confirmPlacement(), 'confirm starts battle with AI fleet')
  assert(g.phase === 'battle', 'battle after confirm')
  assert(g.p2.planes.length === 3, 'AI placed 3 planes')
  assert(g.currentPlayer === 'p1', 'human shoots first')
  assert(g.p1.name === 'Tester', 'human name')

  // Finish by sinking all AI cockpits
  const heads = g.p2.planes.map((p) => ({ ...p.headCell }))
  for (const head of heads) {
    assert(g.currentPlayer === 'p1', 'human turn for head')
    const res = g.fire(head, 'p1')
    assert(res.kind === 'sunk', 'sunk AI head got ' + res.kind)
    if (g.phase === 'game-over') break
    // AI would shoot; fire a safe miss as p2
    if (g.currentPlayer === 'p2' && g.phase === 'battle') {
      outer: for (let r = 0; r < 10; r++) {
        for (let c = 0; c < 10; c++) {
          if (!g.p2.fired.has(`${r},${c}`) && !g.p1.fleet.has(`${r},${c}`)) {
            g.fire({ r, c }, 'p2')
            break outer
          }
        }
      }
    }
  }
  assert(g.phase === 'game-over', 'vs-ai game over')
  assert(g.winner === 'p1', 'human wins')
  console.log('✓ vs-ai game')
}

function testAiChooser() {
  let i = 0
  const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.15, 0.25]
  const rng = () => seq[i++ % seq.length]
  const ai = new AiOpponent(rng)
  const fired = new Map<string, CellState>()
  const a = ai.chooseShot('easy', 10, fired)
  assert(a.r >= 0 && a.r < 10 && a.c >= 0 && a.c < 10, 'shot in bounds')
  fired.set(`${a.r},${a.c}`, 'miss')
  // after a hit, hard should prefer adjacent
  fired.set('4,4', 'hit')
  const hunt = ai.chooseShot('hard', 10, fired)
  const adj =
    (Math.abs(hunt.r - 4) === 1 && hunt.c === 4) ||
    (Math.abs(hunt.c - 4) === 1 && hunt.r === 4)
  assert(adj, 'hard hunts adjacent to hit')
  console.log('✓ ai chooser')
}

function main() {
  testPlaneShape()
  testRotations()
  testFullLocalGame()
  testRadarCookie()
  testVsAiGame()
  testAiChooser()
  testNoGreenInCss()
  console.log('\nAll engine tests passed.')
}

main()
