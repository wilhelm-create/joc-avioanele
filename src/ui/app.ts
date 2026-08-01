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
import {
  buildInviteText,
  buildInviteUrl,
  clearInviteFromUrl,
  getInviteCodeFromLocation,
  openShareEmail,
  openShareSms,
  openShareWhatsApp,
  openSystemShare,
} from '../invite/url'
import { getLang, onLangChange, setLang, t } from '../i18n'
import { getTheme, onThemeChange, setTheme } from '../theme'
import type { Theme } from '../theme'

type UiPhase =
  | 'boot'
  | 'auth'
  | 'home'
  | 'online-lobby'
  | 'placement'
  | 'waiting-opponent'
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
let statusNote = ''
let leaders: PublicUser[] = []
let matchReported = false
let rootEl: HTMLElement | null = null
/** Pending invite from deep link — join after login */
let pendingInviteCode: string | null = null
let copyLinkNote = ''

function paint() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  rootEl.appendChild(view())
}

export async function mountApp(root: HTMLElement) {
  rootEl = root
  document.body.classList.add('site-body', 'app-shell')
  onLangChange(() => paint())
  onThemeChange(() => paint())

  // liquid ambient blob (third blob; ::before/::after are the other two)
  if (!document.querySelector('.ambient-blob')) {
    const blob = document.createElement('div')
    blob.className = 'ambient-blob'
    blob.setAttribute('aria-hidden', 'true')
    document.body.prepend(blob)
  }

  const fx = document.createElement('div')
  fx.id = 'fx-layer'
  document.body.appendChild(fx)

  engine.onChange(() => {
    if (
      uiPhase === 'placement' ||
      uiPhase === 'waiting-opponent' ||
      uiPhase === 'battle' ||
      uiPhase === 'game-over' ||
      uiPhase === 'online-lobby'
    ) {
      if (engine.phase === 'placement') uiPhase = 'placement'
      else if (engine.phase === 'battle') uiPhase = 'battle'
      else if (engine.phase === 'game-over') {
        uiPhase = 'game-over'
        void maybeReportMatch()
      } else if (engine.phase === 'online-lobby') uiPhase = 'online-lobby'
    }
    // In battle, update cells/banner in-place — no full DOM wipe (no visible flash)
    if (uiPhase === 'battle' && engine.phase === 'battle') {
      softRefreshBattle()
      return
    }
    paint()
  })

  socket.onMessage(handleServer)

  const unlock = () => {
    unlockAudio()
    window.removeEventListener('pointerdown', unlock)
  }
  window.addEventListener('pointerdown', unlock)

  pendingInviteCode = getInviteCodeFromLocation()

  uiPhase = 'boot'
  paint()

  if (getToken()) {
    currentUser = (await fetchMe()) || getStoredUser()
  } else {
    currentUser = null
  }

  if (currentUser && pendingInviteCode) {
    await acceptPendingInvite()
  } else {
    uiPhase = currentUser ? 'home' : 'auth'
    paint()
  }
}

function mapRoomError(msg: string): string {
  const m = msg.trim()
  if (m === 'ROOM_NOT_FOUND' || /nu există|does not exist/i.test(m)) return t('roomNotFound')
  if (m === 'ROOM_FULL' || /plină|full/i.test(m)) return t('roomFull')
  if (m === 'NOT_IN_ROOM') return t('notInRoom')
  if (m === 'ROOM_SAVE_FAILED') return t('roomSaveFailed')
  return msg
}

async function acceptPendingInvite(retries = 4) {
  const code = (pendingInviteCode || '').toUpperCase().trim()
  if (!code || !currentUser) return
  pendingInviteCode = code
  statusNote = t('connectingRoom', { code })
  uiPhase = 'online-lobby'
  paint()
  try {
    await socket.connect()
    engine.mode = 'online-join'
    myOnlineRole = 'p2'
    roomCode = code
    await joinRoomHttp(code)
    clearInviteFromUrl()
    pendingInviteCode = null
  } catch (e) {
    const raw = (e as Error).message
    if (retries > 0 && /ROOM_NOT_FOUND|nu există/i.test(raw)) {
      await new Promise((r) => setTimeout(r, 600))
      return acceptPendingInvite(retries - 1)
    }
    statusNote = mapRoomError(raw)
    paint()
  }
}

