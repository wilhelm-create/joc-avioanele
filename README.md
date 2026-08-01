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
data/       users.json (generat local, în .gitignore)
```
