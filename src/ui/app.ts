import { GameEngine } from '../game/engine'
import { aiOpponent } from '../game/ai'
import type { Coord, GameSnapshot, Orientation, PlayerId, ShotResult } from '../game/types'
import {
  clampSettings,
  DIFFICULTY_PRESETS,
  type Difficulty,
  type GameSettings,
} from '../game/settings'
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
  GameSocket,
  type ActiveGame,
  type RoomInfo,
  type ServerMessage,
} from '../multiplayer/socket'
import {
  changeEmail,
  changePassword,
  fetchMe,
  forgotPassword,
  login,
  register,
  reportMatch,
  resendVerification,
  resetPassword,
  uploadAvatar,
  verifyEmail,
} from '../api/client'
import { clearSession, getStoredUser, getToken, updateStoredUser } from '../auth/session'
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
  | 'vs-ai-setup'
  | 'online-lobby'
  | 'placement'
  | 'waiting-opponent'
  | 'battle'
  | 'game-over'
  | 'settings'

/** Pending AI turn timer (vs-ai mode) */
let aiTurnTimer: ReturnType<typeof setTimeout> | null = null

const engine = new GameEngine()
const socket = new GameSocket()

let uiPhase: UiPhase = 'boot'
let currentUser: PublicUser | null = null
let authMode: 'login' | 'register' | 'forgot' | 'reset' = 'login'
let authError = ''
let authNote = ''
/** Full verify URL from registration/resend when email is not actually delivered */
let pendingVerifyUrl = ''
let authBusy = false
let authUserDraft = ''
let authPassDraft = ''
let authEmailDraft = ''
let authPass2Draft = ''
let resetTokenFromUrl: string | null = null
let settingsNote = ''
let settingsError = ''
let settingsBusy = false
let roomCode = ''
let roomInfo: RoomInfo | null = null
let myOnlineRole: PlayerId | null = null
let statusNote = ''
let matchReported = false
let rootEl: HTMLElement | null = null
/** Pending invite from deep link — join after login */
let pendingInviteCode: string | null = null
let copyLinkNote = ''

/** Concurrent multi-game sessions (local engine state per room code) */
interface LocalSession {
  code: string
  role: PlayerId
  snapshot: GameSnapshot
  uiPhase: UiPhase
  roomInfo: RoomInfo | null
  statusNote: string
  matchReported: boolean
}
const sessions = new Map<string, LocalSession>()
let activeGames: ActiveGame[] = []

function saveActiveSession() {
  if (!roomCode || !myOnlineRole) return
  sessions.set(roomCode, {
    code: roomCode,
    role: myOnlineRole,
    snapshot: engine.snapshot(),
    uiPhase,
    roomInfo,
    statusNote,
    matchReported,
  })
}

function clearGameSession(code: string) {
  sessions.delete(code)
}

async function refreshActiveGames() {
  try {
    if (!socket.connected) await socket.connect()
    activeGames = await socket.fetchActiveGames()
  } catch {
    activeGames = []
  }
}

function opponentLabel(g: ActiveGame): string {
  if (g.opponentName) return g.opponentName
  const sess = sessions.get(g.code)
  if (sess) {
    const other = sess.role === 'p1' ? sess.snapshot.p2.name : sess.snapshot.p1.name
    if (other && other !== 'P1' && other !== 'P2' && other !== 'Host') return other
  }
  return t('waitingOpponentName')
}

function statusLabel(g: ActiveGame): string {
  if (g.status === 'battle') return t('statusBattle')
  if (g.status === 'placing') return t('statusPlacing')
  return t('statusWaiting')
}

async function goHome(opts?: { leaveCurrent?: boolean }) {
  cancelAiTurn()
  const leave = opts?.leaveCurrent === true
  if (leave && roomCode) {
    socket.send({ type: 'leave-room', code: roomCode })
    clearGameSession(roomCode)
  } else if (engine.mode !== 'vs-ai') {
    saveActiveSession()
  }
  socket.setActiveRoom(null)
  roomCode = ''
  roomInfo = null
  myOnlineRole = null
  statusNote = ''
  copyLinkNote = ''
  matchReported = false
  engine.backToMenu()
  uiPhase = 'home'
  await refreshActiveGames()
  paint()
}

function resumeSession(code: string): boolean {
  const s = sessions.get(code)
  if (!s) return false
  roomCode = s.code
  myOnlineRole = s.role
  roomInfo = s.roomInfo
  statusNote = s.statusNote
  matchReported = s.matchReported
  uiPhase = s.uiPhase === 'boot' || s.uiPhase === 'auth' || s.uiPhase === 'home' ? 'online-lobby' : s.uiPhase
  engine.loadSnapshot(s.snapshot, true)
  // align uiPhase with engine if snapshot is further along
  if (engine.phase === 'battle') uiPhase = 'battle'
  else if (engine.phase === 'game-over') uiPhase = 'game-over'
  else if (engine.phase === 'placement') {
    uiPhase =
      s.uiPhase === 'waiting-opponent' ? 'waiting-opponent' : 'placement'
  }
  socket.setActiveRoom(code)
  void socket.connect()
  if (uiPhase === 'battle') socket.setFastPoll(true)
  paint()
  return true
}

