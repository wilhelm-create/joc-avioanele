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
import { GameSocket, type RoomInfo, type ServerMessage } from '../multiplayer/socket'
import {
  fetchLeaderboard,
  fetchMe,
  login,
  register,
  reportMatch,
} from '../api/client'
import { clearSession, getStoredUser, getToken } from '../auth/session'
import type { PublicUser } from '../auth/types'

type UiPhase =
  | 'boot'
  | 'auth'
  | 'home'
  | 'mode-select'
  | 'local-names'
  | 'online-lobby'
  | 'placement'
  | 'pass-device'
  | 'battle'
  | 'game-over'
  | 'leaderboard'

const engine = new GameEngine()
const socket = new GameSocket()

let uiPhase: UiPhase = 'boot'
let currentUser: PublicUser | null = null
let authMode: 'login' | 'register' = 'login'
let authError = ''
let authBusy = false
let authUserDraft = ''
let authPassDraft = ''
let roomCode = ''
let roomInfo: RoomInfo | null = null
let myOnlineRole: PlayerId | null = null
let friendNameDraft = 'Prietenul'
let statusNote = ''
let leaders: PublicUser[] = []
let matchReported = false
let rootEl: HTMLElement | null = null

function paint() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  rootEl.appendChild(view())
}

export async function mountApp(root: HTMLElement) {
  rootEl = root
  document.body.classList.add('site-body')

  const stars = document.createElement('div')
  stars.className = 'stars'
  stars.setAttribute('aria-hidden', 'true')
  document.body.prepend(stars)

  const fx = document.createElement('div')
  fx.id = 'fx-layer'
  document.body.appendChild(fx)

  engine.onChange(() => {
    // map engine phases into ui when in-game
    if (
      uiPhase === 'placement' ||
      uiPhase === 'pass-device' ||
      uiPhase === 'battle' ||
      uiPhase === 'game-over' ||
      uiPhase === 'online-lobby'
    ) {
      if (engine.phase === 'placement') uiPhase = 'placement'
      else if (engine.phase === 'pass-device') uiPhase = 'pass-device'
      else if (engine.phase === 'battle') uiPhase = 'battle'
      else if (engine.phase === 'game-over') {
        uiPhase = 'game-over'
        void maybeReportMatch()
      } else if (engine.phase === 'online-lobby') uiPhase = 'online-lobby'
    }
    paint()
  })

  socket.onMessage(handleServer)

  const unlock = () => {
    unlockAudio()
    window.removeEventListener('pointerdown', unlock)
  }
  window.addEventListener('pointerdown', unlock)

  uiPhase = 'boot'
  paint()

  if (getToken()) {
    currentUser = (await fetchMe()) || getStoredUser()
  } else {
    currentUser = null
  }
  uiPhase = currentUser ? 'home' : 'auth'
  paint()
}

async function maybeReportMatch() {
  if (matchReported || !engine.winner || !currentUser) return
  if (engine.mode === 'local') return
  const winnerId =
    engine.winner === 'p1'
      ? roomInfo?.players.find((p) => p.role === 'p1')?.userId
      : roomInfo?.players.find((p) => p.role === 'p2')?.userId
  const loserId =
    engine.winner === 'p1'
      ? roomInfo?.players.find((p) => p.role === 'p2')?.userId
      : roomInfo?.players.find((p) => p.role === 'p1')?.userId
  if (!winnerId || !loserId) return
  matchReported = true
  try {
    await reportMatch(winnerId, loserId)
    currentUser = (await fetchMe()) || currentUser
  } catch {
    /* non-blocking */
  }
}

