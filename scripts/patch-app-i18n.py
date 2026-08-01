from pathlib import Path

p = Path("src/ui/app.ts")
t = p.read_text(encoding="utf-8")

# import
if "from '../i18n'" not in t:
    t = t.replace(
        "from '../invite/url'",
        "from '../invite/url'\nimport { getLang, onLangChange, setLang, t } from '../i18n'",
    )

# mountApp: init lang listener
old_mount = """export async function mountApp(root: HTMLElement) {
  rootEl = root
  document.body.classList.add('site-body', 'app-shell')
"""
new_mount = """export async function mountApp(root: HTMLElement) {
  rootEl = root
  document.body.classList.add('site-body', 'app-shell')
  onLangChange(() => paint())
"""
if old_mount in t:
    t = t.replace(old_mount, new_mount)

# accept pending invite
t = t.replace(
    "statusNote = `Te conectezi la camera ${code}…`",
    "statusNote = t('connectingRoom', { code })",
)

# handleServer messages
t = t.replace(
    """      statusNote =
        msg.room.players.length < 2
          ? 'Camera e gata. Invită prietenul — el joacă de pe device-ul lui.'
          : `Cameră ${roomCode} · amândoi sunteți conectați`""",
    """      statusNote =
        msg.room.players.length < 2
          ? t('roomReadyInvite')
          : t('roomBothConnected', { code: roomCode })""",
)

t = t.replace(
    "statusNote = 'Prietenul s-a conectat! Fiecare plasează avioanele pe device-ul lui.'",
    "statusNote = t('friendJoined')",
)
t = t.replace(
    "statusNote = 'Adversarul și-a plasat flota. Așteaptă…'",
    "statusNote = t('opponentFleetReady')",
)
t = t.replace(
    """      engine.message =
        myOnlineRole === 'p1'
          ? 'Bătălia începe — e tura ta!'
          : `Bătălia începe — așteaptă ca ${engine.p1.name} să tragă`""",
    """      engine.message =
        myOnlineRole === 'p1'
          ? t('battleStartYou')
          : t('battleStartWait', { name: engine.p1.name })""",
)
t = t.replace(
    "statusNote = 'Adversarul s-a deconectat. Poți invita din nou din lobby.'",
    "statusNote = t('peerLeft')",
)

t = t.replace(
    "return shell(el('div', { className: 'screen center' }, [el('p', { className: 'hint', text: 'Se încarcă…' })]))",
    "return shell(el('div', { className: 'screen center' }, [el('p', { className: 'hint', text: t('loading') })]))",
)

# siteHeader with language toggle
old_header = """function siteHeader(): HTMLElement {
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
}"""

new_header = """function langToggle(): HTMLElement {
  const wrap = el('div', { className: 'lang-toggle', role: 'group', 'aria-label': t('switchLang') })
  for (const lang of ['ro', 'en'] as const) {
    wrap.appendChild(
      el('button', {
        type: 'button',
        className: `lang-btn ${getLang() === lang ? 'active' : ''}`,
        text: lang === 'ro' ? t('langRo') : t('langEn'),
        'data-lang': lang,
        onClick: () => {
          setLang(lang)
          paint()
        },
      }),
    )
  }
  return wrap
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
  }, [el('span', { className: 'brand-mark', text: '✈' }), el('span', { text: t('appName') })])

  const right = el('div', { className: 'header-actions' })
  right.appendChild(langToggle())
  if (currentUser) {
    right.appendChild(
      el('span', {
        className: 'user-chip',
        text: `${currentUser.username} · ${currentUser.wins}W`,
        title: t('yourAccount'),
      }),
    )
    right.appendChild(
      el('button', {
        className: 'btn btn-ghost btn-sm',
        text: t('leaderboard'),
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
  }
  header.append(brand, right)
  return header
}"""

if old_header in t:
    t = t.replace(old_header, new_header)
    print("OK header")
else:
    print("MISSING header")

t = t.replace(
    "el('span', { text: 'Site web · joacă din browser pe telefon, tabletă sau desktop' }),",
    "el('span', { text: t('footer') }),",
)

