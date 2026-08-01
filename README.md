# ✈ Avioane — Joc cu Prieteni

Jocul clasic românesc de **Avioane** pe grilă 10×10, optimizat pentru **mobil Android** (PWA instalabilă). Joacă pe același telefon (pass & play) sau **online** cu un prieten prin cod de cameră.

> **Regulă de design:** culoarea **verde este interzisă** în tot proiectul.

## Cum se joacă

1. Fiecare jucător plasează **3 avioane** (formă clasică, 10 celule, cabină roz ◆).
2. Pe rând, ataci grila adversarului.
3. **Lovit** = corp de avion · **Apă** = ratat · **Cabină** = avionul e **doborât** integral.
4. Cine doboară toate cele 3 avioane adversarului câștigă.

## Moduri multiplayer

| Mod | Descriere |
|-----|-----------|
| **Același telefon** | Pass & play — ecran intermediar ca să nu vă uitați pe grila celuilalt |
| **Cameră online** | Gazdă creează cod de 5 caractere; oaspetele intră cu codul (WebRTC via PeerJS) |

## 🍪 3 cookies surpriză

1. **📡 Radar** — o dată pe jucător / joc, dezvăluie până la 5 zone de apă pe grila inamică (nu consumă tura).
2. **✨ Glitter burst** — particule tip spumă sclipitoare (violet / portocaliu / amber, fără verde) la lovituri și doborâri + vibrație pe Android.
3. **🏆 Fanfară de victorie** — melodie Web Audio + confetti + ecran de trofeu cu statistici și revanșă.

Bonus utilitar: butonul **Auto** plasează flota rămase aleator.

## Rulează local

```bash
npm install
npm run dev
```

Deschide pe telefon (același Wi‑Fi): adresa afișată de Vite (`Network`).

### Instalare pe Android

1. Deschide site-ul în **Chrome**.
2. Meniu → **Instalează aplicația** / **Add to Home screen**.
3. Pornește din iconița de pe ecranul principal (mod standalone, fără bară de browser).

### Build producție

```bash
npm run build
npm run preview
```

Fișierele din `dist/` pot fi hostate pe orice static host (Netlify, Vercel, GitHub Pages, Firebase Hosting etc.).

## Teste

```bash
npm test                 # motor + usability e2e
npm run test:engine      # logică joc (fără browser)
npm run test:usability   # Playwright pe viewport Pixel 7
```

Suite-ul de utilizare verifică: navigare, plasare, rotație, auto-place, bătălie, radar, victorie, touch targets ≥44px, **absența culorii verde**, flux online host.

## Structură

```
src/
  game/          # reguli, formă avion, motor
  multiplayer/   # PeerJS online
  cookies/       # efecte sonore, glitter, haptic
  ui/            # ecrane mobile-first
tests/           # Playwright usability
```

## Paletă (fără verde)

Violet `#a78bfa` · Portocaliu `#fb923c` · Amber `#fbbf24` · Roz cabină `#f472b6` · Apă albastră `#3b82f6` · Fundal midnight `#0d0a1f`.