function handleServer(msg: ServerMessage) {
  switch (msg.type) {
    case 'room':
      roomInfo = msg.room
      roomCode = msg.room.code
      if (msg.role) myOnlineRole = msg.role
      else if (currentUser) {
        const me = msg.room.players.find((p) => p.userId === currentUser!.id)
        if (me) myOnlineRole = me.role
      }
      statusNote = `Cameră ${roomCode} · ${msg.room.players.length}/2 jucători`
      if (msg.room.players.length < 2) uiPhase = 'online-lobby'
      paint()
      break
    case 'both-joined':
      roomInfo = msg.room
      statusNote = 'Amândoi sunteți în cameră — plasați avioanele!'
      engine.mode = myOnlineRole === 'p1' ? 'online-host' : 'online-join'
      if (roomInfo) {
        const p1 = roomInfo.players.find((p) => p.role === 'p1')
        const p2 = roomInfo.players.find((p) => p.role === 'p2')
        if (p1) engine.p1.name = p1.username
        if (p2) engine.p2.name = p2.username
      }
      engine.beginOnlinePlacement()
      uiPhase = 'placement'
      paint()
      break
    case 'ready':
      roomInfo = msg.room
      statusNote = 'Un jucător e gata…'
      paint()
      break
    case 'start-battle':
      engine.phase = 'battle'
      engine.currentPlayer = 'p1'
      engine.turn = 1
      engine.message = `Bătălia începe! Atacă ${engine.p1.name}`
      uiPhase = 'battle'
      engine.notify()
      break
    case 'placement':
      if (msg.player !== myOnlineRole) {
        engine.applyRemotePlacement(msg.player, msg.data)
      }
      break
    case 'shot':
      if (msg.player !== myOnlineRole) {
        const result = engine.fire(msg.coord, msg.player)
        playShotFx(result)
      }
      break
    case 'radar':
      if (msg.player !== myOnlineRole) {
        engine.useRadar(msg.player)
        sfxRadar()
      }
      break
    case 'rematch':
      matchReported = false
      engine.rematch()
      uiPhase = 'placement'
      paint()
      break
    case 'peer-left':
      statusNote = 'Adversarul a părăsit camera'
      paint()
      break
    case 'error':
      statusNote = msg.error
      authError = msg.error
      paint()
      break
    default:
      break
  }
}

function view(): HTMLElement {
  switch (uiPhase) {
    case 'boot':
      return shell(el('div', { className: 'screen center' }, [el('p', { className: 'hint', text: 'Se încarcă…' })]))
    case 'auth':
      return shell(authScreen())
    case 'home':
      return shell(homeScreen())
    case 'mode-select':
      return shell(modeSelectScreen())
    case 'local-names':
      return shell(localNamesScreen())
    case 'online-lobby':
      return shell(onlineLobbyScreen())
    case 'placement':
      return shell(placementScreen())
    case 'pass-device':
      return shell(passScreen())
    case 'battle':
      return shell(battleScreen())
    case 'game-over':
      return shell(gameOverScreen())
    case 'leaderboard':
      return shell(leaderboardScreen())
    default:
      return shell(homeScreen())
  }
}

function shell(content: HTMLElement): HTMLElement {
  const page = el('div', { className: 'page' })
  page.appendChild(siteHeader())
  const main = el('main', { className: 'main', id: 'main' })
  main.appendChild(content)
  page.appendChild(main)
  page.appendChild(siteFooter())
  return page
}

function siteHeader(): HTMLElement {
  const header = el('header', { className: 'site-header' })
  const brand = el('button', {
    className: 'brand',
    type: 'button',
    onClick: () => {
      if (currentUser) {
        uiPhase = 'home'
        paint()
      }
    },
  }, [el('span', { className: 'brand-mark', text: '✈' }), el('span', { text: 'Avioane' })])

  const right = el('div', { className: 'header-actions' })
  if (currentUser) {
    right.appendChild(
      el('span', {
        className: 'user-chip',
        text: `${currentUser.username} · ${currentUser.wins}W`,
        title: 'Contul tău',
      }),
    )
    right.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-sm',
        text: 'Clasament',
        onClick: async () => {
          leaders = await fetchLeaderboard().catch(() => [])
          uiPhase = 'leaderboard'
          paint()
        },
      }),
    )
    right.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-sm',
        text: 'Ieșire',
        'data-action': 'logout',
        onClick: () => {
          socket.close()
          clearSession()
          currentUser = null
          uiPhase = 'auth'
          paint()
        },
      }),
    )
  }
  header.append(brand, right)
  return header
}

function siteFooter(): HTMLElement {
  return el('footer', { className: 'site-footer' }, [
    el('span', { text: 'Site web · joacă din browser pe telefon, tabletă sau desktop' }),
  ])
}