# bulk simple string replacements for text: fields
simple = {
    "text: '✈ Avioane'": "text: '✈ ' + t('appName')",
    "text: 'Site de joc multiplayer. Creează un cont ca să joci cu prietenii pe orice device.'": "text: t('authTagline')",
    "text: 'Intră în cont'": "text: t('tabLogin')",
    "text: 'Cont nou'": "text: t('tabRegister')",
    "text: 'Username'": "text: t('username')",
    "text: 'Parolă'": "text: t('password')",
    "placeholder: 'username'": "placeholder: t('username')",
    "placeholder: 'parolă (min. 6)'": "placeholder: t('passwordPlaceholder')",
    "text: '📨 Invită un prieten (SMS / link)'": "text: t('inviteFriend')",
    "text: '🔗 Am un cod / link de invitație'": "text: t('haveCode')",
    "statusNote = 'Lipește codul camerei din SMS sau link'": "statusNote = t('pasteCodeHint')",
    "text: 'Clasament'": "text: t('leaderboard')",
    "text: '🍪 Radar o dată / joc'": "text: t('cookieRadar')",
    "text: '🍪 Glitter burst'": "text: t('cookieGlitter')",
    "text: '🍪 Fanfară victorie'": "text: t('cookieFanfare')",
    "statusNote = 'Se pregătește camera de joc…'": "statusNote = t('preparingRoom')",
    "text: 'Link cameră (trimite-l oricui)'": "text: t('inviteLinkLabel')",
    "text: '📋 Copiază link'": "text: t('copyLink')",
    "copyLinkNote = 'Link copiat!'": "copyLinkNote = t('linkCopied')",
    "copyLinkNote = 'Selectează și copiază manual'": "copyLinkNote = t('copyManual')",
    "text: '↗ Share'": "text: t('share')",
    "copyLinkNote = 'Text invitație copiat'": "copyLinkNote = t('inviteTextCopied')",
    "text: 'Invită prin SMS'": "text: t('inviteSmsTitle')",
    "text: 'Chiar dacă prietenul nu e online acum: îi trimiți SMS cu linkul. Când deschide linkul pe device-ul lui, intră direct în cameră.'": "text: t('inviteSmsHint')",
    "text: 'Număr de telefon'": "text: t('phoneNumber')",
    "placeholder: 'ex: +40722123456'": "placeholder: t('phonePlaceholder')",
    "text: '💬 Trimite SMS cu linkul camerei'": "text: t('sendSms')",
    "inviteSmsNote = 'SMS trimis pe server (Twilio).'": "inviteSmsNote = t('smsTwilioSent')",
    "inviteSmsNote = 'S-a deschis aplicația de mesaje — apasă Trimite.'": "inviteSmsNote = t('smsAppOpened')",
    "text: 'Din SMS sau mesaj: deschide linkul, sau introdu codul camerei aici. Joci de pe device-ul tău.'": "text: t('joinFromSms')",
    "text: 'Cod cameră'": "text: t('roomCode')",
    "placeholder: 'ex: K7M2P'": "placeholder: t('roomCodePlaceholder')",
    "text: 'Intră în cameră'": "text: t('enterRoom')",
    "statusNote = 'Cod invalid'": "statusNote = t('invalidCode')",
    "text: 'Anulează / Acasă'": "text: t('cancelHome')",
    "text: 'Flota ta e gata'": "text: t('fleetDoneTitle')",
    "text: '✨ Auto'": "text: t('auto')",
    "text: 'Șterge'": "text: t('clear')",
    "text: 'Cabina (◆) e punctul vulnerabil. Nu predai telefonul — fiecare pe device-ul lui.'": "text: t('cabinHint')",
    "text: 'ture'": "text: t('turns')",
    "text: 'avioane doborâte'": "text: t('planesDown')",
    "text: '🔄 Revanșă'": "text: t('rematch')",
    "text: 'Acasă'": "text: t('home')",
    "text: 'Încă nu sunt jucători pe clasament.'": "text: t('noLeaders')",
    "text: '← Înapoi'": "text: t('back')",
    "statusNote = 'Așteaptă ca prietenul să plaseze flota pe device-ul lui…'": "statusNote = t('waitFriendPlace')",
}

for old, new in simple.items():
    c = t.count(old)
    if c == 0:
        print("MISS:", old[:60])
    else:
        t = t.replace(old, new)
        print(f"OK x{c}:", old[:40])

# auth titles
t = t.replace(
    "const title = authMode === 'login' ? 'Autentificare' : 'Creează cont'",
    "const title = authMode === 'login' ? t('authTitleLogin') : t('authTitleRegister')",
)
t = t.replace(
    "text: authBusy ? 'Se procesează…' : authMode === 'login' ? 'Intră' : 'Înregistrează-te',",
    "text: authBusy ? t('processing') : authMode === 'login' ? t('btnLogin') : t('btnRegister'),",
)
t = t.replace(
    "text: `Ai fost invitat în camera ${pendingInviteCode}. Autentifică-te ca să intri.`,",
    "text: t('inviteBanner', { code: pendingInviteCode }),",
)

# home hello
t = t.replace(
    "text: `Salut, ${u.username}! Invită un prieten — el joacă de pe device-ul lui, de acasă sau de oriunde.`,",
    "text: t('hello', { name: u.username }),",
)
t = t.replace("statCard(String(u.wins), 'victorii')", "statCard(String(u.wins), t('wins'))")
t = t.replace("statCard(String(u.losses), 'înfrângeri')", "statCard(String(u.losses), t('losses'))")
t = t.replace("statCard(String(u.gamesPlayed), 'meciuri')", "statCard(String(u.gamesPlayed), t('games'))")

# lobby strings
t = t.replace(
    """        text: isHostLobby
          ? 'Camera e gata. Prietenul joacă de pe telefonul/tableta/PC-ul lui — nu îi dai device-ul tău.'
          : 'Ești în cameră. Așteaptă gazda și pregătirea partidei…',""",
    """        text: isHostLobby
          ? t('lobbyHostHint')
          : t('lobbyGuestHint'),""",
)