async function joinRoomHttp(code: string) {
  const token = getToken()
  const res = await fetch('/api/rooms/join', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ code }),
  })
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    room?: RoomInfo
    role?: PlayerId
  }
  if (!res.ok) throw new Error(data.error || `Eroare ${res.status}`)
  if (data.room) {
    roomInfo = data.room
    roomCode = data.room.code
    if (data.role) myOnlineRole = data.role
    // drive UI the same way socket join would
    if (data.room.players.length >= 2) {
      // both-joined path
      statusNote = t('friendJoined')
      engine.mode = myOnlineRole === 'p1' ? 'online-host' : 'online-join'
      const p1 = data.room.players.find((p) => p.role === 'p1')
      const p2 = data.room.players.find((p) => p.role === 'p2')
      if (p1) engine.p1.name = p1.username
      if (p2) engine.p2.name = p2.username
      engine.beginOnlinePlacement()
      uiPhase = 'placement'
    } else {
      statusNote = t('roomReadyInvite')
      uiPhase = 'online-lobby'
    }
    paint()
  }
}

async function maybeReportMatch() {
  if (matchReported || !engine.winner || !currentUser) return
  if (engine.mode === 'local') return // local mode kept only for offline tests
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
      statusNote =
        msg.room.players.length < 2
          ? t('roomReadyInvite')
          : t('roomBothConnected', { code: roomCode })
      if (msg.room.players.length < 2 && uiPhase !== 'placement' && uiPhase !== 'battle') {
        uiPhase = 'online-lobby'
      }
      paint()
      break
    case 'both-joined':
      roomInfo = msg.room
      statusNote = t('friendJoined')
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
      statusNote = t('opponentFleetReady')
      if (engine.phase === 'placement') {
        // stay on placement or waiting
        const me = myOnlineRole ?? 'p1'
        if (engine.player(me).planes.length >= PLANES_PER_PLAYER) {
          uiPhase = 'waiting-opponent'
        }
      }
      paint()
      break
    case 'start-battle':
      engine.phase = 'battle'
      engine.currentPlayer = 'p1'
      engine.turn = 1
      engine.message =
        myOnlineRole === 'p1'
          ? t('battleStartYou')
          : t('battleStartWait', { name: engine.p1.name })
      uiPhase = 'battle'
      socket.setFastPoll(true)
      paint()
      break
    case 'placement':
      if (msg.player !== myOnlineRole) {
        engine.applyRemotePlacement(msg.player, msg.data)
        if (myOnlineRole) engine.markOnlineReady(myOnlineRole)
      }
      break
    case 'shot':
      // Apply remote bomb for every peer (skip only our own echo if any)
      if (msg.coord && msg.player && msg.player !== myOnlineRole) {
        const result = engine.fire(msg.coord, msg.player, { force: true, silent: true })
        if (result.kind !== 'already') {
          playShotFx(result)
          if (engine.phase === 'game-over') {
            uiPhase = 'game-over'
            paint()
            void maybeReportMatch()
          } else {
            uiPhase = 'battle'
            softRefreshBattle(msg.coord)
          }
        }
      }
      break
    case 'radar':
      if (msg.player && msg.player !== myOnlineRole) {
        engine.useRadar(msg.player)
        sfxRadar()
        if (uiPhase === 'battle') softRefreshBattle()
        else paint()
      }
      break
    case 'rematch':
      matchReported = false
      engine.rematch()
      uiPhase = 'placement'
      paint()
      break
    case 'peer-left':
      statusNote = t('peerLeft')
      if (uiPhase === 'battle' || uiPhase === 'placement') {
        /* keep state visible */
      }
      paint()
      break
    case 'error':
      statusNote = mapRoomError(msg.error)
      authError = mapRoomError(msg.error)
      paint()
      break
    default:
      break
  }
}

