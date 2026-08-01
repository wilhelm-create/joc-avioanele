import { GameEngine } from '../game/engine'
import type { Coord, PlayerId, ShotResult } from '../game/types'
import { COLS, GRID, PLANES_PER_PLAYER } from '../game/types'
import {
  buzz,
  glitterBurst,
  sfxHit,
  sfxMiss,
  sfxPlace,
  sfxRadar,
  sfxSunk,
  sfxVictory,
  screenShake,
  unlockAudio,
} from '../cookies/effects'
import {
  generateRoomCode,
  hostGame,
  joinGame,
  type NetMessage,
  type OnlineSession,
} from '../multiplayer/peer'

const engine = new GameEngine()
let session: OnlineSession | null = null
let roomCode = ''
let myOnlineRole: PlayerId | null = null
let localNameDraft = { p1: 'Tu', p2: 'Prietenul' }

export function mountApp(root: HTMLElement) {
  const stars = document.createElement('div')
  stars.className = 'stars'
  stars.setAttribute('aria-hidden', 'true')
  document.body.prepend(stars)

  const fx = document.createElement('div')
  fx.id = 'fx-layer'
  document.body.appendChild(fx)

  const render = () => {
    root.innerHTML = ''
    root.appendChild(view())
  }

  engine.onChange(render)
  render()

  // unlock audio on first gesture
  const unlock = () => {
    unlockAudio()
    window.removeEventListener('pointerdown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
}

function view(): HTMLElement {
  switch (engine.phase) {
    case 'menu':
      return menuScreen()
    case 'mode-select':
      return modeSelectScreen()
    case 'name-entry':
      return nameEntryScreen()
    case 'online-lobby':
      return onlineLobbyScreen()
    case 'placement':
      return placementScreen()
    case 'pass-device':
      return passScreen()
    case 'battle':
      return battleScreen()
    case 'game-over':
      return gameOverScreen()
    default:
      return menuScreen()
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'className') node.className = String(v)
    else if (k === 'text') node.textContent = String(v)
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (k === 'html') node.innerHTML = String(v)
    else if (v === false || v === null || v === undefined) continue
    else if (k === 'disabled') (node as HTMLButtonElement).disabled = Boolean(v)
    else node.setAttribute(k, String(v))
  }
  for (const c of children) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

function menuScreen() {
  return el('div', { className: 'screen', 'data-screen': 'menu' }, [
    el('h1', { className: 'logo', text: '✈ Avioane' }),
    el('p', {
      className: 'tagline',
      text: 'Jocul clasic pe grilă 10×10. Doborâți avioanele prietenului!',
    }),
    el('div', { className: 'card' }, [
      el('button', {
        className: 'btn btn-primary btn-block',
        'data-action': 'play',
        text: 'Joacă acum',
        onClick: () => {
          engine.phase = 'mode-select'
          engine.notify()
        },
      }),
      el('div', { style: 'height:10px' }),
      el('p', {
        className: 'hint',
        text: '3 avioane · lovește cabina (◆) ca să dobori · fără culoarea verde 😉',
      }),
    ]),
    el('div', { className: 'cookie-bar' }, [
      el('span', { className: 'cookie-chip', text: '🍪 Radar o dată / joc' }),
      el('span', { className: 'cookie-chip', text: '🍪 Glitter burst' }),
      el('span', { className: 'cookie-chip', text: '🍪 Fanfară victorie' }),
    ]),
    el('div', { className: 'legend', style: 'margin-top:auto;padding-top:16px' }, [
      legendItem('#a78bfa', 'avion'),
      legendItem('#f472b6', 'cabină'),
      legendItem('#f43f5e', 'lovit'),
      legendItem('#fbbf24', 'doborât'),
      legendItem('#3b82f6', 'apă'),
    ]),
  ])
}

function legendItem(color: string, label: string) {
  return el('span', {}, [
    el('i', { className: 'swatch', style: `background:${color}` }),
    label,
  ])
}

function modeSelectScreen() {
  return el('div', { className: 'screen', 'data-screen': 'mode-select' }, [
    el('h1', { className: 'logo', text: '✈ Avioane' }),
    el('p', { className: 'tagline', text: 'Cum vrei să jucați?' }),
    el('div', { className: 'card' }, [
      el('button', {
        className: 'btn btn-primary btn-block',
        'data-action': 'local',
        text: '📱 Același telefon (pass & play)',
        onClick: () => {
          engine.phase = 'name-entry'
          engine.mode = 'local'
          engine.notify()
        },
      }),
      el('div', { style: 'height:10px' }),
      el('button', {
        className: 'btn btn-accent btn-block',
        'data-action': 'online-host',
        text: '🌐 Creează cameră online',
        onClick: () => {
          engine.mode = 'online-host'
          engine.phase = 'name-entry'
          engine.notify()
        },
      }),
      el('div', { style: 'height:10px' }),
      el('button', {
        className: 'btn btn-sky btn-block',
        'data-action': 'online-join',
        text: '🔗 Intră în cameră',
        onClick: () => {
          engine.mode = 'online-join'
          engine.phase = 'name-entry'
          engine.notify()
        },
      }),
      el('div', { style: 'height:10px' }),
      el('button', {
        className: 'btn btn-ghost btn-block',
        text: '← Înapoi',
        onClick: () => {
          engine.phase = 'menu'
          engine.notify()
        },
      }),
    ]),
  ])
}

function nameEntryScreen() {
  const isJoin = engine.mode === 'online-join'
  const isHost = engine.mode === 'online-host'
  const isLocal = engine.mode === 'local'

  const wrap = el('div', { className: 'screen', 'data-screen': 'name-entry' }, [
    el('h2', { text: isLocal ? 'Numele jucătorilor' : 'Numele tău' }),
  ])

  const card = el('div', { className: 'card' })

  const n1 = el('input', {
    type: 'text',
    id: 'name-p1',
    maxlength: '16',
    value: localNameDraft.p1,
    'aria-label': isLocal ? 'Nume jucător 1' : 'Numele tău',
  }) as HTMLInputElement
  n1.value = localNameDraft.p1

  card.appendChild(
    el('div', { className: 'field' }, [
      el('label', { for: 'name-p1', text: isLocal ? 'Jucător 1' : 'Nume' }),
      n1,
    ]),
  )

  let n2: HTMLInputElement | null = null
  if (isLocal) {
    n2 = el('input', {
      type: 'text',
      id: 'name-p2',
      maxlength: '16',
      'aria-label': 'Nume jucător 2',
    }) as HTMLInputElement
    n2.value = localNameDraft.p2
    card.appendChild(
      el('div', { className: 'field' }, [
        el('label', { for: 'name-p2', text: 'Jucător 2' }),
        n2,
      ]),
    )
  }

  let roomInput: HTMLInputElement | null = null
  if (isJoin) {
    roomInput = el('input', {
      type: 'text',
      id: 'room-code',
      maxlength: '8',
      placeholder: 'ex: K7M2P',
      'aria-label': 'Cod cameră',
      style: 'text-transform:uppercase;letter-spacing:0.15em;font-weight:700',
    }) as HTMLInputElement
    card.appendChild(
      el('div', { className: 'field' }, [
        el('label', { for: 'room-code', text: 'Cod cameră' }),
        roomInput,
      ]),
    )
  }

  card.appendChild(
    el('button', {
      className: 'btn btn-primary btn-block',
      'data-action': 'start',
      text: isLocal ? 'Începe plasarea' : isHost ? 'Creează camera' : 'Conectează-te',
      onClick: async () => {
        unlockAudio()
        localNameDraft.p1 = n1.value.trim() || 'Jucător 1'
        if (n2) localNameDraft.p2 = n2.value.trim() || 'Jucător 2'

        if (isLocal) {
          engine.setNames(localNameDraft.p1, localNameDraft.p2)
          engine.startLocal()
          return
        }

        if (isHost) {
          roomCode = generateRoomCode()
          engine.startOnlineHost(localNameDraft.p1)
          myOnlineRole = 'p1'
          try {
            session?.destroy()
            session = await hostGame(
              engine,
              localNameDraft.p1,
              roomCode,
              (s) => {
                engine.message = s
                engine.notify()
              },
              handleNet,
            )
          } catch (e) {
            engine.message = `Eroare: ${(e as Error).message}`
            engine.phase = 'name-entry'
            engine.notify()
          }
          return
        }

        // join
        const code = (roomInput?.value || '').trim().toUpperCase()
        if (code.length < 4) {
          engine.message = 'Introdu un cod valid'
          engine.notify()
          return
        }
        roomCode = code
        engine.startOnlineJoin(localNameDraft.p1)
        myOnlineRole = 'p2'
        try {
          session?.destroy()
          session = await joinGame(
            engine,
            localNameDraft.p1,
            roomCode,
            (s) => {
              engine.message = s
              engine.notify()
            },
            handleNet,
          )
        } catch (e) {
          engine.message = `Eroare: ${(e as Error).message}`
          engine.phase = 'name-entry'
          engine.notify()
        }
      },
    }),
  )

  card.appendChild(el('div', { style: 'height:8px' }))
  card.appendChild(
    el('button', {
      className: 'btn btn-ghost btn-block',
      text: '← Înapoi',
      onClick: () => {
        engine.phase = 'mode-select'
        engine.notify()
      },
    }),
  )

  wrap.appendChild(card)
  if (engine.message) {
    wrap.appendChild(el('div', { className: 'banner', text: engine.message }))
  }
  return wrap
}

function onlineLobbyScreen() {
  return el('div', { className: 'screen', 'data-screen': 'online-lobby' }, [
    el('h2', { text: engine.mode === 'online-host' ? 'Camera ta' : 'Conectare' }),
    el('div', { className: 'card' }, [
      engine.mode === 'online-host'
        ? el('div', {}, [
            el('p', { className: 'hint', text: 'Spune-i prietenului acest cod:' }),
            el('div', { className: 'room-code', 'data-room': roomCode, text: roomCode }),
            el('p', {
              className: 'hint',
              text: 'Păstrați aplicația deschisă pe ambele telefoane (necesită internet).',
            }),
          ])
        : el('p', { className: 'hint', text: `Cameră ${roomCode}…` }),
      el('div', { className: 'banner', text: engine.message || 'Așteaptă…' }),
      el('div', { style: 'height:10px' }),
      el('button', {
        className: 'btn btn-ghost btn-block',
        text: 'Anulează',
        onClick: () => {
          session?.destroy()
          session = null
          engine.backToMenu()
        },
      }),
    ]),
  ])
}

function placementScreen() {
  const me =
    engine.mode === 'local'
      ? engine.placingPlayer
      : (myOnlineRole ?? engine.placingPlayer)
  const player = engine.player(me)
  const isMyTurnToPlace =
    engine.mode === 'local' || me === engine.placingPlayer || myOnlineRole === me

  // For online, each places on their own board only
  const placeFor = engine.mode === 'local' ? engine.placingPlayer : (myOnlineRole ?? 'p1')
  const p = engine.player(placeFor)

  const screen = el('div', { className: 'screen', 'data-screen': 'placement' }, [
    el('div', { className: 'player-pill' }, [
      el('span', { className: 'dot', style: `background:${p.color}` }),
      el('span', { text: `${p.name} — plasare ${p.planes.length}/${PLANES_PER_PLAYER}` }),
    ]),
    el('div', { className: 'banner', text: engine.message }),
    boardElement({
      mode: 'own',
      playerId: placeFor,
      interactive: isMyTurnToPlace && p.planes.length < PLANES_PER_PLAYER,
      showFleet: true,
      ghost: true,
      onCell: (coord) => {
        if (!isMyTurnToPlace) return
        engine.placingPlayer = placeFor
        engine.setGhost(coord)
        if (engine.placePlane(coord)) {
          sfxPlace()
          if (engine.mode !== 'local' && engine.player(placeFor).planes.length >= PLANES_PER_PLAYER) {
            session?.send({
              type: 'placement',
              player: placeFor,
              data: engine.snapshot()[placeFor],
            })
            session?.send({ type: 'ready', player: placeFor })
            engine.markOnlineReady(placeFor)
          }
        } else {
          buzz(30)
          screenShake(document.getElementById('app'))
        }
      },
    }),
    el('div', { className: 'toolbar' }, [
      el('button', {
        className: 'btn btn-accent',
        'data-action': 'rotate',
        text: `🔄 Rotește (${engine.placeOrientation}°)`,
        onClick: () => {
          engine.rotateGhost()
          buzz(8)
        },
      }),
      el('button', {
        className: 'btn btn-sky',
        'data-action': 'auto-place',
        text: '✨ Auto',
        title: 'Plasează automat avioanele rămase',
        onClick: () => {
          engine.placingPlayer = placeFor
          if (engine.autoPlaceRemaining()) {
            sfxPlace()
            if (engine.mode !== 'local') {
              session?.send({
                type: 'placement',
                player: placeFor,
                data: engine.snapshot()[placeFor],
              })
              session?.send({ type: 'ready', player: placeFor })
              engine.markOnlineReady(placeFor)
            }
          }
        },
      }),
      el('button', {
        className: 'btn btn-ghost',
        'data-action': 'clear',
        text: 'Șterge',
        onClick: () => {
          engine.placingPlayer = placeFor
          engine.clearPlacement()
        },
      }),
    ]),
    el('p', {
      className: 'hint',
      text: 'Atinge grila ca să plasezi. Cabina (◆) e punctul vulnerabil — protejeaz-o!',
    }),
  ])

  // keep placingPlayer in sync for local
  if (engine.mode === 'local') {
    // already correct
  } else {
    engine.placingPlayer = placeFor
  }

  void player
  return screen
}

function passScreen() {
  const next = engine.player(engine.currentPlayer)
  const stillPlacing =
    engine.p1.planes.length < PLANES_PER_PLAYER || engine.p2.planes.length < PLANES_PER_PLAYER

  return el('div', { className: 'screen pass-screen', 'data-screen': 'pass-device' }, [
    el('div', { className: 'pass-icon', text: '🙈' }),
    el('h2', { text: stillPlacing ? 'Schimbați telefonul' : 'Tura următoare' }),
    el('p', {
      className: 'hint',
      text: engine.message,
    }),
    el('div', { className: 'player-pill' }, [
      el('span', { className: 'dot', style: `background:${next.color}` }),
      el('span', { text: stillPlacing ? engine.player(engine.placingPlayer === 'p1' ? 'p2' : 'p1').name || next.name : next.name }),
    ]),
    el('button', {
      className: 'btn btn-primary btn-block',
      'data-action': 'continue',
      style: 'max-width:320px',
      text: 'Sunt eu — continuă',
      onClick: () => {
        if (stillPlacing) engine.continueAfterPass()
        else engine.resumeBattleFromPass()
      },
    }),
  ])
}

function battleScreen() {
  const me =
    engine.mode === 'local' ? engine.currentPlayer : (myOnlineRole ?? engine.currentPlayer)
  const myPlayer = engine.player(me)
  const isMyTurn = engine.mode === 'local' || engine.currentPlayer === myOnlineRole

  const bannerClass =
    engine.lastShot?.kind === 'hit'
      ? 'banner hit'
      : engine.lastShot?.kind === 'sunk'
        ? 'banner sunk'
        : engine.lastShot?.kind === 'miss'
          ? 'banner miss'
          : engine.message.includes('Radar')
            ? 'banner radar'
            : 'banner'

  return el('div', { className: 'screen', 'data-screen': 'battle' }, [
    el('div', {
      style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap',
    }, [
      el('div', { className: 'player-pill' }, [
        el('span', { className: 'dot', style: `background:${engine.player(engine.currentPlayer).color}` }),
        el('span', { text: `Tura: ${engine.player(engine.currentPlayer).name}` }),
      ]),
      el('span', {
        className: 'hint',
        text: `Tur ${engine.turn} · Doborâte: ${engine.opponent(me).planesSunk}/3`,
      }),
    ]),
    el('div', { className: bannerClass, text: engine.message }),
    el('div', { className: 'boards-stack' }, [
      boardElement({
        mode: 'enemy',
        playerId: me,
        interactive: isMyTurn,
        showFleet: false,
        ghost: false,
        title: 'Țintă — grila adversarului',
        onCell: (coord, cellEl) => {
          if (!isMyTurn) return
          const result = engine.fire(coord, me)
          handleShotFx(result, cellEl)
          if (engine.mode !== 'local' && result.kind !== 'already') {
            session?.send({ type: 'shot', player: me, coord })
          }
        },
      }),
      boardElement({
        mode: 'own',
        playerId: me,
        interactive: false,
        showFleet: true,
        ghost: false,
        title: 'Flota ta',
      }),
    ]),
    el('div', { className: 'toolbar' }, [
      el('button', {
        className: 'btn btn-sky',
        'data-action': 'radar',
        disabled: myPlayer.radarUsed || !isMyTurn,
        text: myPlayer.radarUsed ? '📡 Radar folosit' : '📡 Radar (cookie)',
        onClick: () => {
          if (!isMyTurn) return
          const cells = engine.useRadar(me)
          if (cells.length) {
            sfxRadar()
            const app = document.getElementById('app')
            if (app) {
              const rect = app.getBoundingClientRect()
              glitterBurst(rect.width / 2, rect.height * 0.35, 20)
            }
          }
          if (engine.mode !== 'local') {
            session?.send({ type: 'radar', player: me })
          }
        },
      }),
    ]),
    el('div', { className: 'legend' }, [
      legendItem('#f43f5e', 'lovit'),
      legendItem('#fbbf24', 'doborât'),
      legendItem('#3b82f6', 'apă'),
      legendItem('#67e8f9', 'radar'),
      legendItem('#f472b6', 'cabina ta'),
    ]),
  ])
}

function gameOverScreen() {
  const winner = engine.winner ? engine.player(engine.winner) : null
  // fire victory once when rendering
  queueMicrotask(() => {
    sfxVictory()
    const app = document.getElementById('app')
    if (app) {
      const r = app.getBoundingClientRect()
      glitterBurst(r.width / 2, r.height * 0.25, 48)
      setTimeout(() => glitterBurst(r.width * 0.3, r.height * 0.4, 30), 200)
      setTimeout(() => glitterBurst(r.width * 0.7, r.height * 0.4, 30), 400)
    }
  })

  return el('div', { className: 'screen', 'data-screen': 'game-over' }, [
    el('div', { className: 'victory card' }, [
      el('div', { className: 'trophy', text: '🏆' }),
      el('h2', { text: winner ? `${winner.name} câștigă!` : 'Joc terminat' }),
      el('p', { className: 'hint', text: engine.message }),
      el('div', { className: 'stats' }, [
        el('div', { className: 'stat' }, [
          el('div', { className: 'n', text: String(engine.turn) }),
          el('div', { className: 'l', text: 'ture' }),
        ]),
        el('div', { className: 'stat' }, [
          el('div', { className: 'n', text: '3' }),
          el('div', { className: 'l', text: 'avioane doborâte' }),
        ]),
      ]),
      el('div', { className: 'btn-row' }, [
        el('button', {
          className: 'btn btn-primary',
          'data-action': 'rematch',
          text: '🔄 Revanșă',
          onClick: () => {
            if (engine.mode !== 'local') {
              session?.send({ type: 'rematch' })
            }
            engine.rematch()
          },
        }),
        el('button', {
          className: 'btn btn-ghost',
          'data-action': 'menu',
          text: 'Meniu',
          onClick: () => {
            session?.destroy()
            session = null
            engine.backToMenu()
          },
        }),
      ]),
    ]),
  ])
}

interface BoardOpts {
  mode: 'own' | 'enemy'
  playerId: PlayerId
  interactive: boolean
  showFleet: boolean
  ghost: boolean
  title?: string
  onCell?: (coord: Coord, cellEl: HTMLElement) => void
  onHover?: (coord: Coord) => void
}

function boardElement(opts: BoardOpts): HTMLElement {
  const wrap = el('div', { className: 'board-wrap' })
  if (opts.title) wrap.appendChild(el('div', { className: 'board-title', text: opts.title }))

  const board = el('div', {
    className: 'board',
    role: 'grid',
    'aria-label': opts.title || 'Grilă joc',
    'data-board': opts.mode,
  })

  board.appendChild(el('div', { className: 'corner' }))
  for (let c = 0; c < GRID; c++) {
    board.appendChild(el('div', { className: 'col-label', text: COLS[c] }))
  }

  const player = engine.player(opts.playerId)
  const cellNodes: HTMLElement[][] = []

  const paintGhost = (head: { r: number; c: number } | null) => {
    // clear previous ghost classes
    for (const row of cellNodes) {
      for (const node of row) {
        node.classList.remove('ghost-ok', 'ghost-bad')
      }
    }
    if (!head || !opts.ghost) return
    engine.setGhost(head)
    const cells = engine.getGhostCells()
    const ok = engine.isGhostValid()
    for (const g of cells) {
      if (g.r >= 0 && g.r < GRID && g.c >= 0 && g.c < GRID) {
        cellNodes[g.r][g.c].classList.add(ok ? 'ghost-ok' : 'ghost-bad')
      }
    }
  }

  for (let r = 0; r < GRID; r++) {
    board.appendChild(el('div', { className: 'row-label', text: String(r + 1) }))
    cellNodes[r] = []
    for (let c = 0; c < GRID; c++) {
      let state: string
      if (opts.mode === 'own') {
        state = engine.cellDisplayOwn(player, r, c)
      } else {
        state = engine.cellDisplayEnemy(player, r, c)
      }

      const classes = ['cell', state]
      if (!opts.interactive) classes.push('disabled')
      if (opts.mode === 'enemy' && opts.interactive) classes.push('enemy-target')

      const cell = el('div', {
        className: classes.join(' '),
        role: 'gridcell',
        'data-r': String(r),
        'data-c': String(c),
        'aria-label': `${COLS[c]}${r + 1}`,
      })
      cellNodes[r][c] = cell

      if (opts.interactive || opts.ghost) {
        cell.addEventListener('pointerenter', () => {
          if (opts.ghost) paintGhost({ r, c })
          opts.onHover?.({ r, c })
        })
        cell.addEventListener('click', () => {
          opts.onCell?.({ r, c }, cell)
        })
      }

      board.appendChild(cell)
    }
  }

  if (opts.ghost) {
    board.addEventListener('pointerleave', () => paintGhost(null))
  }

  wrap.appendChild(board)
  return wrap
}

function handleShotFx(result: ShotResult, cellEl: HTMLElement) {
  const rect = cellEl.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2

  if (result.kind === 'miss') {
    sfxMiss()
  } else if (result.kind === 'hit') {
    sfxHit()
    glitterBurst(x, y, 14)
  } else if (result.kind === 'sunk') {
    sfxSunk()
    glitterBurst(x, y, 36)
    screenShake(document.getElementById('app'))
  }
}

function handleNet(msg: NetMessage) {
  switch (msg.type) {
    case 'hello':
    case 'hello-ack':
      engine.notify()
      break
    case 'placement': {
      engine.applyRemotePlacement(msg.player, msg.data)
      break
    }
    case 'ready': {
      engine.markOnlineReady(msg.player)
      break
    }
    case 'shot': {
      // apply shot from remote as that player
      if (msg.player !== myOnlineRole) {
        const result = engine.fire(msg.coord, msg.player)
        if (result.kind === 'sunk' || result.kind === 'hit') {
          const app = document.getElementById('app')
          if (app) {
            const r = app.getBoundingClientRect()
            glitterBurst(r.width / 2, r.height / 2, result.kind === 'sunk' ? 30 : 12)
          }
        }
        if (result.kind === 'sunk') sfxSunk()
        else if (result.kind === 'hit') sfxHit()
        else if (result.kind === 'miss') sfxMiss()
      }
      break
    }
    case 'radar': {
      if (msg.player !== myOnlineRole) {
        engine.useRadar(msg.player)
        sfxRadar()
      }
      break
    }
    case 'rematch': {
      engine.rematch()
      break
    }
    case 'sync': {
      engine.loadSnapshot(msg.snapshot)
      break
    }
    default:
      break
  }
}