t = t.replace(
    "title: 'Avioane — invitație'",
    "title: t('shareTitle')",
)

t = t.replace(
    """            text: `${p.role === 'p1' ? '① Gazdă' : '② Oaspete'}: ${p.username}${p.ready ? ' ✓ flota gata' : ' …'}`,""",
    """            text: `${p.role === 'p1' ? t('hostLabel') : t('guestLabel')}: ${p.username}${p.ready ? t('fleetReady') : t('waitingDots')}`,""",
)

t = t.replace(
    """          roomInfo!.players.length < 2
            ? '⏳ Așteaptă ca prietenul să deschidă linkul pe device-ul lui…'
            : '✅ Amândoi sunteți online — începe plasarea!',""",
    """          roomInfo!.players.length < 2
            ? t('waitingFriendOpen')
            : t('bothOnline'),""",
)

t = t.replace(
    "text: statusNote || 'Se încarcă lobby-ul…'",
    "text: statusNote || t('lobbyLoading')",
)

t = t.replace(
    "el('h2', { text: isHostLobby ? 'Invită & așteaptă' : 'Intră în cameră' }),",
    "el('h2', { text: isHostLobby ? t('lobbyInviteTitle') : t('lobbyJoinTitle') }),",
)

t = t.replace(
    "text: engine.message || 'Așteaptă ca prietenul să termine plasarea pe device-ul lui…',",
    "text: engine.message || t('fleetDoneHint'),",
)
t = t.replace(
    "text: statusNote || 'Nu trebuie să predai telefonul — aștepți online.'",
    "text: statusNote || t('noHandoffWait')",
)

t = t.replace(
    "el('span', { text: `${p.name} — flota ta ${p.planes.length}/${PLANES_PER_PLAYER}` }),",
    "el('span', { text: `${p.name} — ${t('yourFleet')} ${p.planes.length}/${PLANES_PER_PLAYER}` }),",
)
t = t.replace(
    "text: engine.message || 'Plasează cele 3 avioane pe grila TA. Prietenul face la fel pe device-ul lui.',",
    "text: engine.message || t('placeBanner'),",
)
t = t.replace(
    "text: `🔄 Rotește (${engine.placeOrientation}°)`,",
    "text: t('rotate', { deg: engine.placeOrientation }),",
)

# battle
t = t.replace(
    """  const turnMsg = isMyTurn
    ? engine.message || 'E tura ta — atacă grila adversarului!'
    : `Așteaptă — joacă ${engine.player(engine.currentPlayer).name} de pe device-ul lui…`""",
    """  const turnMsg = isMyTurn
    ? engine.message || t('yourTurnAttack')
    : t('waitPlayer', { name: engine.player(engine.currentPlayer).name })""",
)
t = t.replace(
    "text: isMyTurn ? 'Tura ta' : `Tura: ${engine.player(engine.currentPlayer).name}`,",
    "text: isMyTurn ? t('yourTurn') : t('turnOf', { name: engine.player(engine.currentPlayer).name }),",
)
t = t.replace(
    "text: `Tur ${engine.turn} · Doborâte de tine: ${engine.opponent(me).planesSunk}/3`,",
    "text: t('turnCount', { turn: engine.turn, sunk: engine.opponent(me).planesSunk }),",
)
t = t.replace(
    "title: isMyTurn ? 'Țintă — atacă aici' : 'Țintă (așteaptă tura ta)',",
    "title: isMyTurn ? t('attackHere') : t('targetWait'),",
)
t = t.replace(
    "title: 'Flota ta',",
    "title: t('yourFleetBoard'),",
)
t = t.replace(
    "text: myPlayer.radarUsed ? '📡 Radar folosit' : '📡 Radar (cookie)',",
    "text: myPlayer.radarUsed ? t('radarUsed') : t('radarCookie'),",
)

t = t.replace(
    "el('h2', { text: winner ? `${winner.name} câștigă!` : 'Joc terminat' }),",
    "el('h2', { text: winner ? t('winsTitle', { name: winner.name }) : t('gameOver') }),",
)
t = t.replace(
    "el('h2', { text: 'Clasament' }),",
    "el('h2', { text: t('leaderboard') }),",
)
t = t.replace(
    "text: `${i + 1}. ${u.username} — ${u.wins}W / ${u.losses}L (${u.gamesPlayed} jocuri)`,",
    "text: t('leaderLine', { rank: i + 1, name: u.username, wins: u.wins, losses: u.losses, games: u.gamesPlayed }),",
)

# aria labels
t = t.replace("'aria-label': 'Username'", "'aria-label': t('username')")
t = t.replace("'aria-label': 'Parolă'", "'aria-label': t('password')")
t = t.replace("'aria-label': 'Link invitație'", "'aria-label': t('inviteLinkLabel')")
t = t.replace("'aria-label': 'Număr telefon prieten'", "'aria-label': t('phoneNumber')")
t = t.replace("'aria-label': 'Cod cameră'", "'aria-label': t('roomCode')")

p.write_text(t, encoding="utf-8")
print("app.ts written")