function authScreen(): HTMLElement {
  const title = authMode === 'login' ? 'Autentificare' : 'Creează cont'
  const screen = el('div', { className: 'screen auth-screen', 'data-screen': 'auth' }, [
    el('h1', { className: 'logo', text: '✈ Avioane' }),
    el('p', {
      className: 'tagline',
      text: 'Site de joc multiplayer. Creează un cont ca să joci cu prietenii pe orice device.',
    }),
    el('div', { className: 'card auth-card' }, [
      el('h2', { text: title }),
      el('div', { className: 'tabs' }, [
        el('button', {
          className: `tab ${authMode === 'login' ? 'active' : ''}`,
          type: 'button',
          'data-action': 'tab-login',
          text: 'Intră în cont',
          onClick: () => {
            authMode = 'login'
            authError = ''
            paint()
          },
        }),
        el('button', {
          className: `tab ${authMode === 'register' ? 'active' : ''}`,
          type: 'button',
          'data-action': 'tab-register',
          text: 'Cont nou',
          onClick: () => {
            authMode = 'register'
            authError = ''
            paint()
          },
        }),
      ]),
    ]),
  ])

  const card = screen.querySelector('.auth-card') as HTMLElement
  const userInput = el('input', {
    type: 'text',
    id: 'auth-user',
    autocomplete: authMode === 'login' ? 'username' : 'nickname',
    maxlength: '20',
    placeholder: 'username',
    'aria-label': 'Username',
  }) as HTMLInputElement
  userInput.value = authUserDraft
  userInput.addEventListener('input', () => {
    authUserDraft = userInput.value
  })
  const passInput = el('input', {
    type: 'password',
    id: 'auth-pass',
    autocomplete: authMode === 'login' ? 'current-password' : 'new-password',
    maxlength: '64',
    placeholder: 'parolă (min. 6)',
    'aria-label': 'Parolă',
  }) as HTMLInputElement
  passInput.value = authPassDraft
  passInput.addEventListener('input', () => {
    authPassDraft = passInput.value
  })

  card.append(
    el('div', { className: 'field' }, [el('label', { for: 'auth-user', text: 'Username' }), userInput]),
    el('div', { className: 'field' }, [el('label', { for: 'auth-pass', text: 'Parolă' }), passInput]),
  )

  if (authError) card.appendChild(el('div', { className: 'banner hit', text: authError }))

  card.appendChild(
    el('button', {
      className: 'btn btn-primary btn-block',
      type: 'button',
      'data-action': 'auth-submit',
      disabled: authBusy,
      text: authBusy ? 'Se procesează…' : authMode === 'login' ? 'Intră' : 'Înregistrează-te',
      onClick: async () => {
        authUserDraft = userInput.value
        authPassDraft = passInput.value
        authBusy = true
        authError = ''
        paint()
        try {
          const res =
            authMode === 'login'
              ? await login(authUserDraft.trim(), authPassDraft)
              : await register(authUserDraft.trim(), authPassDraft)
          currentUser = res.user
          authBusy = false
          authPassDraft = ''
          uiPhase = 'home'
          paint()
        } catch (e) {
          authBusy = false
          authError = (e as Error).message
          paint()
        }
      },
    }),
  )

  card.appendChild(
    el('p', {
      className: 'hint',
      text: 'Compatibil cu telefon, tabletă și desktop. Nu e nevoie de instalare.',
    }),
  )

  return screen
}

function homeScreen(): HTMLElement {
  const u = currentUser!
  return el('div', { className: 'screen', 'data-screen': 'home' }, [
    el('h1', { className: 'logo', text: '✈ Avioane' }),
    el('p', { className: 'tagline', text: `Salut, ${u.username}! Alege cum vrei să joci.` }),
    el('div', { className: 'stats-row' }, [
      statCard(String(u.wins), 'victorii'),
      statCard(String(u.losses), 'înfrângeri'),
      statCard(String(u.gamesPlayed), 'meciuri'),
    ]),
    el('div', { className: 'card' }, [
      el('button', {
        className: 'btn btn-primary btn-block',
        'data-action': 'play',
        text: 'Joacă acum',
        onClick: () => {
          uiPhase = 'mode-select'
          paint()
        },
      }),
      el('div', { style: 'height:10px' }),
      el('button', {
        className: 'btn btn-ghost btn-block',
        text: 'Clasament',
        onClick: async () => {
          leaders = await fetchLeaderboard().catch(() => [])
          uiPhase = 'leaderboard'
          paint()
        },
      }),
    ]),
    el('div', { className: 'cookie-bar' }, [
      el('span', { className: 'cookie-chip', text: '🍪 Radar o dată / joc' }),
      el('span', { className: 'cookie-chip', text: '🍪 Glitter burst' }),
      el('span', { className: 'cookie-chip', text: '🍪 Fanfară victorie' }),
    ]),
    el('div', { className: 'legend' }, [
      legendItem('#a78bfa', 'avion'),
      legendItem('#f472b6', 'cabină'),
      legendItem('#f43f5e', 'lovit'),
      legendItem('#fbbf24', 'doborât'),
      legendItem('#3b82f6', 'apă'),
    ]),
  ])
}