async function openActiveGame(code: string) {
  const key = code.toUpperCase().trim()
  if (roomCode === key && uiPhase !== 'home') {
    paint()
    return
  }
  saveActiveSession()
  if (resumeSession(key)) return
  // No local snapshot — re-enter room membership and start from lobby/placement
  try {
    await socket.connect()
    statusNote = t('connectingRoom', { code: key })
    uiPhase = 'online-lobby'
    paint()
    socket.send({ type: 'join-room', code: key })
  } catch (e) {
    statusNote = mapRoomError((e as Error).message)
    uiPhase = 'home'
    paint()
  }
}

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
  const urlParams = new URLSearchParams(location.search)
  const verifyTok = urlParams.get('verify')
  const resetTok = urlParams.get('reset')

  uiPhase = 'boot'
  paint()

  if (verifyTok) {
    // Always strip ?verify= so a dead link doesn't loop the error on every refresh
    urlParams.delete('verify')
    const qClean = urlParams.toString()
    history.replaceState({}, '', `${location.pathname}${qClean ? `?${qClean}` : ''}${location.hash}`)
    try {
      const res = await verifyEmail(verifyTok)
      currentUser = res.user
      if (pendingInviteCode) await acceptPendingInvite()
      else {
        uiPhase = 'home'
        try {
          await socket.connect()
          await refreshActiveGames()
        } catch {
          /* */
        }
        paint()
      }
      return
    } catch {
      // Token lost/expired (common after store rebuild). Login with password instead.
      authError = ''
      authNote = t('verifyLinkDead')
      authMode = 'login'
      uiPhase = 'auth'
      paint()
      return
    }
  }

  if (resetTok) {
    resetTokenFromUrl = resetTok
    authMode = 'reset'
    uiPhase = 'auth'
    paint()
    return
  }

  if (getToken()) {
    currentUser = (await fetchMe()) || getStoredUser()
  } else {
    currentUser = null
  }

  if (currentUser && pendingInviteCode) {
    await acceptPendingInvite()
  } else if (currentUser) {
    uiPhase = 'home'
    try {
      await socket.connect()
      await refreshActiveGames()
    } catch {
      /* offline list empty */
    }
    paint()
  } else {
    uiPhase = 'auth'
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
  saveActiveSession()
  statusNote = t('connectingRoom', { code })
  uiPhase = 'online-lobby'
  paint()
  try {
    await socket.connect()
    engine.mode = 'online-join'
    myOnlineRole = 'p2'
    roomCode = code
    socket.setActiveRoom(code)
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
    socket.setActiveRoom(data.room.code)
    if (data.role) myOnlineRole = data.role
    if (data.room.players.length >= 2) {
      statusNote = t('friendJoined')
      engine.mode = myOnlineRole === 'p1' ? 'online-host' : 'online-join'
      const p1 = data.room.players.find((p) => p.role === 'p1')
      const p2 = data.room.players.find((p) => p.role === 'p2')
      if (p1) engine.p1.name = p1.username
      if (p2) engine.p2.name = p2.username
      const alreadyPlaying =
        engine.phase === 'placement' ||
        engine.phase === 'battle' ||
        engine.p1.planes.length > 0 ||
        engine.p2.planes.length > 0
      if (!alreadyPlaying) {
        if (data.room.settings) engine.applySettings(data.room.settings, true)
        engine.beginOnlinePlacement()
        uiPhase = 'placement'
      }
    } else {
      if (data.room.settings) engine.applySettings(data.room.settings, true)
      statusNote = t('roomReadyInvite')
      uiPhase = 'online-lobby'
    }
    saveActiveSession()
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
      socket.setActiveRoom(msg.room.code)
      if (msg.role) myOnlineRole = msg.role
      else if (currentUser) {
        const me = msg.room.players.find((p) => p.userId === currentUser!.id)
        if (me) myOnlineRole = me.role
      }
      // Never re-apply settings in a way that wipes fleets mid-match
      if (
        msg.room.settings &&
        engine.phase !== 'battle' &&
        engine.phase !== 'game-over' &&
        uiPhase !== 'battle' &&
        uiPhase !== 'game-over' &&
        uiPhase !== 'waiting-opponent'
      ) {
        // During placement only apply if no fleet yet (avoid wipe from geometry noise)
        const hasFleet =
          engine.p1.planes.length > 0 || engine.p2.planes.length > 0
        if (!hasFleet) engine.applySettings(msg.room.settings, true)
        else engine.applySettings({ ...msg.room.settings, gridSize: engine.gridSize, planesPerPlayer: engine.planesPerPlayer, longWings: engine.longWings }, true)
      }
      statusNote =
        msg.room.players.length < 2
          ? t('roomReadyInvite')
          : t('roomBothConnected', { code: roomCode })
      if (msg.room.players.length < 2 && uiPhase !== 'placement' && uiPhase !== 'battle' && uiPhase !== 'waiting-opponent') {
        uiPhase = 'online-lobby'
      }
      saveActiveSession()
      paint()
      break
    case 'both-joined':
      roomInfo = msg.room
      roomCode = msg.room.code
      socket.setActiveRoom(msg.room.code)
      statusNote = t('friendJoined')
      engine.mode = myOnlineRole === 'p1' ? 'online-host' : 'online-join'
      if (roomInfo) {
        const p1 = roomInfo.players.find((p) => p.role === 'p1')
        const p2 = roomInfo.players.find((p) => p.role === 'p2')
        if (p1) engine.p1.name = p1.username
        if (p2) engine.p2.name = p2.username
      }
      // CRITICAL: do not call beginOnlinePlacement again after fleets are placed
      // (poll can re-emit both-joined when rejoining / multi-game focus)
      {
        const alreadyPlaying =
          engine.phase === 'placement' ||
          engine.phase === 'battle' ||
          engine.phase === 'game-over' ||
          uiPhase === 'placement' ||
          uiPhase === 'waiting-opponent' ||
          uiPhase === 'battle' ||
          uiPhase === 'game-over' ||
          engine.p1.planes.length > 0 ||
          engine.p2.planes.length > 0
        if (!alreadyPlaying) {
          if (roomInfo?.settings) engine.applySettings(roomInfo.settings, true)
          engine.beginOnlinePlacement()
          uiPhase = 'placement'
        }
      }
      saveActiveSession()
      paint()
      break
    case 'settings':
      if (msg.settings) {
        // Never wipe fleets once battle started
        if (engine.phase === 'battle' || engine.phase === 'game-over' || uiPhase === 'battle') {
          // only cosmetic color if needed
          engine.applySettings(
            {
              ...msg.settings,
              gridSize: engine.gridSize,
              planesPerPlayer: engine.planesPerPlayer,
              longWings: engine.longWings,
            },
            true,
          )
        } else {
          engine.applySettings(msg.settings, true)
          if (roomInfo) roomInfo = { ...roomInfo, settings: msg.settings }
          if (msg.geometryChanged && (uiPhase === 'placement' || uiPhase === 'waiting-opponent')) {
            uiPhase = 'placement'
            statusNote = t('settingsChangedReset')
          }
        }
        paint()
      }
      break
    case 'ready':
      roomInfo = msg.room
      statusNote = t('opponentFleetReady')
      if (engine.phase === 'placement') {
        const me = myOnlineRole ?? 'p1'
        if (engine.player(me).planes.length >= engine.planesPerPlayer) {
          uiPhase = 'waiting-opponent'
        }
      }
      paint()
      break
    case 'start-battle':
      // Idempotent: bothReady poll + own ready response may fire twice
      if (uiPhase === 'battle' && engine.phase === 'battle') break
      engine.phase = 'battle'
      // Don't reset turn/currentPlayer if already progressed mid-battle (reconnect)
      if (engine.turn < 1) {
        engine.currentPlayer = 'p1'
        engine.turn = 1
      }
      engine.message =
        myOnlineRole === 'p1' || engine.currentPlayer === myOnlineRole
          ? engine.currentPlayer === myOnlineRole
            ? t('battleStartYou')
            : t('waitPlayer', { name: engine.player(engine.currentPlayer).name })
          : t('battleStartWait', { name: engine.p1.name })
      uiPhase = 'battle'
      statusNote = ''
      socket.setFastPoll(true)
      saveActiveSession()
      paint()
      break
    case 'placement':
      if (msg.player !== myOnlineRole) {
        engine.applyRemotePlacement(msg.player, msg.data)
        // Only try local battle start if we already confirmed our fleet
        if (
          myOnlineRole &&
          engine.player(myOnlineRole).planes.length >= engine.planesPerPlayer &&
          (uiPhase === 'waiting-opponent' || engine.phase !== 'placement')
        ) {
          engine.markOnlineReady(myOnlineRole)
        }
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
    case 'vs-ai-setup':
      return shell(vsAiSetupScreen())
    case 'settings':
      return shell(settingsScreen())
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
    default:
      return shell(homeScreen())
  }
}

function cancelAiTurn() {
  if (aiTurnTimer != null) {
    clearTimeout(aiTurnTimer)
    aiTurnTimer = null
  }
}

/** After human shot (or battle start if AI somehow first), schedule computer move. */
function scheduleAiTurn() {
  cancelAiTurn()
  if (engine.mode !== 'vs-ai') return
  if (engine.phase !== 'battle') return
  if (engine.currentPlayer !== 'p2') return
  if (engine.winner) return

  const delay = 450 + Math.floor(Math.random() * 550)
  aiTurnTimer = setTimeout(() => {
    aiTurnTimer = null
    runAiTurn()
  }, delay)
}

function runAiTurn() {
  if (engine.mode !== 'vs-ai' || engine.phase !== 'battle' || engine.currentPlayer !== 'p2') return
  if (engine.winner) return

  const diff = engine.settings.difficulty
  const ai = engine.p2

  if (
    aiOpponent.shouldUseRadar(diff, ai.radarUsed, engine.turn, ai.fired, engine.gridSize)
  ) {
    const cells = engine.useRadar('p2')
    if (cells.length) sfxRadar()
  }

  const shot = aiOpponent.chooseShot(diff, engine.gridSize, ai.fired)
  const result = engine.fire(shot, 'p2', { silent: true })
  playShotFx(result)

  if (engine.winner) {
    uiPhase = 'game-over'
    paint()
    return
  }
  if (uiPhase === 'battle') softRefreshBattle(shot)
  else {
    uiPhase = 'battle'
    paint()
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

  // Row 1: brand + theme/lang
  const top = el('div', { className: 'header-row header-row-top' })
  const brand = el(
    'button',
    {
      className: 'brand',
      type: 'button',
      onClick: () => {
        if (currentUser) {
          uiPhase = 'home'
          void refreshActiveGames().then(() => paint())
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

  // Row 2: settings + logout only (no chip / no leaderboard)
  if (currentUser) {
    const bottom = el('div', { className: 'header-row header-row-user' })
    const actions = el('div', { className: 'header-user-actions header-user-actions-end' })
    actions.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-sm',
        type: 'button',
        text: t('settings'),
        'data-action': 'settings',
        onClick: () => {
          settingsNote = ''
          settingsError = ''
          uiPhase = 'settings'
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
          authMode = 'login'
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
  const title =
    authMode === 'login'
      ? t('authTitleLogin')
      : authMode === 'register'
        ? t('authTitleRegister')
        : authMode === 'forgot'
          ? t('authTitleForgot')
          : t('authTitleReset')

  const screen = el('div', { className: 'screen auth-screen', 'data-screen': 'auth' }, [
    el('h1', { className: 'logo', text: '✈ ' + t('appName') }),
    el('p', {
      className: 'tagline',
      text: t('authTagline'),
    }),
    el('div', { className: 'card auth-card' }, [el('h2', { text: title })]),
  ])

  const card = screen.querySelector('.auth-card') as HTMLElement

  if (authMode === 'login' || authMode === 'register') {
    card.appendChild(
      el('div', { className: 'tabs' }, [
        el('button', {
          className: `tab ${authMode === 'login' ? 'active' : ''}`,
          type: 'button',
          text: t('tabLogin'),
          onClick: () => {
            authMode = 'login'
            authError = ''
            authNote = ''
            paint()
          },
        }),
        el('button', {
          className: `tab ${authMode === 'register' ? 'active' : ''}`,
          type: 'button',
          text: t('tabRegister'),
          onClick: () => {
            authMode = 'register'
            authError = ''
            authNote = ''
            paint()
          },
        }),
      ]),
    )
  }

  const userInput = el('input', {
    type: 'text',
    id: 'auth-user',
    autocomplete: authMode === 'login' ? 'username' : 'nickname',
    maxlength: '20',
    placeholder: authMode === 'login' ? t('usernameOrEmail') : t('username'),
    'aria-label': authMode === 'login' ? t('usernameOrEmail') : t('username'),
  }) as HTMLInputElement
  userInput.value = authUserDraft
  userInput.addEventListener('input', () => {
    authUserDraft = userInput.value
  })

  const emailInput = el('input', {
    type: 'email',
    id: 'auth-email',
    autocomplete: 'email',
    maxlength: '120',
    placeholder: t('emailPlaceholder'),
    'aria-label': t('email'),
  }) as HTMLInputElement
  emailInput.value = authEmailDraft
  emailInput.addEventListener('input', () => {
    authEmailDraft = emailInput.value
  })

  const passInput = el('input', {
    type: 'password',
    id: 'auth-pass',
    autocomplete:
      authMode === 'login' ? 'current-password' : authMode === 'forgot' ? 'off' : 'new-password',
    maxlength: '64',
    placeholder: t('passwordPlaceholder'),
    'aria-label': t('password'),
  }) as HTMLInputElement
  passInput.value = authPassDraft
  passInput.addEventListener('input', () => {
    authPassDraft = passInput.value
  })

  const pass2Input = el('input', {
    type: 'password',
    id: 'auth-pass2',
    autocomplete: 'new-password',
    maxlength: '64',
    placeholder: t('passwordConfirmPlaceholder'),
    'aria-label': t('passwordConfirm'),
  }) as HTMLInputElement
  pass2Input.value = authPass2Draft
  pass2Input.addEventListener('input', () => {
    authPass2Draft = pass2Input.value
  })

  if (authMode === 'login') {
    card.append(
      el('div', { className: 'field' }, [
        el('label', { for: 'auth-user', text: t('usernameOrEmail') }),
        userInput,
      ]),
      el('div', { className: 'field' }, [el('label', { for: 'auth-pass', text: t('password') }), passInput]),
    )
  } else if (authMode === 'register') {
    card.append(
      el('div', { className: 'field' }, [el('label', { for: 'auth-user', text: t('username') }), userInput]),
      el('div', { className: 'field' }, [el('label', { for: 'auth-email', text: t('email') }), emailInput]),
      el('div', { className: 'field' }, [el('label', { for: 'auth-pass', text: t('password') }), passInput]),
      el('p', { className: 'hint', text: t('registerEmailHint') }),
    )
  } else if (authMode === 'forgot') {
    card.append(
      el('p', { className: 'hint', text: t('forgotHint') }),
      el('div', { className: 'field' }, [el('label', { for: 'auth-email', text: t('email') }), emailInput]),
    )
  } else if (authMode === 'reset') {
    card.append(
      el('p', { className: 'hint', text: t('resetHint') }),
      el('div', { className: 'field' }, [el('label', { for: 'auth-pass', text: t('newPassword') }), passInput]),
      el('div', { className: 'field' }, [
        el('label', { for: 'auth-pass2', text: t('passwordConfirm') }),
        pass2Input,
      ]),
    )
  }

  if (authError) card.appendChild(el('div', { className: 'banner hit', text: authError }))
  if (authNote && authNote !== 'NEED_RESEND') {
    card.appendChild(el('div', { className: 'banner', text: authNote }))
  }
  if (pendingVerifyUrl) {
    card.appendChild(
      el('a', {
        className: 'btn btn-sky btn-block',
        href: pendingVerifyUrl,
        text: t('confirmEmailNow'),
        style: 'text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center',
      }),
    )
    card.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-block',
        type: 'button',
        text: t('confirmEmailInline'),
        onClick: async () => {
          try {
            const u = new URL(pendingVerifyUrl, location.origin)
            const tok = u.searchParams.get('verify')
            if (!tok) throw new Error(t('resetTokenMissing'))
            authBusy = true
            paint()
            const res = await verifyEmail(tok)
            currentUser = res.user
            pendingVerifyUrl = ''
            authNote = ''
            authError = ''
            authBusy = false
            uiPhase = 'home'
            try {
              await socket.connect()
              await refreshActiveGames()
            } catch {
              /* */
            }
            paint()
          } catch (e) {
            authBusy = false
            authError = (e as Error).message
            paint()
          }
        },
      }),
    )
  }

  const submitLabel =
    authMode === 'login'
      ? t('btnLogin')
      : authMode === 'register'
        ? t('btnRegister')
        : authMode === 'forgot'
          ? t('btnSendReset')
          : t('btnResetPassword')

  card.appendChild(
    el('button', {
      className: 'btn btn-primary btn-block',
      type: 'button',
      disabled: authBusy,
      text: authBusy ? t('processing') : submitLabel,
      onClick: async () => {
        authUserDraft = userInput.value
        authPassDraft = passInput.value
        authEmailDraft = emailInput.value
        authPass2Draft = pass2Input.value
        authBusy = true
        authError = ''
        authNote = ''
        paint()
        try {
          if (authMode === 'login') {
            const res = await login(authUserDraft.trim(), authPassDraft)
            currentUser = res.user
            authBusy = false
            authPassDraft = ''
            if (pendingInviteCode) await acceptPendingInvite()
            else {
              uiPhase = 'home'
              try {
                await socket.connect()
                await refreshActiveGames()
              } catch {
                /* */
              }
              paint()
            }
            return
          }
          if (authMode === 'register') {
            const res = await register(authUserDraft.trim(), authPassDraft, authEmailDraft.trim())
            authBusy = false
            authPassDraft = ''
            // No email provider / auto-verified → go straight home
            if (res.token && res.user && 'emailVerified' in res.user) {
              currentUser = res.user as import('../auth/types').PublicUser
              if (pendingInviteCode) await acceptPendingInvite()
              else {
                uiPhase = 'home'
                try {
                  await socket.connect()
                  await refreshActiveGames()
                } catch {
                  /* */
                }
                paint()
              }
              return
            }
            authMode = 'login'
            authNote = res.message
            // Clickable confirm control when only a debug link is available
            if (res.debugVerifyLink) {
              authNote = res.message
              pendingVerifyUrl = res.debugVerifyLink
            }
            paint()
            return
          }
          if (authMode === 'forgot') {
            const res = await forgotPassword(authEmailDraft.trim())
            authBusy = false
            authNote = res.message + (res.debugResetLink ? `\n${res.debugResetLink}` : '')
            paint()
            return
          }
          if (authMode === 'reset') {
            if (authPassDraft !== authPass2Draft) throw new Error(t('passwordMismatch'))
            if (!resetTokenFromUrl) throw new Error(t('resetTokenMissing'))
            const res = await resetPassword(resetTokenFromUrl, authPassDraft)
            currentUser = res.user
            resetTokenFromUrl = null
            authBusy = false
            authPassDraft = ''
            authPass2Draft = ''
            // clean URL
            const u = new URL(location.href)
            u.searchParams.delete('reset')
            history.replaceState({}, '', u.pathname + (u.search || '') + u.hash)
            uiPhase = 'home'
            paint()
            return
          }
        } catch (e) {
          authBusy = false
          const err = e as Error & { code?: string }
          if (err.code === 'EMAIL_NOT_VERIFIED' || err.message === 'EMAIL_NOT_VERIFIED') {
            authError = t('emailNotVerified')
            authNote = 'NEED_RESEND'
          } else {
            authError = err.message
          }
          paint()
        }
      },
    }),
  )

  if (authMode === 'login') {
    card.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-block',
        type: 'button',
        text: t('forgotPasswordLink'),
        onClick: () => {
          authMode = 'forgot'
          authError = ''
          authNote = ''
          paint()
        },
      }),
    )
    if (authNote === 'NEED_RESEND') {
      card.appendChild(
        el('button', {
          className: 'btn btn-sky btn-block',
          type: 'button',
          text: t('resendVerify'),
          onClick: async () => {
            try {
              const res = await resendVerification(authUserDraft.trim() || authEmailDraft.trim())
              authNote = res.message
              pendingVerifyUrl = res.debugVerifyLink || ''
              authError = ''
              paint()
            } catch (e) {
              authError = (e as Error).message
              paint()
            }
          },
        }),
      )
    }
  }

  if (authMode === 'forgot' || authMode === 'reset') {
    card.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-block',
        type: 'button',
        text: t('backToLogin'),
        onClick: () => {
          authMode = 'login'
          authError = ''
          authNote = ''
          paint()
        },
      }),
    )
  }

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