function view(): HTMLElement {
  switch (uiPhase) {
    case 'boot':
      return shell(el('div', { className: 'screen center' }, [el('p', { className: 'hint', text: t('loading') })]))
    case 'auth':
      return shell(authScreen())
    case 'home':
      return shell(homeScreen())
    case 'online-lobby':
      return shell(onlineLobbyScreen())
    case 'placement':
      return shell(placementScreen())
    case 'waiting-opponent':
      return shell(waitingOpponentScreen())
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

function langToggle(): HTMLElement {
  const wrap = el('div', {
    className: 'lang-toggle',
    role: 'group',
    'aria-label': t('switchLang'),
    'data-control': 'lang',
  })
  for (const lang of ['ro', 'en'] as const) {
    wrap.appendChild(
      el('button', {
        type: 'button',
        className: `lang-btn ${getLang() === lang ? 'active' : ''}`,
        text: lang === 'ro' ? t('langRo') : t('langEn'),
        'data-lang': lang,
        title: t('switchLang'),
        onClick: () => {
          setLang(lang)
          paint()
        },
      }),
    )
  }
  return wrap
}

function themeToggle(): HTMLElement {
  const theme = getTheme()
  const wrap = el('div', {
    className: 'theme-toggle',
    role: 'group',
    'aria-label': 'Theme',
    'data-control': 'theme',
  })
  const opts: { id: Theme; icon: string; label: string }[] = [
    { id: 'light', icon: '☀', label: t('themeLight') },
    { id: 'dark', icon: '☾', label: t('themeDark') },
  ]
  for (const o of opts) {
    wrap.appendChild(
      el('button', {
        type: 'button',
        className: `theme-btn ${theme === o.id ? 'active' : ''}`,
        text: o.icon,
        title: o.label,
        'aria-label': o.label,
        'data-theme-opt': o.id,
        onClick: () => {
          setTheme(o.id)
          paint()
        },
      }),
    )
  }
  return wrap
}

function siteHeader(): HTMLElement {
  const header = el('header', { className: 'site-header' })

  // Row 1: brand + theme/lang (always fits)
  const top = el('div', { className: 'header-row header-row-top' })
  const brand = el(
    'button',
    {
      className: 'brand',
      type: 'button',
      onClick: () => {
        if (currentUser) {
          uiPhase = 'home'
          paint()
        }
      },
    },
    [
      el('span', { className: 'brand-mark', text: '✈' }),
      el('span', { className: 'brand-text', text: t('appName') }),
    ],
  )
  const tools = el('div', { className: 'header-tools' })
  tools.appendChild(themeToggle())
  tools.appendChild(langToggle())
  top.append(brand, tools)
  header.appendChild(top)

  // Row 2: user identity + actions (only when logged in)
  if (currentUser) {
    const bottom = el('div', { className: 'header-row header-row-user' })
    bottom.appendChild(
      el('span', {
        className: 'user-chip',
        text: `${currentUser.username} · ${currentUser.wins}W`,
        title: t('yourAccount'),
      }),
    )
    const actions = el('div', { className: 'header-user-actions' })
    actions.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-sm',
        type: 'button',
        text: t('leaderboard'),
        onClick: async () => {
          leaders = await fetchLeaderboard().catch(() => [])
          uiPhase = 'leaderboard'
          paint()
        },
      }),
    )
    actions.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-sm',
        type: 'button',
        text: t('logout'),
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
    bottom.appendChild(actions)
    header.appendChild(bottom)
  }

  return header
}

function siteFooter(): HTMLElement {
  return el('footer', { className: 'site-footer' }, [
    el('span', { text: t('footer') }),
  ])
}