function statCard(n: string, l: string) {
  return el('div', { className: 'stat' }, [
    el('div', { className: 'n', text: n }),
    el('div', { className: 'l', text: l }),
  ])
}

function legendItem(color: string, label: string) {
  return el('span', {}, [el('i', { className: 'swatch', style: `background:${color}` }), label])
}

function modeSelectScreen(): HTMLElement {
  return el('div', { className: 'screen', 'data-screen': 'mode-select' }, [
    el('h2', { text: 'Mod de joc' }),
    el('div', { className: 'card grid-actions' }, [
      el('button', {
        className: 'btn btn-primary btn-block',
        'data-action': 'local',
        text: '📱 Același device (pass & play)',
        onClick: () => {
          uiPhase = 'local-names'
          paint()
        },
      }),
      el('button', {
        className: 'btn btn-accent btn-block',
        'data-action': 'online-host',
        text: '🌐 Creează cameră online',
        onClick: () => void startOnlineHost(),
      }),
      el('button', {
        className: 'btn btn-sky btn-block',
        'data-action': 'online-join',
        text: '🔗 Intră în cameră (cod)',
        onClick: () => {
          uiPhase = 'online-lobby'
          roomCode = ''
          statusNote = 'Introdu codul camerei prietenului'
          paint()
        },
      }),
      el('button', {
        className: 'btn btn-ghost btn-block',
        text: '← Înapoi',
        onClick: () => {
          uiPhase = 'home'
          paint()
        },
      }),
    ]),
  ])
}

function localNamesScreen(): HTMLElement {
  const friend = el('input', {
    type: 'text',
    id: 'friend-name',
    maxlength: '16',
    value: friendNameDraft,
    'aria-label': 'Numele prietenului',
  }) as HTMLInputElement
  friend.value = friendNameDraft

  return el('div', { className: 'screen', 'data-screen': 'local-names' }, [
    el('h2', { text: 'Pass & play' }),
    el('div', { className: 'card' }, [
      el('p', {
        className: 'hint',
        text: `Tu ești ${currentUser!.username}. Cum îl cheamă pe prietenul de lângă tine?`,
      }),
      el('div', { className: 'field' }, [
        el('label', { for: 'friend-name', text: 'Nume prieten' }),
        friend,
      ]),
      el('button', {
        className: 'btn btn-primary btn-block',
        'data-action': 'start-local',
        text: 'Începe plasarea',
        onClick: () => {
          friendNameDraft = friend.value.trim() || 'Prietenul'
          engine.setNames(currentUser!.username, friendNameDraft)
          engine.startLocal()
          uiPhase = 'placement'
          paint()
        },
      }),
      el('div', { style: 'height:8px' }),
      el('button', {
        className: 'btn btn-ghost btn-block',
        text: '← Înapoi',
        onClick: () => {
          uiPhase = 'mode-select'
          paint()
        },
      }),
    ]),
  ])
}

async function startOnlineHost() {
  statusNote = 'Se creează camera…'
  uiPhase = 'online-lobby'
  paint()
  try {
    await socket.connect()
    socket.send({ type: 'create-room' })
    engine.mode = 'online-host'
    engine.phase = 'online-lobby'
    myOnlineRole = 'p1'
  } catch (e) {
    statusNote = (e as Error).message
    paint()
  }
}