function settingsScreen(): HTMLElement {
  const u = currentUser!
  const screen = el('div', { className: 'screen', 'data-screen': 'settings' }, [
    el('h2', { text: t('settingsTitle') }),
  ])

  // —— Avatar ——
  const avatarCard = el('div', { className: 'card settings-card' }, [
    el('h3', { text: t('settingsAvatar') }),
  ])
  const preview = el('div', {
    className: 'avatar-preview',
    style: u.avatarDataUrl
      ? `background-image:url(${u.avatarDataUrl})`
      : undefined,
    text: u.avatarDataUrl ? '' : (u.username[0] || '?').toUpperCase(),
  })
  const fileInput = el('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp',
    className: 'sr-only',
    id: 'avatar-file',
  }) as HTMLInputElement
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    if (!file) return
    if (file.size > 120_000) {
      settingsError = t('avatarTooBig')
      paint()
      return
    }
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        settingsBusy = true
        settingsError = ''
        paint()
        const dataUrl = String(reader.result || '')
        currentUser = await uploadAvatar(dataUrl)
        settingsNote = t('avatarSaved')
        settingsBusy = false
        paint()
      } catch (e) {
        settingsBusy = false
        settingsError = (e as Error).message
        paint()
      }
    }
    reader.readAsDataURL(file)
  })
  avatarCard.append(
    preview,
    el('div', { className: 'btn-row' }, [
      el('button', {
        className: 'btn btn-sky',
        type: 'button',
        text: t('choosePhoto'),
        disabled: settingsBusy,
        onClick: () => fileInput.click(),
      }),
      el('button', {
        className: 'btn btn-ghost',
        type: 'button',
        text: t('removePhoto'),
        disabled: settingsBusy || !u.avatarDataUrl,
        onClick: async () => {
          try {
            currentUser = await uploadAvatar('')
            settingsNote = t('avatarRemoved')
            paint()
          } catch (e) {
            settingsError = (e as Error).message
            paint()
          }
        },
      }),
    ]),
    fileInput,
  )
  screen.appendChild(avatarCard)

  // —— Email ——
  const emailInput = el('input', {
    type: 'email',
    id: 'set-email',
    value: u.email || '',
    autocomplete: 'email',
    maxlength: '120',
  }) as HTMLInputElement
  emailInput.value = u.email || ''
  const emailCard = el('div', { className: 'card settings-card' }, [
    el('h3', { text: t('settingsEmail') }),
    el('p', {
      className: 'hint',
      text: u.emailVerified ? t('emailVerifiedOk') : t('emailNotVerifiedShort'),
    }),
    el('div', { className: 'field' }, [el('label', { for: 'set-email', text: t('email') }), emailInput]),
    el('button', {
      className: 'btn btn-primary btn-block',
      type: 'button',
      text: t('saveEmail'),
      disabled: settingsBusy,
      onClick: async () => {
        try {
          settingsBusy = true
          settingsError = ''
          paint()
          const res = await changeEmail(emailInput.value.trim())
          currentUser = res.user
          updateStoredUser(res.user)
          settingsNote = res.message + (res.debugVerifyLink ? `\n${res.debugVerifyLink}` : '')
          settingsBusy = false
          paint()
        } catch (e) {
          settingsBusy = false
          settingsError = (e as Error).message
          paint()
        }
      },
    }),
  ])
  screen.appendChild(emailCard)

  // —— Password ——
  const curPass = el('input', {
    type: 'password',
    id: 'set-cur-pass',
    autocomplete: 'current-password',
    maxlength: '64',
  }) as HTMLInputElement
  const newPass = el('input', {
    type: 'password',
    id: 'set-new-pass',
    autocomplete: 'new-password',
    maxlength: '64',
  }) as HTMLInputElement
  const newPass2 = el('input', {
    type: 'password',
    id: 'set-new-pass2',
    autocomplete: 'new-password',
    maxlength: '64',
  }) as HTMLInputElement
  const passCard = el('div', { className: 'card settings-card' }, [
    el('h3', { text: t('settingsPassword') }),
    el('div', { className: 'field' }, [
      el('label', { for: 'set-cur-pass', text: t('currentPassword') }),
      curPass,
    ]),
    el('div', { className: 'field' }, [el('label', { for: 'set-new-pass', text: t('newPassword') }), newPass]),
    el('div', { className: 'field' }, [
      el('label', { for: 'set-new-pass2', text: t('passwordConfirm') }),
      newPass2,
    ]),
    el('button', {
      className: 'btn btn-primary btn-block',
      type: 'button',
      text: t('savePassword'),
      disabled: settingsBusy,
      onClick: async () => {
        try {
          if (newPass.value !== newPass2.value) throw new Error(t('passwordMismatch'))
          settingsBusy = true
          settingsError = ''
          paint()
          await changePassword(curPass.value, newPass.value)
          settingsNote = t('passwordChanged')
          settingsBusy = false
          curPass.value = ''
          newPass.value = ''
          newPass2.value = ''
          paint()
        } catch (e) {
          settingsBusy = false
          settingsError = (e as Error).message
          paint()
        }
      },
    }),
  ])
  screen.appendChild(passCard)

  if (settingsError) screen.appendChild(el('div', { className: 'banner hit', text: settingsError }))
  if (settingsNote) screen.appendChild(el('div', { className: 'banner', text: settingsNote }))

  screen.appendChild(
    el('button', {
      className: 'btn btn-ghost btn-block',
      type: 'button',
      text: t('backHome'),
      onClick: () => {
        settingsNote = ''
        settingsError = ''
        uiPhase = 'home'
        paint()
      },
    }),
  )

  return screen
}

