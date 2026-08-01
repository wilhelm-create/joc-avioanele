# ✈ Avioane — site multiplayer

Jocul clasic de **Avioane** pe grilă 10×10, ca **site web** (nu se instalează ca app).  
Creezi **cont**, te autentifici și joci cu un prieten — pe **telefon, tabletă sau desktop**.

> Culoarea **verde este interzisă** în proiect.

## Funcții

- **Conturi**: înregistrare + login (parolă hash-uită pe server)
- **Pass & play** pe același device
- **Camere online** cu cod (WebSocket pe server)
- **Clasament** victorii / înfrângeri
- **Cookies**: Radar, glitter burst, fanfară victorie
- **Responsive** pe toate viewport-urile

## Pornire (dezvoltare)

```bash
npm install
npm run dev
```

Deschide **http://localhost:5173**  
API + WebSocket: **http://localhost:3000** (proxy din Vite: `/api`, `/ws`).

Copiază `.env.example` → `.env` și setează un `JWT_SECRET` propriu pentru producție.

## Producție

```bash
npm run build
npm start
```

Serverul Express servește `dist/` + API pe `PORT` (default 3000).

## Teste

```bash
npm test
```

## Structură

```
server/     API auth, camere, WebSocket
src/        UI + motor joc
data/       users.json (generat local, în .gitignore)
```