function onlineLobbyScreen(): HTMLElement {
  const isJoinForm = !roomInfo && engine.mode !== 'online-host'

  const card = el('div', { className: 'card' })

  if (roomInfo && roomCode) {
    card.append(
      el('p', { className: 'hint', text: 'Trimite codul prietenului (are nevoie de cont pe site):' }),
      el('div', { className: 'room-code', 'data-room': roomCode, text: roomCode }),
      el('ul', { className: 'player-list' }, [
        ...roomInfo.players.map((p) =>
          el('li', {
            text: `${p.role === 'p1' ? '①' : '②'} ${p.username}${p.ready ? ' ✓' : ''}`,
          }),
        ),
      ]),
    )
  } else if (isJoinForm || (!roomCode && statusNote.includes('cod'))) {
    const codeInput = el('input', {
      type: 'text',
      id: 'join-code',
      maxlength: '8',
      placeholder: 'ex: K7M2P',
      'aria-label': 'Cod cameră',
      style: 'text-transform:uppercase;letter-spacing:0.15em;font-weight:700',
    }) as HTMLInputElement
    card.append(
      el('div', { className: 'field' }, [el('label', { for: 'join-code', text: 'Cod cameră' }), codeInput]),
      el('button', {
        className: 'btn btn-sky btn-block',
        'data-action': 'join-room',
        text: 'Conectează-te',
        onClick: async () => {
          const code = codeInput.value.trim().toUpperCase()
          if (code.length < 4) {
            statusNote = 'Cod invalid'
            paint()
            return
          }
          statusNote = 'Conectare…'
          paint()
          try {
            await socket.connect()
            engine.mode = 'online-join'
            myOnlineRole = 'p2'
            socket.send({ type: 'join-room', code })
          } catch (e) {
            statusNote = (e as Error).message
            paint()
          }
        },
      }),
    )
  }

  if (statusNote) card.appendChild(el('div', { className: 'banner', text: statusNote }))

  card.appendChild(
    el('button', {
      className: 'btn btn-ghost btn-block',
      style: 'margin-top:10px',
      text: 'Anulează',
      onClick: () => {
        socket.send({ type: 'leave-room' })
        socket.close()
        roomInfo = null
        roomCode = ''
        uiPhase = 'mode-select'
        paint()
      },
    }),
  )

  return el('div', { className: 'screen', 'data-screen': 'online-lobby' }, [
    el('h2', { text: roomInfo ? 'Lobby cameră' : 'Intră în cameră' }),
    card,
  ])
}

function placementScreen(): HTMLElement {
  const placeFor =
    engine.mode === 'local' ? engine.placingPlayer : (myOnlineRole ?? engine.placingPlayer)
  const p = engine.player(placeFor)
  const isMyTurnToPlace = engine.mode === 'local' || myOnlineRole === placeFor

  return el('div', { className: 'screen', 'data-screen': 'placement' }, [
    el('div', { className: 'player-pill' }, [
      el('span', { className: 'dot', style: `background:${p.color}` }),
      el('span', { text: `${p.name} — plasare ${p.planes.length}/${PLANES_PER_PLAYER}` }),
    ]),
    el('div', { className: 'banner', text: engine.message || statusNote }),
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
            socket.send({
              type: 'placement',
              player: placeFor,
              data: engine.snapshot()[placeFor],
            })
            socket.send({ type: 'ready' })
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
        onClick: () => {
          engine.placingPlayer = placeFor
          if (engine.autoPlaceRemaining()) {
            sfxPlace()
            if (engine.mode !== 'local' && engine.player(placeFor).planes.length >= PLANES_PER_PLAYER) {
              socket.send({
                type: 'placement',
                player: placeFor,
                data: engine.snapshot()[placeFor],
              })
              socket.send({ type: 'ready' })
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
      text: 'Atinge grila ca să plasezi. Cabina (◆) e punctul vulnerabil.',
    }),
  ])
}

function passScreen(): HTMLElement {
  const next = engine.player(engine.currentPlayer)
  const stillPlacing =
    engine.p1.planes.length < PLANES_PER_PLAYER || engine.p2.planes.length < PLANES_PER_PLAYER

  return el('div', { className: 'screen pass-screen', 'data-screen': 'pass-device' }, [
    el('div', { className: 'pass-icon', text: '🙈' }),
    el('h2', { text: stillPlacing ? 'Schimbați device-ul' : 'Tura următoare' }),
    el('p', { className: 'hint', text: engine.message }),
    el('div', { className: 'player-pill' }, [
      el('span', { className: 'dot', style: `background:${next.color}` }),
      el('span', {
        text: stillPlacing
          ? engine.player(engine.placingPlayer === 'p1' ? 'p2' : 'p1').name
          : next.name,
      }),
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

function battleScreen(): HTMLElement {
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
    el('div', { className: 'battle-top' }, [
      el('div', { className: 'player-pill' }, [
        el('span', {
          className: 'dot',
          style: `background:${engine.player(engine.currentPlayer).color}`,
        }),
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
          playShotFx(result, cellEl)
          if (engine.mode !== 'local' && result.kind !== 'already') {
            socket.send({ type: 'shot', player: me, coord })
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
          if (engine.mode !== 'local') socket.send({ type: 'radar', player: me })
        },
      }),
    ]),
  ])
}

function gameOverScreen(): HTMLElement {
  const winner = engine.winner ? engine.player(engine.winner) : null
  queueMicrotask(() => {
    sfxVictory()
    const app = document.getElementById('app')
    if (app) {
      const r = app.getBoundingClientRect()
      glitterBurst(r.width / 2, r.height * 0.25, 48)
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
            matchReported = false
            if (engine.mode !== 'local') socket.send({ type: 'rematch' })
            engine.rematch()
            uiPhase = 'placement'
            paint()
          },
        }),
        el('button', {
          className: 'btn btn-ghost',
          'data-action': 'menu',
          text: 'Acasă',
          onClick: () => {
            socket.send({ type: 'leave-room' })
            socket.close()
            roomInfo = null
            uiPhase = 'home'
            engine.backToMenu()
            paint()
          },
        }),
      ]),
    ]),
  ])
}