function homeScreen(): HTMLElement {
  const u = currentUser!
  const screen = el('div', { className: 'screen', 'data-screen': 'home' }, [
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
  ])

  // Active games — pick by opponent name, multi-game
  const gamesCard = el('div', { className: 'card active-games-card' }, [
    el('h3', { className: 'active-games-title', text: t('activeGames') }),
  ])
  if (activeGames.length === 0 && sessions.size === 0) {
    gamesCard.appendChild(el('p', { className: 'hint', text: t('activeGamesEmpty') }))
  } else {
    const list = el('div', { className: 'active-games-list', role: 'list' })
    // Prefer server list; supplement with local-only sessions not yet on server list
    const byCode = new Map<string, ActiveGame>()
    for (const g of activeGames) byCode.set(g.code, g)
    for (const [code, sess] of sessions) {
      if (!byCode.has(code)) {
        byCode.set(code, {
          code,
          role: sess.role,
          opponentName: opponentLabel({
            code,
            role: sess.role,
            opponentName: null,
            opponentUserId: null,
            playersCount: 1,
            bothReady: false,
            status: 'waiting',
          }),
          opponentUserId: null,
          playersCount: sess.roomInfo?.players.length ?? 1,
          bothReady: false,
          status:
            sess.uiPhase === 'battle' || sess.snapshot.phase === 'battle'
              ? 'battle'
              : sess.uiPhase === 'placement' || sess.uiPhase === 'waiting-opponent'
                ? 'placing'
                : 'waiting',
        })
      }
    }
    for (const g of byCode.values()) {
      const name = opponentLabel(g)
      const row = el('button', {
        type: 'button',
        className: 'active-game-row',
        role: 'listitem',
        'data-code': g.code,
        onClick: () => void openActiveGame(g.code),
      })
      row.append(
        el('div', { className: 'active-game-main' }, [
          el('span', { className: 'active-game-vs', text: t('playVs', { name }) }),
          el('span', { className: 'active-game-status', text: statusLabel(g) }),
        ]),
        el('span', { className: 'active-game-go', text: '›' }),
      )
      list.appendChild(row)
    }
    gamesCard.appendChild(list)
  }
  screen.appendChild(gamesCard)

  screen.appendChild(
    el('div', { className: 'card grid-actions' }, [
      el('button', {
        className: 'btn btn-primary btn-block',
        'data-action': 'vs-ai',
        text: t('playVsAi'),
        onClick: () => {
          cancelAiTurn()
          saveActiveSession()
          roomInfo = null
          roomCode = ''
          myOnlineRole = null
          socket.setActiveRoom(null)
          // default medium preset for setup screen
          const preset = DIFFICULTY_PRESETS[engine.settings.difficulty]
          engine.applySettings({ ...engine.settings, ...preset }, true)
          uiPhase = 'vs-ai-setup'
          paint()
        },
      }),
      el('button', {
        className: 'btn btn-sky btn-block',
        'data-action': 'invite',
        text: t('inviteFriend'),
        onClick: () => void startOnlineHost(),
      }),
      el('button', {
        className: 'btn btn-ghost btn-block',
        'data-action': 'join-code',
        text: t('haveCode'),
        onClick: () => {
          saveActiveSession()
          roomInfo = null
          roomCode = ''
          myOnlineRole = null
          socket.setActiveRoom(null)
          engine.mode = 'online-join'
          statusNote = t('pasteCodeHint')
          uiPhase = 'online-lobby'
          paint()
        },
      }),
    ]),
  )

  return screen
}

