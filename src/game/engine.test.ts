/**
 * Lightweight node-runnable game logic checks (no browser).
 * Run: npx tsx src/game/engine.test.ts
 */
import { GameEngine } from './engine'
import { planeCells, isValidPlacement, PLANE_CELL_COUNT } from './plane'
import type { Orientation } from './types'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
}

function testPlaneShape() {
  const cells = planeCells({ r: 2, c: 4 }, 0)
  assert(cells.length === PLANE_CELL_COUNT, 'plane has 10 cells')
  assert(cells[0].r === 2 && cells[0].c === 4, 'head at origin')
  assert(isValidPlacement({ r: 0, c: 0 }, 0, new Set()) === false, 'out of bounds top-left')
  assert(isValidPlacement({ r: 0, c: 4 }, 0, new Set()) === true, 'valid top center')
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
  // pick up and re-place should work
  const head0 = { ...g.p1.planes[0].head }
  assert(g.pickUpPlaneAt(head0), 'pick up plane')
  assert(g.p1.planes.length === 2, 'one less after pick up')
  assert(g.autoPlaceRemaining(), 're-auto remaining')
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

function main() {
  testPlaneShape()
  testRotations()
  testFullLocalGame()
  testRadarCookie()
  testNoGreenInCss()
  console.log('\nAll engine tests passed.')
}

main()