function leaderboardScreen(): HTMLElement {
  return el('div', { className: 'screen', 'data-screen': 'leaderboard' }, [
    el('h2', { text: 'Clasament' }),
    el('div', { className: 'card' }, [
      leaders.length === 0
        ? el('p', { className: 'hint', text: 'Încă nu sunt jucători pe clasament.' })
        : el('ol', { className: 'leader-list' }, [
            ...leaders.map((u, i) =>
              el('li', {
                className: currentUser?.id === u.id ? 'me' : '',
                text: `${i + 1}. ${u.username} — ${u.wins}W / ${u.losses}L (${u.gamesPlayed} jocuri)`,
              }),
            ),
          ]),
      el('button', {
        className: 'btn btn-ghost btn-block',
        style: 'margin-top:12px',
        text: '← Înapoi',
        onClick: () => {
          uiPhase = 'home'
          paint()
        },
      }),
    ]),
  ])
}

/* ——— shared UI helpers ——— */

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
    else if (k === 'type' && tag === 'button') (node as HTMLButtonElement).type = v as 'button'
    else node.setAttribute(k, String(v))
  }
  for (const c of children) {
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

interface BoardOpts {
  mode: 'own' | 'enemy'
  playerId: PlayerId
  interactive: boolean
  showFleet: boolean
  ghost: boolean
  title?: string
  onCell?: (coord: Coord, cellEl: HTMLElement) => void
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
    for (const row of cellNodes) {
      for (const node of row) node.classList.remove('ghost-ok', 'ghost-bad')
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
      const state =
        opts.mode === 'own'
          ? engine.cellDisplayOwn(player, r, c)
          : engine.cellDisplayEnemy(player, r, c)

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
        })
        cell.addEventListener('click', () => opts.onCell?.({ r, c }, cell))
      }
      board.appendChild(cell)
    }
  }

  if (opts.ghost) board.addEventListener('pointerleave', () => paintGhost(null))
  wrap.appendChild(board)
  return wrap
}

function playShotFx(result: ShotResult, cellEl?: HTMLElement) {
  let x = window.innerWidth / 2
  let y = window.innerHeight / 2
  if (cellEl) {
    const rect = cellEl.getBoundingClientRect()
    x = rect.left + rect.width / 2
    y = rect.top + rect.height / 2
  }
  if (result.kind === 'miss') sfxMiss()
  else if (result.kind === 'hit') {
    sfxHit()
    glitterBurst(x, y, 14)
  } else if (result.kind === 'sunk') {
    sfxSunk()
    glitterBurst(x, y, 36)
    screenShake(document.getElementById('app'))
  }
}
