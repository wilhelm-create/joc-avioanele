# ✈ Avioane — site multiplayer

Jocul clasic de **Avioane** pe grilă 10×10, ca **site web** (nu se instalează ca app).  
Creezi **cont**, te autentifici și joci cu un prieten — pe **telefon, tabletă sau desktop**.

> Culoarea **verde este interzisă** în proiect.

## Funcții

- **Conturi**: înregistrare + login
- **Multiplayer remote**: fiecare pe device-ul lui (telefon / tabletă / PC), de acasă sau de oriunde
- **Invitație prin link + SMS** (chiar dacă prietenul nu e online acum)
- **Deep link** `https://…/?room=COD` → intră direct în cameră după login
- **Clasament**, cookies (radar, glitter, fanfară), fără culoare verde

## Pornire (dezvoltare)

```bash
npm install
npm run dev
```

Deschide **http://localhost:5173**  
API: **http://localhost:3000** (proxy Vite: `/api`). Multiplayer online folosește HTTP polling (compatibil Vercel).

Copiază `.env.example` → `.env` și setează un `JWT_SECRET` propriu pentru producție.

## Deploy

### Vercel
```bash
npx vercel --prod
```
Setează env `JWT_SECRET` în dashboard Vercel (Production).

### Node self-host
```bash
npm run build
npm start
```


## Teste

```bash
npm test
```

## Structură

```
server/     API auth, camere, WebSocket
src/        UI + motor joc
data/       users.json + users.backups/ (local, în .gitignore)
```

## Conturi utilizatori (orice device)

**„Local” nu înseamnă pe telefonul jucătorului.** E doar un cache/backup pe mașina serverului.

| Unde | Rol |
|------|-----|
| **Vercel Blob** (`BLOB_READ_WRITE_TOKEN`) | **Sursa adevărului** — același cont de pe PC, telefon, altă locație |
| Cache pe server (`data/` local sau `/tmp` pe Vercel) | Rezervă dacă Blob e temporar down; **nu** e legat de un device |

Ca să joci de pe alt device: deschizi același site, te autentifici cu **același username + parolă**. Nu trebuie instalat nimic pe device.

Pe Vercel: `BLOB_READ_WRITE_TOKEN` e **obligatoriu** (filesystem-ul deploy-ului e read-only).  
Salvările care ar goli lista de conturi sunt refuzate. `/api/health` arată `users.userCount` + `blobOk`.
