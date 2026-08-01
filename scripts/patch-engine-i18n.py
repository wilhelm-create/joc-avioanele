from pathlib import Path

p = Path("src/game/engine.ts")
t = p.read_text(encoding="utf-8")

if "from '../i18n'" not in t:
    t = t.replace(
        "import { GRID, key, PLANES_PER_PLAYER, label } from './types'",
        "import { GRID, key, PLANES_PER_PLAYER, label } from './types'\nimport { t } from '../i18n'",
    )

replacements = [
    (
        "this.message = `${this.p1.name}, plasează cele 3 avioane`",
        "this.message = t('enginePlacing', { name: this.p1.name })",
    ),
    (
        "this.message = 'Așteaptă prietenul…'",
        "this.message = t('preparingRoom')",
    ),
    (
        "this.message = 'Conectare…'",
        "this.message = t('preparingRoom')",
    ),
    (
        "this.message = 'Plasează cele 3 avioane pe grila ta'",
        "this.message = t('enginePlaceOnline')",
    ),
    (
        "this.message = `Avion ${p.planes.length}/${PLANES_PER_PLAYER} plasat. Mai ai ${PLANES_PER_PLAYER - p.planes.length}.`",
        "this.message = t('enginePlanePlaced', { n: p.planes.length, total: PLANES_PER_PLAYER, left: PLANES_PER_PLAYER - p.planes.length })",
    ),
    (
        "this.message = 'Nu am găsit loc liber — încearcă din nou sau roteste manual'",
        "this.message = t('engineNoSpace')",
    ),
    (
        "this.message = 'Grila ștearsă — plasează din nou'",
        "this.message = t('engineGridCleared')",
    ),
    (
        "this.message = 'Flota e gata. Așteaptă adversarul…'",
        "this.message = t('engineFleetReady')",
    ),
    (
        "this.message = `Bătălia începe! Atacă ${this.p1.name}`",
        "this.message = t('engineBattleStart', { name: this.p1.name })",
    ),
    (
        "this.message = who === 'p1' ? 'Gazdă gata — așteaptă oaspetele' : 'Oaspete gata — așteaptă gazda'",
        "this.message = who === 'p1' ? t('engineHostReady') : t('engineGuestReady')",
    ),
    (
        "this.message = 'Ai mai tras aici — alege altă celulă'",
        "this.message = t('engineAlreadyShot')",
    ),
    (
        "this.message = 'Ai mai tras aici'",
        "this.message = t('engineAlreadyHere')",
    ),
    (
        "this.message = `${label(at)} — apă!`",
        "this.message = t('engineMiss', { cell: label(at) })",
    ),
    (
        "this.message = `${label(at)} — CABINĂ! Avion doborât! (${target.planesSunk}/3)`",
        "this.message = t('engineSunk', { cell: label(at), n: target.planesSunk })",
    ),
    (
        "this.message = `${label(at)} — lovit!`",
        "this.message = t('engineHit', { cell: label(at) })",
    ),
    (
        "this.message = `${shooter.name} câștigă! Toate avioanele au fost doborâte.`",
        "this.message = t('engineWin', { name: shooter.name })",
    ),
    (
        "this.message = `Rândul lui ${this.player(this.currentPlayer).name}`",
        "this.message = t('engineTurn', { name: this.player(this.currentPlayer).name })",
    ),
    (
        "this.message = 'Radarul a fost deja folosit'",
        "this.message = t('engineRadarUsed')",
    ),
    (
        "this.message = `Rândul lui ${this.player(this.currentPlayer).name} — atacă!`",
        "this.message = t('engineAttackTurn', { name: this.player(this.currentPlayer).name })",
    ),
]

for old, new in replacements:
    if old not in t:
        print("MISSING:", old[:70])
    else:
        t = t.replace(old, new)
        print("OK:", old[:50])

# radar multi-line
old_radar = """    this.message =
      revealed.length > 0
        ? `📡 Radar: ${revealed.length} zone de apă confirmate!`
        : 'Radar: nu a mai rămas apă necunoscută'"""
new_radar = """    this.message =
      revealed.length > 0
        ? t('engineRadarOk', { n: revealed.length })
        : t('engineRadarEmpty')"""
if old_radar in t:
    t = t.replace(old_radar, new_radar)
    print("OK: radar")
else:
    print("MISSING radar block")

p.write_text(t, encoding="utf-8")
print("done")