function vsAiSetupScreen(): HTMLElement {
  const s = engine.settings
  const screen = el('div', { className: 'screen', 'data-screen': 'vs-ai-setup' }, [
    el('h1', { className: 'logo', text: '✈ ' + t('vsAiSetupTitle') }),
    el('p', { className: 'tagline', text: t('vsAiSetupHint') }),
  ])

  const card = el('div', { className: 'card game-settings-panel' })
  card.appendChild(el('div', { className: 'settings-label', text: t('difficulty') }))

  const diffRow = el('div', { className: 'diff-grid' })
  const diffs: { id: Difficulty; key: string }[] = [
    { id: 'easy', key: 'diffEasy' },
    { id: 'medium', key: 'diffMedium' },
    { id: 'hard', key: 'diffHard' },
    { id: 'impossible', key: 'diffImpossible' },
  ]
  for (const d of diffs) {
    diffRow.appendChild(
      el('button', {
        type: 'button',
        className: `diff-btn ${s.difficulty === d.id ? 'active' : ''}`,
        text: t(d.key),
        'data-difficulty': d.id,
        onClick: () => {
          const preset = DIFFICULTY_PRESETS[d.id]
          engine.applySettings({ difficulty: d.id, ...preset })
          paint()
        },
      }),
    )
  }
  card.appendChild(diffRow)

  // Summary of what the preset means
  card.appendChild(
    el('p', {
      className: 'hint',
      text: `${s.gridSize}×${s.gridSize} · ${s.planesPerPlayer} ${t('numPlanes').toLowerCase()}${s.longWings ? ' · ' + t('longWings') : ''}`,
    }),
  )

  // Optional fine-tune (same controls as multiplayer)
  const gridLabel = el('div', {
    className: 'settings-label',
    text: `${t('numCells')}: ${s.gridSize}×${s.gridSize}`,
  })
  const gridSlider = el('input', {
    type: 'range',
    min: '8',
    max: '14',
    step: '1',
    value: String(s.gridSize),
    className: 'settings-range',
  }) as HTMLInputElement
  gridSlider.addEventListener('input', () => {
    gridLabel.textContent = `${t('numCells')}: ${gridSlider.value}×${gridSlider.value}`
  })
  gridSlider.addEventListener('change', () => {
    engine.applySettings({ gridSize: Number(gridSlider.value) })
    paint()
  })
  card.append(gridLabel, gridSlider)

  const planesLabel = el('div', {
    className: 'settings-label',
    text: `${t('numPlanes')}: ${s.planesPerPlayer}`,
  })
  const planesSlider = el('input', {
    type: 'range',
    min: '1',
    max: '12',
    step: '1',
    value: String(s.planesPerPlayer),
    className: 'settings-range',
  }) as HTMLInputElement
  planesSlider.addEventListener('input', () => {
    planesLabel.textContent = `${t('numPlanes')}: ${planesSlider.value}`
  })
  planesSlider.addEventListener('change', () => {
    engine.applySettings({ planesPerPlayer: Number(planesSlider.value) })
    paint()
  })
  card.append(planesLabel, planesSlider)

  card.appendChild(
    el('button', {
      type: 'button',
      className: `toggle-btn ${s.longWings ? 'active' : ''}`,
      text: s.longWings ? `✓ ${t('longWings')}` : t('longWings'),
      onClick: () => {
        engine.applySettings({ longWings: !engine.settings.longWings })
        paint()
      },
    }),
  )

  screen.appendChild(card)

  screen.appendChild(
    el('button', {
      className: 'btn btn-primary btn-block',
      type: 'button',
      'data-action': 'vs-ai-start',
      text: t('vsAiStart'),
      onClick: () => {
        cancelAiTurn()
        aiOpponent.reset()
        const name = currentUser?.username || t('engineYou')
        engine.startVsAi(name)
        myOnlineRole = null
        roomCode = ''
        roomInfo = null
        matchReported = false
        uiPhase = 'placement'
        paint()
      },
    }),
  )

  screen.appendChild(
    el('button', {
      className: 'btn btn-ghost btn-block',
      type: 'button',
      text: t('backHome'),
      onClick: () => {
        uiPhase = 'home'
        paint()
      },
    }),
  )

  return screen
}

function statCard(n: string, l: string) {
  return el('div', { className: 'stat' }, [
    el('div', { className: 'n', text: n }),
    el('div', { className: 'l', text: l }),
  ])
}

async function startOnlineHost() {
  saveActiveSession()
  copyLinkNote = ''
  statusNote = t('preparingRoom')
  roomInfo = null
  roomCode = ''
  myOnlineRole = 'p1'
  engine.mode = 'online-host'
  engine.phase = 'online-lobby'
  uiPhase = 'online-lobby'
  paint()
  try {
    await socket.connect()
    socket.send({ type: 'create-room' })
  } catch (e) {
    statusNote = (e as Error).message
    paint()
  }
}

function publishMatchSettings(partial: Partial<GameSettings>) {
  if (uiPhase === 'battle' || uiPhase === 'game-over') return
  const next = clampSettings({ ...engine.settings, ...partial })
  engine.applySettings(next)
  if (roomInfo) roomInfo = { ...roomInfo, settings: next }
  if (roomCode && socket.connected) {
    socket.send({ type: 'settings', settings: next })
  }
  if (uiPhase === 'waiting-opponent') uiPhase = 'placement'
  paint()
}