function authScreen(): HTMLElement {
  const title = authMode === 'login' ? t('authTitleLogin') : t('authTitleRegister')
  const screen = el('div', { className: 'screen auth-screen', 'data-screen': 'auth' }, [
    el('h1', { className: 'logo', text: '✈ ' + t('appName') }),
    el('p', {
      className: 'tagline',
      text: t('authTagline'),
    }),
    el('div', { className: 'card auth-card' }, [
      el('h2', { text: title }),
      el('div', { className: 'tabs' }, [
        el('button', {
          className: `tab ${authMode === 'login' ? 'active' : ''}`,
          type: 'button',
          'data-action': 'tab-login',
          text: t('tabLogin'),
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
          text: t('tabRegister'),
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
    placeholder: t('username'),
    'aria-label': t('username'),
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
    placeholder: t('passwordPlaceholder'),
    'aria-label': t('password'),
  }) as HTMLInputElement
  passInput.value = authPassDraft
  passInput.addEventListener('input', () => {
    authPassDraft = passInput.value
  })

  card.append(
    el('div', { className: 'field' }, [el('label', { for: 'auth-user', text: t('username') }), userInput]),
    el('div', { className: 'field' }, [el('label', { for: 'auth-pass', text: t('password') }), passInput]),
  )

  if (authError) card.appendChild(el('div', { className: 'banner hit', text: authError }))

  card.appendChild(
    el('button', {
      className: 'btn btn-primary btn-block',
      type: 'button',
      'data-action': 'auth-submit',
      disabled: authBusy,
      text: authBusy ? t('processing') : authMode === 'login' ? t('btnLogin') : t('btnRegister'),
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
          if (pendingInviteCode) {
            await acceptPendingInvite()
          } else {
            uiPhase = 'home'
            paint()
          }
        } catch (e) {
          authBusy = false
          authError = (e as Error).message
          paint()
        }
      },
    }),
  )

  if (pendingInviteCode) {
    card.appendChild(
      el('div', {
        className: 'banner',
        text: t('inviteBanner', { code: pendingInviteCode }),
      }),
    )
  }

  return screen
}

function homeScreen(): HTMLElement {
  const u = currentUser!
  return el('div', { className: 'screen', 'data-screen': 'home' }, [
    el('h1', { className: 'logo', text: '✈ ' + t('appName') }),
    el('p', {
      className: 'tagline',
      text: t('hello', { name: u.username }),
    }),
    el('div', { className: 'stats-row' }, [
      statCard(String(u.wins), t('wins')),
      statCard(String(u.losses), t('losses')),
      statCard(String(u.gamesPlayed), t('games')),
    ]),
    el('div', { className: 'card grid-actions' }, [
      el('button', {
        className: 'btn btn-primary btn-block',
        'data-action': 'invite',
        text: t('inviteFriend'),
        onClick: () => void startOnlineHost(),
      }),
      el('button', {
        className: 'btn btn-sky btn-block',
        'data-action': 'join-code',
        text: t('haveCode'),
        onClick: () => {
          roomInfo = null
          roomCode = ''
          engine.mode = 'online-join'
          statusNote = t('pasteCodeHint')
          uiPhase = 'online-lobby'
          paint()
        },
      }),
      el('button', {
        className: 'btn btn-ghost btn-block',
        text: t('leaderboard'),
        onClick: async () => {
          leaders = await fetchLeaderboard().catch(() => [])
          uiPhase = 'leaderboard'
          paint()
        },
      }),
    ]),
  ])
}

function statCard(n: string, l: string) {
  return el('div', { className: 'stat' }, [
    el('div', { className: 'n', text: n }),
    el('div', { className: 'l', text: l }),
  ])
}

async function startOnlineHost() {
  copyLinkNote = ''
  statusNote = t('preparingRoom')
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
  const isHostLobby = Boolean(roomInfo && roomCode && myOnlineRole === 'p1')
  const isGuestWaiting = Boolean(roomInfo && roomCode && myOnlineRole === 'p2')
  const needJoinForm = !roomInfo && engine.mode === 'online-join'

  const card = el('div', { className: 'card' })

  if (isHostLobby || isGuestWaiting) {
    const link = buildInviteUrl(roomCode)
    card.append(
      el('p', {
        className: 'hint',
        text: isHostLobby
          ? t('lobbyHostHint')
          : t('lobbyGuestHint'),
      }),
      el('div', { className: 'room-code', 'data-room': roomCode, text: roomCode }),
    )

    if (isHostLobby) {
      const inviteText = buildInviteText(roomCode, currentUser!.username)
      const linkInput = el('input', {
        type: 'text',
        id: 'invite-link',
        readonly: 'true',
        value: link,
        'aria-label': t('inviteLinkLabel'),
      }) as HTMLInputElement
      linkInput.value = link
      linkInput.readOnly = true

      card.append(
        el('div', { className: 'field' }, [
          el('label', { for: 'invite-link', text: t('inviteLinkLabel') }),
          linkInput,
        ]),
        el('button', {
          className: 'btn btn-accent btn-block',
          type: 'button',
          'data-action': 'copy-link',
          text: t('copyLink'),
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(link)
              copyLinkNote = t('linkCopied')
            } catch {
              linkInput.select()
              copyLinkNote = t('copyManual')
            }
            paint()
          },
        }),
        el('hr', { className: 'soft-hr' }),
        el('h3', { className: 'subhead', text: t('inviteShareTitle') }),
        el('p', {
          className: 'hint',
          text: t('inviteShareHint'),
        }),
        el('div', { className: 'btn-row share-row' }, [
          el('button', {
            className: 'btn btn-primary',
            type: 'button',
            'data-action': 'share-whatsapp',
            text: t('shareWhatsApp'),
            onClick: () => openShareWhatsApp(inviteText),
          }),
          el('button', {
            className: 'btn btn-sky',
            type: 'button',
            'data-action': 'share-email',
            text: t('shareEmail'),
            onClick: () => openShareEmail(t('shareTitle'), inviteText),
          }),
          el('button', {
            className: 'btn btn-accent',
            type: 'button',
            'data-action': 'share-sms',
            text: t('shareSms'),
            onClick: () => openShareSms(inviteText),
          }),
        ]),
        el('button', {
          className: 'btn btn-ghost btn-block',
          type: 'button',
          'data-action': 'share-system',
          style: 'margin-top:8px',
          text: t('share'),
          onClick: async () => {
            try {
              const shared = await openSystemShare(t('shareTitle'), inviteText, link)
              if (!shared) {
                await navigator.clipboard.writeText(inviteText)
                copyLinkNote = t('inviteTextCopied')
                paint()
              }
            } catch {
              /* cancelled */
            }
          },
        }),
      )
      if (copyLinkNote) card.appendChild(el('div', { className: 'banner', text: copyLinkNote }))
    }

    card.append(
      el('ul', { className: 'player-list' }, [
        ...roomInfo!.players.map((p) =>
          el('li', {
            text: `${p.role === 'p1' ? t('hostLabel') : t('guestLabel')}: ${p.username}${p.ready ? t('fleetReady') : t('waitingDots')}`,
          }),
        ),
      ]),
      el('div', {
        className: 'banner',
        text:
          roomInfo!.players.length < 2
            ? t('waitingFriendOpen')
            : t('bothOnline'),
      }),
    )
  } else if (needJoinForm || pendingInviteCode) {
    const codeInput = el('input', {
      type: 'text',
      id: 'join-code',
      maxlength: '8',
      placeholder: t('roomCodePlaceholder'),
      'aria-label': t('roomCode'),
      style: 'text-transform:uppercase;letter-spacing:0.15em;font-weight:700',
    }) as HTMLInputElement
    if (pendingInviteCode) codeInput.value = pendingInviteCode
    card.append(
      el('p', {
        className: 'hint',
        text: t('joinFromSms'),
      }),
      el('div', { className: 'field' }, [el('label', { for: 'join-code', text: t('roomCode') }), codeInput]),
      el('button', {
        className: 'btn btn-sky btn-block',
        'data-action': 'join-room',
        text: pendingInviteCode && statusNote ? t('joinRetry') : t('enterRoom'),
        onClick: async () => {
          const code = codeInput.value.trim().toUpperCase()
          if (code.length < 4) {
            statusNote = t('invalidCode')
            paint()
            return
          }
          pendingInviteCode = code
          await acceptPendingInvite()
        },
      }),
    )
  } else {
    card.appendChild(el('p', { className: 'hint', text: statusNote || t('lobbyLoading') }))
  }

  if (statusNote) card.appendChild(el('div', { className: 'banner hit', text: statusNote }))

  card.appendChild(
    el('button', {
      className: 'btn btn-ghost btn-block',
      style: 'margin-top:10px',
      text: t('cancelHome'),
      onClick: () => {
        socket.send({ type: 'leave-room' })
        socket.close()
        roomInfo = null
        roomCode = ''
        copyLinkNote = ''
        uiPhase = 'home'
        paint()
      },
    }),
  )

  return el('div', { className: 'screen', 'data-screen': 'online-lobby' }, [
    el('h2', { text: isHostLobby ? t('lobbyInviteTitle') : t('lobbyJoinTitle') }),
    card,
  ])
}

function waitingOpponentScreen(): HTMLElement {
  return el('div', { className: 'screen pass-screen', 'data-screen': 'waiting-opponent' }, [
    el('div', { className: 'pass-icon', text: '⏳' }),
    el('h2', { text: t('fleetDoneTitle') }),
    el('p', {
      className: 'hint',
      text: engine.message || t('fleetDoneHint'),
    }),
    el('div', { className: 'banner', text: statusNote || t('noHandoffWait') }),
  ])
}

function finishPlacementAndNotify(placeFor: PlayerId) {
  socket.send({
    type: 'placement',
    player: placeFor,
    data: engine.snapshot()[placeFor],
  })
  socket.send({ type: 'ready' })
  const started = engine.markOnlineReady(placeFor)
  if (!started) {
    uiPhase = 'waiting-opponent'
    statusNote = t('waitFriendPlace')
    paint()
  }
}

function placementScreen(): HTMLElement {
  const placeFor = myOnlineRole ?? engine.placingPlayer
  const p = engine.player(placeFor)
  const canPlace = p.planes.length < PLANES_PER_PLAYER
  // Default ghost on grid center so rotation is always visible (mobile + desktop)
  const defaultGhost: Coord = { r: Math.floor(GRID / 2), c: Math.floor(GRID / 2) }
  let stickyGhost: Coord | null = engine.ghostHead ?? (canPlace ? defaultGhost : null)
  let boardApi: BoardApi | null = null

  const screen = el('div', { className: 'screen', 'data-screen': 'placement' }, [
    el('div', { className: 'player-pill' }, [
      el('span', { className: 'dot', style: `background:${p.color}` }),
      el('span', { text: `${p.name} — ${t('yourFleet')} ${p.planes.length}/${PLANES_PER_PLAYER}` }),
    ]),
    el('div', {
      className: 'banner',
      text: engine.message || t('placeBanner'),
    }),
  ])

  const syncOrientUi = (deg: number) => {
    for (const btn of orientBtns) {
      btn.classList.toggle('active', btn.getAttribute('data-orient') === String(deg))
    }
    rotateLabel.textContent = t('rotate', { deg })
    const head = stickyGhost ?? engine.ghostHead ?? defaultGhost
    stickyGhost = head
    boardApi?.paintGhost(head)
  }

  // Orientation pad — 4 big direction buttons (primary rotate UX on mobile)
  const orientPad = el('div', {
    className: 'orient-pad',
    role: 'group',
    'aria-label': t('rotate', { deg: engine.placeOrientation }),
  })
  const orients: { o: 0 | 90 | 180 | 270; icon: string; label: string }[] = [
    { o: 0, icon: '↑', label: '0°' },
    { o: 90, icon: '→', label: '90°' },
    { o: 180, icon: '↓', label: '180°' },
    { o: 270, icon: '←', label: '270°' },
  ]
  const orientBtns: HTMLButtonElement[] = []
  for (const { o, icon, label } of orients) {
    const b = el('button', {
      type: 'button',
      className: `orient-btn ${engine.placeOrientation === o ? 'active' : ''}`,
      text: icon,
      'data-orient': String(o),
      title: label,
      'aria-label': label,
      'aria-pressed': engine.placeOrientation === o ? 'true' : 'false',
      onClick: (e: Event) => {
        e.preventDefault()
        e.stopPropagation()
        engine.setOrientation(o)
        buzz(8)
        syncOrientUi(o)
      },
    }) as HTMLButtonElement
    orientBtns.push(b)
    orientPad.appendChild(b)
  }
  screen.appendChild(orientPad)

  boardApi = boardElement({
    mode: 'own',
    playerId: placeFor,
    interactive: canPlace,
    showFleet: true,
    ghost: true,
    stickyGhost: true,
    onGhost: (c) => {
      if (c) stickyGhost = c
    },
    onCell: (coord) => {
      if (!canPlace) return
      engine.placingPlayer = placeFor
      engine.setGhost(coord)
      stickyGhost = coord
      if (engine.placePlane(coord)) {
        sfxPlace()
        stickyGhost = defaultGhost
        if (engine.player(placeFor).planes.length >= PLANES_PER_PLAYER) {
          finishPlacementAndNotify(placeFor)
        } else {
          paint() // place another plane
        }
      } else {
        buzz(30)
        screenShake(document.getElementById('app'))
        boardApi?.paintGhost(coord)
      }
    },
  })
  screen.appendChild(boardApi.wrap)

  const rotateLabel = el('button', {
    className: 'btn btn-accent',
    type: 'button',
    'data-action': 'rotate',
    text: t('rotate', { deg: engine.placeOrientation }),
    onClick: (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      engine.rotateGhost()
      buzz(8)
      syncOrientUi(engine.placeOrientation)
    },
  }) as HTMLButtonElement

  screen.appendChild(
    el('div', { className: 'toolbar' }, [
      rotateLabel,
      el('button', {
        className: 'btn btn-sky',
        'data-action': 'auto-place',
        text: t('auto'),
        onClick: () => {
          engine.placingPlayer = placeFor
          if (engine.autoPlaceRemaining()) {
            sfxPlace()
            finishPlacementAndNotify(placeFor)
          }
        },
      }),
      el('button', {
        className: 'btn btn-ghost',
        'data-action': 'clear',
        text: t('clear'),
        onClick: () => {
          engine.placingPlayer = placeFor
          engine.clearPlacement()
          stickyGhost = defaultGhost
          paint()
        },
      }),
    ]),
  )
  screen.appendChild(
    el('p', {
      className: 'hint',
      text: t('cabinHint'),
    }),
  )

  // Show ghost immediately so rotate/orient pad is meaningful before first tap
  if (canPlace && stickyGhost) {
    queueMicrotask(() => boardApi?.paintGhost(stickyGhost))
  }

  return screen
}

function battleScreen(): HTMLElement {
  const me = myOnlineRole ?? engine.currentPlayer
  const myPlayer = engine.player(me)
  const isMyTurn = engine.currentPlayer === myOnlineRole

  const bannerClass =
    engine.lastShot?.kind === 'hit'
      ? 'banner hit'
      : engine.lastShot?.kind === 'sunk'
        ? 'banner sunk'
        : engine.lastShot?.kind === 'miss'
          ? 'banner miss'
          : engine.message.includes('Radar')
            ? 'banner radar'
            : isMyTurn
              ? 'banner'
              : 'banner radar'

  const turnMsg = isMyTurn
    ? engine.message || t('yourTurnAttack')
    : t('waitPlayer', { name: engine.player(engine.currentPlayer).name })

  return el('div', { className: 'screen', 'data-screen': 'battle' }, [
    el('div', { className: 'battle-top' }, [
      el('div', { className: 'player-pill' }, [
        el('span', {
          className: 'dot',
          style: `background:${engine.player(engine.currentPlayer).color}`,
        }),
        el('span', {
          text: isMyTurn ? t('yourTurn') : t('turnOf', { name: engine.player(engine.currentPlayer).name }),
        }),
      ]),
      el('span', {
        className: 'hint',
        text: t('turnCount', { turn: engine.turn, sunk: engine.opponent(me).planesSunk }),
      }),
    ]),
    el('div', { className: bannerClass, text: turnMsg }),
    el('div', { className: 'boards-stack' }, [
      boardElement({
        mode: 'enemy',
        playerId: me,
        interactive: true, // live turn check inside onCell (soft refresh must not stale-close)
        showFleet: false,
        ghost: false,
        title: isMyTurn ? t('attackHere') : t('targetWait'),
        onCell: (coord, cellEl) => {
          // Always read live turn — softRefreshBattle must not leave stale closures
          if (engine.currentPlayer !== me || engine.phase !== 'battle') return
          const result = engine.fire(coord, me, { silent: true })
          playShotFx(result, cellEl)
          if (result.kind === 'already') return
          socket.send({ type: 'shot', player: me, coord })
          // fire() may set winner / phase; prefer winner flag (avoids TS phase narrowing)
          if (engine.winner) {
            uiPhase = 'game-over'
            paint()
            void maybeReportMatch()
          } else {
            softRefreshBattle(coord)
          }
        },
      }).wrap,
      boardElement({
        mode: 'own',
        playerId: me,
        interactive: false,
        showFleet: true,
        ghost: false,
        title: t('yourFleetBoard'),
      }).wrap,
    ]),
    el('div', { className: 'toolbar' }, [
      el('button', {
        className: 'btn btn-sky',
        'data-action': 'radar',
        disabled: myPlayer.radarUsed || !isMyTurn,
        text: myPlayer.radarUsed ? t('radarUsed') : t('radarCookie'),
        onClick: () => {
          if (engine.currentPlayer !== me || engine.phase !== 'battle') return
          const cells = engine.useRadar(me)
          if (cells.length) {
            sfxRadar()
            const app = document.getElementById('app')
            if (app) {
              const rect = app.getBoundingClientRect()
              glitterBurst(rect.width / 2, rect.height * 0.35, 20)
            }
            softRefreshBattle()
          }
          socket.send({ type: 'radar', player: me })
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
      el('h2', { text: winner ? t('winsTitle', { name: winner.name }) : t('gameOver') }),
      el('p', { className: 'hint', text: engine.message }),
      el('div', { className: 'stats' }, [
        el('div', { className: 'stat' }, [
          el('div', { className: 'n', text: String(engine.turn) }),
          el('div', { className: 'l', text: t('turns') }),
        ]),
        el('div', { className: 'stat' }, [
          el('div', { className: 'n', text: '3' }),
          el('div', { className: 'l', text: t('planesDown') }),
        ]),
      ]),
      el('div', { className: 'btn-row' }, [
        el('button', {
          className: 'btn btn-primary',
          'data-action': 'rematch',
          text: t('rematch'),
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
          text: t('home'),
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
    el('h2', { text: t('leaderboard') }),
    el('div', { className: 'card' }, [
      leaders.length === 0
        ? el('p', { className: 'hint', text: t('noLeaders') })
        : el('ol', { className: 'leader-list' }, [
            ...leaders.map((u, i) =>
              el('li', {
                className: currentUser?.id === u.id ? 'me' : '',
                text: t('leaderLine', { rank: i + 1, name: u.username, wins: u.wins, losses: u.losses, games: u.gamesPlayed }),
              }),
            ),
          ]),
      el('button', {
        className: 'btn btn-ghost btn-block',
        style: 'margin-top:12px',
        text: t('back'),
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
  /** Keep last ghost when pointer leaves (mobile-friendly rotate) */
  stickyGhost?: boolean
  title?: string
  onCell?: (coord: Coord, cellEl: HTMLElement) => void
  onGhost?: (coord: Coord | null) => void
}

interface BoardApi {
  wrap: HTMLElement
  paintGhost: (head: Coord | null) => void
  refreshCells: () => void
}

function boardElement(opts: BoardOpts): BoardApi {
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
  let lastGhost: Coord | null = null

  const paintGhost = (head: Coord | null) => {
    lastGhost = head
    for (const row of cellNodes) {
      for (const node of row) node.classList.remove('ghost-ok', 'ghost-bad')
    }
    if (!head || !opts.ghost) {
      opts.onGhost?.(head)
      return
    }
    engine.setGhost(head)
    const cells = engine.getGhostCells()
    const ok = engine.isGhostValid()
    for (const g of cells) {
      if (g.r >= 0 && g.r < GRID && g.c >= 0 && g.c < GRID) {
        cellNodes[g.r][g.c].classList.add(ok ? 'ghost-ok' : 'ghost-bad')
      }
    }
    opts.onGhost?.(head)
  }

  const refreshCells = () => {
    const pl = engine.player(opts.playerId)
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const state =
          opts.mode === 'own'
            ? engine.cellDisplayOwn(pl, r, c)
            : engine.cellDisplayEnemy(pl, r, c)
        const cell = cellNodes[r][c]
        const classes = ['cell', state]
        if (!opts.interactive) classes.push('disabled')
        if (opts.mode === 'enemy' && opts.interactive) classes.push('enemy-target')
        // preserve ghost classes if any
        if (cell.classList.contains('ghost-ok')) classes.push('ghost-ok')
        if (cell.classList.contains('ghost-bad')) classes.push('ghost-bad')
        cell.className = classes.join(' ')
      }
    }
    if (lastGhost && opts.ghost) paintGhost(lastGhost)
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
        // Ghost preview on touch/hover — do NOT preventDefault (that kills click on iOS)
        cell.addEventListener('pointerdown', () => {
          if (opts.ghost) paintGhost({ r, c })
        })
        cell.addEventListener('pointerenter', () => {
          if (opts.ghost) paintGhost({ r, c })
        })
        cell.addEventListener('click', () => opts.onCell?.({ r, c }, cell))
      }
      board.appendChild(cell)
    }
  }

  if (opts.ghost && !opts.stickyGhost) {
    board.addEventListener('pointerleave', () => paintGhost(null))
  }
  wrap.appendChild(board)
  return { wrap, paintGhost, refreshCells }
}

/**
 * Update battle UI in-place (no full re-render / no visible page flash).
 * @param flashCoord optional cell to pulse (last bomb)
 */
function softRefreshBattle(flashCoord?: Coord) {
  const screen = document.querySelector<HTMLElement>('[data-screen="battle"]')
  if (!screen) {
    if (uiPhase === 'battle' || engine.phase === 'battle') {
      uiPhase = 'battle'
      paint()
    }
    return
  }

  const me = myOnlineRole ?? engine.currentPlayer
  const isMyTurn = engine.currentPlayer === me

  const turnMsg = isMyTurn
    ? engine.message || t('yourTurnAttack')
    : t('waitPlayer', { name: engine.player(engine.currentPlayer).name })

  const banner = screen.querySelector('.banner')
  if (banner) {
    banner.textContent = turnMsg
    banner.className =
      engine.lastShot?.kind === 'hit'
        ? 'banner hit'
        : engine.lastShot?.kind === 'sunk'
          ? 'banner sunk'
          : engine.lastShot?.kind === 'miss'
            ? 'banner miss'
            : engine.message.includes('Radar')
              ? 'banner radar'
              : isMyTurn
                ? 'banner'
                : 'banner radar'
  }

  const pill = screen.querySelector('.player-pill span:last-child')
  if (pill) {
    pill.textContent = isMyTurn
      ? t('yourTurn')
      : t('turnOf', { name: engine.player(engine.currentPlayer).name })
  }

  const turnCount = screen.querySelector('.battle-top .hint')
  if (turnCount) {
    turnCount.textContent = t('turnCount', {
      turn: engine.turn,
      sunk: engine.opponent(me).planesSunk,
    })
  }

  // Board titles (attack / wait)
  const enemyTitle = screen.querySelector('[data-board="enemy"]')?.parentElement?.querySelector('.board-title')
  if (enemyTitle) {
    enemyTitle.textContent = isMyTurn ? t('attackHere') : t('targetWait')
  }

  // refresh cell classes on both boards without rebuilding DOM
  for (const mode of ['enemy', 'own'] as const) {
    const board = screen.querySelector(`[data-board="${mode}"]`)
    if (!board) continue
    board.querySelectorAll<HTMLElement>('.cell').forEach((cell) => {
      const r = Number(cell.dataset.r)
      const c = Number(cell.dataset.c)
      if (Number.isNaN(r) || Number.isNaN(c)) return
      const state =
        mode === 'own'
          ? engine.cellDisplayOwn(engine.player(me), r, c)
          : engine.cellDisplayEnemy(engine.player(me), r, c)
      const classes = ['cell', state]
      // Own fleet is view-only; enemy is clickable only on our turn
      // Use data attribute for turn lock so CSS pointer-events stays correct
      if (mode === 'own') classes.push('disabled')
      else if (!isMyTurn) classes.push('disabled')
      if (mode === 'enemy' && isMyTurn) classes.push('enemy-target')
      if (flashCoord && flashCoord.r === r && flashCoord.c === c) classes.push('cell-flash')
      // Also flash sunk cells from last shot
      if (
        engine.lastShot?.kind === 'sunk' &&
        engine.lastShot.sunkCells?.some((sc) => sc.r === r && sc.c === c)
      ) {
        classes.push('cell-flash')
      }
      cell.className = classes.join(' ')
    })
  }

  const radarBtn = screen.querySelector<HTMLButtonElement>('[data-action="radar"]')
  if (radarBtn) {
    const used = engine.player(me).radarUsed
    radarBtn.disabled = used || !isMyTurn
    radarBtn.textContent = used ? t('radarUsed') : t('radarCookie')
  }

  socket.setFastPoll(true)
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