/** Match settings panel — same options as classic Avioanele config. */
function gameSettingsPanel(): HTMLElement {
  const s = engine.settings
  const wrap = el('div', { className: 'card game-settings-panel' })
  wrap.append(
    el('h3', { text: t('matchSettings') }),
    el('p', { className: 'hint', text: t('matchSettingsHint') }),
  )

  wrap.appendChild(el('div', { className: 'settings-label', text: t('difficulty') }))
  const diffRow = el('div', { className: 'diff-grid' })
  const diffs: { id: Difficulty; key: string }[] = [
    { id: 'easy', key: 'diffEasy' },
    { id: 'medium', key: 'diffMedium' },
    { id: 'hard', key: 'diffHard' },
    { id: 'impossible', key: 'diffImpossible' },
  ]
  for (const d of diffs) {
    diffRow.appendChild(
      el('button', {
        type: 'button',
        className: `diff-btn ${s.difficulty === d.id ? 'active' : ''}`,
        text: t(d.key),
        onClick: () => {
          const preset = DIFFICULTY_PRESETS[d.id]
          publishMatchSettings({ difficulty: d.id, ...preset })
        },
      }),
    )
  }
  wrap.appendChild(diffRow)

  const gridLabel = el('div', {
    className: 'settings-label',
    text: `${t('numCells')}: ${s.gridSize}×${s.gridSize}`,
  })
  const gridSlider = el('input', {
    type: 'range',
    min: '8',
    max: '14',
    step: '1',
    value: String(s.gridSize),
    className: 'settings-range',
  }) as HTMLInputElement
  gridSlider.value = String(s.gridSize)
  gridSlider.addEventListener('input', () => {
    gridLabel.textContent = `${t('numCells')}: ${gridSlider.value}×${gridSlider.value}`
  })
  gridSlider.addEventListener('change', () => {
    publishMatchSettings({ gridSize: Number(gridSlider.value) })
  })
  wrap.append(gridLabel, gridSlider)

  const planesLabel = el('div', {
    className: 'settings-label',
    text: `${t('numPlanes')}: ${s.planesPerPlayer}`,
  })
  const planesSlider = el('input', {
    type: 'range',
    min: '1',
    max: '12',
    step: '1',
    value: String(s.planesPerPlayer),
    className: 'settings-range',
  }) as HTMLInputElement
  planesSlider.value = String(s.planesPerPlayer)
  planesSlider.addEventListener('input', () => {
    planesLabel.textContent = `${t('numPlanes')}: ${planesSlider.value}`
  })
  planesSlider.addEventListener('change', () => {
    publishMatchSettings({ planesPerPlayer: Number(planesSlider.value) })
  })
  wrap.append(planesLabel, planesSlider)

  wrap.appendChild(
    el('button', {
      type: 'button',
      className: `toggle-btn ${s.longWings ? 'active' : ''}`,
      text: s.longWings ? `✓ ${t('longWings')}` : t('longWings'),
      onClick: () => publishMatchSettings({ longWings: !engine.settings.longWings }),
    }),
  )

  wrap.appendChild(el('div', { className: 'settings-label', text: t('planeColor') }))
  const swatches = el('div', { className: 'color-swatches' })
  const palette = [
    '#e8956a',
    '#c4785a',
    '#5bb4e5',
    '#e07a5f',
    '#f2cc8f',
    '#81b29a',
    '#3d405b',
    '#f4a261',
    '#e76f51',
    '#2a9d8f',
    '#e9c46a',
    '#9b5de5',
    '#ff006e',
    '#8338ec',
    '#3a86ff',
    '#fb5607',
  ]
  for (const hex of palette) {
    swatches.appendChild(
      el('button', {
        type: 'button',
        className: `swatch-btn ${s.planeColor.toLowerCase() === hex.toLowerCase() ? 'active' : ''}`,
        style: `background:${hex}`,
        title: hex,
        'aria-label': hex,
        onClick: () => publishMatchSettings({ planeColor: hex }),
      }),
    )
  }
  wrap.appendChild(swatches)
  const colorInput = el('input', {
    type: 'color',
    value: s.planeColor,
    className: 'color-picker',
    'aria-label': t('planeColor'),
  }) as HTMLInputElement
  colorInput.value = s.planeColor
  colorInput.addEventListener('change', () => publishMatchSettings({ planeColor: colorInput.value }))
  wrap.appendChild(colorInput)

  return wrap
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
        void goHome({ leaveCurrent: true })
      },
    }),
  )
  card.appendChild(
    el('button', {
      className: 'btn btn-sky btn-block',
      style: 'margin-top:8px',
      text: t('keepAndHome'),
      onClick: () => {
        void goHome({ leaveCurrent: false })
      },
    }),
  )

  const children: HTMLElement[] = [
    el('h2', { text: isHostLobby ? t('lobbyInviteTitle') : t('lobbyJoinTitle') }),
    card,
  ]
  // Host (and guest once in room) can edit match settings before the game
  if (isHostLobby || isGuestWaiting) {
    children.push(gameSettingsPanel())
  }
  return el('div', { className: 'screen', 'data-screen': 'online-lobby' }, children)
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
  engine.placingPlayer = placeFor
  if (!engine.confirmPlacement()) {
    buzz(30)
    paint()
    return
  }
  if (engine.mode === 'vs-ai') {
    uiPhase = engine.phase === 'battle' ? 'battle' : 'placement'
    paint()
    return
  }
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
  const placeFor =
    engine.mode === 'vs-ai' ? 'p1' : (myOnlineRole ?? engine.placingPlayer)
  const p = engine.player(placeFor)
  const fleetFull = p.planes.length >= engine.planesPerPlayer
  const canPlaceMore = p.planes.length < engine.planesPerPlayer
  // Ghost only while a free slot remains (never a “4th plane” preview)
  const defaultGhost: Coord = { r: Math.floor(engine.gridSize / 2), c: Math.floor(engine.gridSize / 2) }
  let stickyGhost: Coord | null = canPlaceMore ? (engine.ghostHead ?? defaultGhost) : null
  let boardApi: BoardApi | null = null

  const freeSlots = () =>
    engine.planesPerPlayer - engine.player(placeFor).planes.length

  const clearGhostVisual = () => {
    stickyGhost = null
    engine.setGhost(null)
    boardApi?.paintGhost(null)
  }

  const bannerText = fleetFull
    ? engine.message || t('placeReadyBanner')
    : engine.message || t('placeBanner')

  const screen = el('div', { className: 'screen', 'data-screen': 'placement' }, [
    el('div', { className: 'player-pill' }, [
      el('span', { className: 'dot', style: `background:${p.color}` }),
      el('span', { text: `${p.name} — ${t('yourFleet')} ${p.planes.length}/${engine.planesPerPlayer}` }),
    ]),
    el('div', {
      className: fleetFull ? 'banner hit' : 'banner',
      text: bannerText,
    }),
  ])

  // Both players can tweak match settings until battle starts
  if (engine.mode !== 'local') {
    screen.appendChild(gameSettingsPanel())
  }

  boardApi = boardElement({
    mode: 'own',
    playerId: placeFor,
    interactive: true, // place, tap-to-pick, or drag-and-drop
    showFleet: true,
    // Ghost always enabled for drag/rotate; paintGhost itself refuses a 4th plane
    ghost: true,
    stickyGhost: true,
    dragPlanes: true,
    onGhost: (c) => {
      if (freeSlots() <= 0) {
        stickyGhost = null
        return
      }
      if (c) stickyGhost = c
    },
    onDragPlane: (phase, coord, meta) => {
      engine.placingPlayer = placeFor
      if (phase === 'start') {
        if (!coord) return false
        const lifted = engine.pickUpPlaneAt(coord, true)
        if (!lifted) return false
        buzz(8)
        stickyGhost = lifted.head
        boardApi?.refreshCells()
        boardApi?.paintGhost(lifted.head)
        // offset: grab cell relative to cockpit so drop keeps grip under finger
        return {
          ok: true,
          grabOffset: {
            r: coord.r - lifted.head.r,
            c: coord.c - lifted.head.c,
          },
          origin: lifted,
        }
      }
      if (phase === 'move' && coord) {
        const head = meta?.grabOffset
          ? { r: coord.r - meta.grabOffset.r, c: coord.c - meta.grabOffset.c }
          : coord
        stickyGhost = head
        boardApi?.paintGhost(head)
        return true
      }
      if (phase === 'drop' && coord) {
        const head = meta?.grabOffset
          ? { r: coord.r - meta.grabOffset.r, c: coord.c - meta.grabOffset.c }
          : coord
        stickyGhost = head
        if (engine.placePlane(head, true)) {
          sfxPlace()
          // After place: only keep ghost if a free slot remains
          if (freeSlots() <= 0) {
            stickyGhost = null
            engine.setGhost(null)
          } else {
            stickyGhost = defaultGhost
          }
          paint()
          return true
        }
        // invalid drop → restore original if we have it
        if (meta?.origin) {
          engine.restorePlane(meta.origin.head, meta.origin.orientation, true)
          stickyGhost = null
          engine.setGhost(null)
          paint()
          buzz(30)
          return false
        }
        boardApi?.paintGhost(head)
        buzz(30)
        return false
      }
      if (phase === 'cancel' && meta?.origin) {
        engine.restorePlane(meta.origin.head, meta.origin.orientation, true)
        stickyGhost = null
        engine.setGhost(null)
        paint()
        return false
      }
      return false
    },
    onCell: (coord) => {
      engine.placingPlayer = placeFor
      const fleetCell = engine.player(placeFor).fleet.get(`${coord.r},${coord.c}`)
      // Tap a placed plane → pick up (click without drag)
      if (fleetCell) {
        if (engine.pickUpPlaneAt(coord)) {
          buzz(10)
          stickyGhost = engine.ghostHead ?? coord
          paint()
        }
        return
      }
      // Place if we still have free slots — never a 4th plane
      if (engine.player(placeFor).planes.length >= engine.planesPerPlayer) {
        clearGhostVisual()
        buzz(20)
        return
      }
      engine.setGhost(coord)
      stickyGhost = coord
      if (engine.placePlane(coord)) {
        sfxPlace()
        if (freeSlots() <= 0) {
          stickyGhost = null
          engine.setGhost(null)
        } else {
          stickyGhost = defaultGhost
        }
        paint()
      } else {
        buzz(30)
        screenShake(document.getElementById('app'))
        boardApi?.paintGhost(coord)
      }
    },
  })
  // Board first — controls (including rotate) go below the field
  screen.appendChild(boardApi.wrap)

  const rotateBtn = el('button', {
    className: 'btn btn-accent btn-block',
    type: 'button',
    'data-action': 'rotate',
    text: t('rotate', { deg: engine.placeOrientation }),
    onClick: (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      // Rotate only useful while placing / after pick-up (free slot)
      if (freeSlots() <= 0) {
        clearGhostVisual()
        buzz(12)
        return
      }
      engine.rotateGhost()
      buzz(8)
      rotateBtn.textContent = t('rotate', { deg: engine.placeOrientation })
      const head = stickyGhost ?? engine.ghostHead ?? defaultGhost
      stickyGhost = head
      boardApi?.paintGhost(head)
    },
  }) as HTMLButtonElement

  // Single rotate button directly under the board
  screen.appendChild(rotateBtn)

  const doneBtn = el('button', {
    className: 'btn btn-primary btn-block',
    type: 'button',
    'data-action': 'confirm-fleet',
    text: t('doneFleet'),
    disabled: !fleetFull,
    onClick: () => {
      if (engine.player(placeFor).planes.length < engine.planesPerPlayer) {
        buzz(30)
        return
      }
      sfxPlace()
      finishPlacementAndNotify(placeFor)
    },
  }) as HTMLButtonElement

  screen.appendChild(
    el('div', { className: 'toolbar' }, [
      el('button', {
        className: 'btn btn-sky',
        'data-action': 'auto-place',
        text: t('auto'),
        onClick: () => {
          engine.placingPlayer = placeFor
          if (engine.autoPlaceRemaining()) {
            sfxPlace()
            paint() // stay here — rearrange or press Done
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
  screen.appendChild(doneBtn)
  screen.appendChild(
    el('p', {
      className: 'hint',
      text: t('cabinHint'),
    }),
  )

  // Only show sticky ghost when a free slot remains (never a 4th plane outline)
  if (engine.player(placeFor).planes.length < engine.planesPerPlayer && stickyGhost) {
    queueMicrotask(() => boardApi?.paintGhost(stickyGhost))
  }

  return screen
}

function battleScreen(): HTMLElement {
  // Always prefer online role so "own fleet" never flips to the opponent's board
  const me =
    engine.mode === 'vs-ai'
      ? 'p1'
      : (myOnlineRole ?? (engine.mode === 'online-join' ? 'p2' : 'p1'))
  const myPlayer = engine.player(me)
  const isMyTurn = engine.currentPlayer === me
  const vsAi = engine.mode === 'vs-ai'

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
    : vsAi
      ? t('aiThinking')
      : t('waitPlayer', { name: engine.player(engine.currentPlayer).name })

  // If it's the computer's turn when the battle view mounts, shoot soon
  if (vsAi && !isMyTurn && engine.phase === 'battle' && !engine.winner) {
    queueMicrotask(() => scheduleAiTurn())
  }

  return el('div', { className: 'screen', 'data-screen': 'battle' }, [
    el('div', { className: 'battle-top' }, [
      el('div', { className: 'player-pill' }, [
        el('span', {
          className: 'dot',
          style: `background:${engine.player(engine.currentPlayer).color}`,
        }),
        el('span', {
          text: isMyTurn
            ? t('yourTurn')
            : t('turnOf', { name: engine.player(engine.currentPlayer).name }),
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
          if (!vsAi) socket.send({ type: 'shot', player: me, coord })
          // fire() may set winner / phase; prefer winner flag (avoids TS phase narrowing)
          if (engine.winner) {
            uiPhase = 'game-over'
            paint()
            void maybeReportMatch()
          } else {
            softRefreshBattle(coord)
            if (vsAi) scheduleAiTurn()
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
          if (!vsAi) socket.send({ type: 'radar', player: me })
        },
      }),
      el('button', {
        className: 'btn btn-ghost',
        'data-action': 'home-keep',
        text: vsAi ? t('backHome') : t('keepAndHome'),
        onClick: () => {
          void goHome({ leaveCurrent: true })
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
          el('div', { className: 'n', text: String(engine.planesPerPlayer) }),
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
            cancelAiTurn()
            if (engine.mode === 'online-host' || engine.mode === 'online-join') {
              socket.send({ type: 'rematch' })
            }
            if (engine.mode === 'vs-ai') aiOpponent.reset()
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
            void goHome({ leaveCurrent: true })
          },
        }),
        el('button', {
          className: 'btn btn-sky',
          'data-action': 'home-keep',
          text: t('keepAndHome'),
          onClick: () => {
            void goHome({ leaveCurrent: false })
          },
        }),
      ]),
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

type DragPhase = 'start' | 'move' | 'drop' | 'cancel'

interface DragMeta {
  grabOffset: Coord
  origin: { head: Coord; orientation: Orientation }
}

interface BoardOpts {
  mode: 'own' | 'enemy'
  playerId: PlayerId
  interactive: boolean
  showFleet: boolean
  ghost: boolean
  /** Keep last ghost when pointer leaves (mobile-friendly rotate) */
  stickyGhost?: boolean
  /** Enable drag-and-drop of placed planes (placement only) */
  dragPlanes?: boolean
  title?: string
  onCell?: (coord: Coord, cellEl: HTMLElement) => void
  onGhost?: (coord: Coord | null) => void
  /**
   * Drag lifecycle for planes.
   * start: return { ok, grabOffset, origin } or false
   * move/drop/cancel: return success boolean
   */
  onDragPlane?: (
    phase: DragPhase,
    coord: Coord | null,
    meta?: DragMeta,
  ) => boolean | { ok: true; grabOffset: Coord; origin: DragMeta['origin'] }
}

interface BoardApi {
  wrap: HTMLElement
  paintGhost: (head: Coord | null) => void
  refreshCells: () => void
}

function boardElement(opts: BoardOpts): BoardApi {
  const wrap = el('div', { className: 'board-wrap' })
  if (opts.title) wrap.appendChild(el('div', { className: 'board-title', text: opts.title }))

  const gridN = engine.gridSize
  const fleetColor = engine.settings.planeColor
  const board = el('div', {
    className: `board${opts.dragPlanes ? ' board-drag' : ''}`,
    role: 'grid',
    'aria-label': opts.title || 'Grilă joc',
    'data-board': opts.mode,
    style: `--grid-n:${gridN};--fleet-color:${fleetColor}`,
  })

  board.appendChild(el('div', { className: 'corner' }))
  for (let c = 0; c < engine.gridSize; c++) {
    board.appendChild(el('div', { className: 'col-label', text: engine.cols[c] }))
  }

  const player = engine.player(opts.playerId)
  const cellNodes: HTMLElement[][] = []
  let lastGhost: Coord | null = null

  const paintGhost = (head: Coord | null) => {
    for (const row of cellNodes) {
      for (const node of row) node.classList.remove('ghost-ok', 'ghost-bad')
    }
    // Placement: never preview a plane when fleet is already full (would look like a 4th plane)
    if (
      head &&
      opts.mode === 'own' &&
      opts.dragPlanes &&
      engine.player(opts.playerId).planes.length >= engine.planesPerPlayer
    ) {
      lastGhost = null
      engine.setGhost(null)
      opts.onGhost?.(null)
      return
    }
    lastGhost = head
    if (!head || !opts.ghost) {
      if (!head) engine.setGhost(null)
      opts.onGhost?.(head)
      return
    }
    engine.setGhost(head)
    const cells = engine.getGhostCells()
    const ok = engine.isGhostValid()
    for (const g of cells) {
      if (g.r >= 0 && g.r < engine.gridSize && g.c >= 0 && g.c < engine.gridSize) {
        cellNodes[g.r][g.c].classList.add(ok ? 'ghost-ok' : 'ghost-bad')
      }
    }
    opts.onGhost?.(head)
  }

  const refreshCells = () => {
    const pl = engine.player(opts.playerId)
    for (let r = 0; r < engine.gridSize; r++) {
      for (let c = 0; c < engine.gridSize; c++) {
        const state =
          opts.mode === 'own'
            ? engine.cellDisplayOwn(pl, r, c)
            : engine.cellDisplayEnemy(pl, r, c)
        const cell = cellNodes[r][c]
        const classes = ['cell', state]
        if (!opts.interactive) classes.push('disabled')
        if (opts.mode === 'enemy' && opts.interactive) classes.push('enemy-target')
        if (cell.classList.contains('ghost-ok')) classes.push('ghost-ok')
        if (cell.classList.contains('ghost-bad')) classes.push('ghost-bad')
        if (cell.classList.contains('dragging')) classes.push('dragging')
        cell.className = classes.join(' ')
      }
    }
    if (lastGhost && opts.ghost) paintGhost(lastGhost)
  }

  const coordFromPoint = (clientX: number, clientY: number): Coord | null => {
    const elAt = document.elementFromPoint(clientX, clientY)
    if (!elAt) return null
    const cell = (elAt as HTMLElement).closest?.('.cell') as HTMLElement | null
    if (!cell || !board.contains(cell)) return null
    const r = Number(cell.dataset.r)
    const c = Number(cell.dataset.c)
    if (Number.isNaN(r) || Number.isNaN(c)) return null
    return { r, c }
  }

  // Drag state for placement planes
  let dragActive = false
  let dragMoved = false
  let dragPointerId: number | null = null
  let dragStartCell: Coord | null = null
  let dragMeta: DragMeta | null = null
  let suppressClick = false
  const DRAG_THRESH_PX = 8

  for (let r = 0; r < engine.gridSize; r++) {
    board.appendChild(el('div', { className: 'row-label', text: String(r + 1) }))
    cellNodes[r] = []
    for (let c = 0; c < engine.gridSize; c++) {
      const state =
        opts.mode === 'own'
          ? engine.cellDisplayOwn(player, r, c)
          : engine.cellDisplayEnemy(player, r, c)

      const classes = ['cell', state]
      if (!opts.interactive) classes.push('disabled')
      if (opts.mode === 'enemy' && opts.interactive) classes.push('enemy-target')
      if (opts.dragPlanes && (state === 'plane' || state === 'head')) {
        classes.push('plane-draggable')
      }

      const cell = el('div', {
        className: classes.join(' '),
        role: 'gridcell',
        'data-r': String(r),
        'data-c': String(c),
        'aria-label': `${engine.cols[c]}${r + 1}`,
      })
      cellNodes[r][c] = cell

      if (opts.interactive || opts.ghost) {
        cell.addEventListener('pointerdown', (e: Event) => {
          const pe = e as PointerEvent
          // Ghost preview for empty cells
          if (opts.ghost && !opts.dragPlanes) paintGhost({ r, c })

          if (!opts.dragPlanes || !opts.onDragPlane) return
          const pl = engine.player(opts.playerId)
          const hasPlane = pl.fleet.has(`${r},${c}`)
          if (!hasPlane) {
            if (opts.ghost) paintGhost({ r, c })
            return
          }

          // Start potential drag on a plane cell
          dragActive = true
          dragMoved = false
          dragPointerId = pe.pointerId
          dragStartCell = { r, c }
          dragMeta = null
          suppressClick = false
          try {
            cell.setPointerCapture(pe.pointerId)
          } catch {
            /* ignore */
          }
          board.classList.add('is-dragging')
        })

        cell.addEventListener('pointerenter', () => {
          if (dragActive) return
          if (opts.ghost) paintGhost({ r, c })
        })

        cell.addEventListener('click', (e: Event) => {
          if (suppressClick) {
            e.preventDefault()
            e.stopPropagation()
            suppressClick = false
            return
          }
          opts.onCell?.({ r, c }, cell)
        })
      }
      board.appendChild(cell)
    }
  }

  if (opts.dragPlanes && opts.onDragPlane) {
    const onMove = (e: PointerEvent) => {
      if (!dragActive || e.pointerId !== dragPointerId) return
      const start = dragStartCell
      if (!start) return

      // Threshold before treating as drag (allows tap-to-pick)
      if (!dragMoved) {
        // use movement from first cell center-ish
        const startNode = cellNodes[start.r]?.[start.c]
        if (startNode) {
          const rect = startNode.getBoundingClientRect()
          const dx = e.clientX - (rect.left + rect.width / 2)
          const dy = e.clientY - (rect.top + rect.height / 2)
          if (dx * dx + dy * dy < DRAG_THRESH_PX * DRAG_THRESH_PX) return
        }
        dragMoved = true
        suppressClick = true
        const result = opts.onDragPlane!('start', start)
        if (typeof result !== 'object' || !result.ok) {
          dragActive = false
          dragPointerId = null
          dragStartCell = null
          board.classList.remove('is-dragging')
          return
        }
        dragMeta = { grabOffset: result.grabOffset, origin: result.origin }
      }

      // Prevent page scroll while dragging a plane
      e.preventDefault()
      const under = coordFromPoint(e.clientX, e.clientY)
      if (under && dragMeta) {
        opts.onDragPlane!('move', under, dragMeta)
      }
    }

    const endDrag = (e: PointerEvent, cancelled: boolean) => {
      if (!dragActive || e.pointerId !== dragPointerId) return
      const wasMoved = dragMoved
      const meta = dragMeta
      const start = dragStartCell
      dragActive = false
      dragPointerId = null
      dragStartCell = null
      dragMeta = null
      board.classList.remove('is-dragging')

      if (!wasMoved) {
        // Tap — let click handler pick up / place
        return
      }

      suppressClick = true
      e.preventDefault()
      if (cancelled || !meta) {
        opts.onDragPlane?.('cancel', start, meta ?? undefined)
        return
      }
      const under = coordFromPoint(e.clientX, e.clientY) ?? start
      opts.onDragPlane?.('drop', under, meta)
    }

    board.addEventListener('pointermove', onMove as EventListener, { passive: false })
    board.addEventListener('pointerup', (e) => endDrag(e as PointerEvent, false))
    board.addEventListener('pointercancel', (e) => endDrag(e as PointerEvent, true))
  }

  if (opts.ghost && !opts.stickyGhost) {
    board.addEventListener('pointerleave', () => {
      if (!dragActive) paintGhost(null)
    })
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

  const me =
    engine.mode === 'vs-ai'
      ? 'p1'
      : (myOnlineRole ?? (engine.mode === 'online-join' ? 'p2' : 'p1'))
  const isMyTurn = engine.currentPlayer === me
  const vsAi = engine.mode === 'vs-ai'

  const turnMsg = isMyTurn
    ? engine.message || t('yourTurnAttack')
    : vsAi
      ? t('aiThinking')
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
