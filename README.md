# Territory — a Paper.io-class game

Authoritative **Node WebSocket server** + a **single-file canvas client**. The
server owns the whole simulation (grid is the source of truth); clients only
send turn intent and render snapshots. 4-direction steering. Bots keep the world
populated so it's never empty.

Built to the structure in the technical blueprint: grid flood-fill capture,
supercover-safe trail collision, server authority (blueprint Phase 2).

---

## Run it locally (test before deploying)

You need **Node 18+**.

```bash
npm install      # installs ws
npm start        # starts the server on http://localhost:3000
```

Then open **http://localhost:3000** in a browser. Open it in several tabs (or on
several devices on your LAN pointed at your machine's IP) to test multiple real
players in one world. Bots fill the rest.

---

## Deploy so 7+ people can play over the internet

This needs a host that runs a **persistent Node process** — NOT static hosting.
GitHub Pages / Netlify static / S3 will NOT work (they can't run a server).

Free hosts that DO work, in rough order of ease:

### Render (free web service)
1. Push this folder to a GitHub repo.
2. On render.com: New → Web Service → connect the repo.
3. Build command: `npm install` · Start command: `node server.js`
4. Render sets `PORT` automatically (the server reads `process.env.PORT`).
5. Share the `https://your-app.onrender.com` URL. (Free tier sleeps when idle
   and takes ~30s to wake on the first visit — fine for casual play.)

### Railway / Glitch / Fly.io
Same idea: point the host at `node server.js`, let it inject `PORT`. On Glitch,
drop the files into a project and it runs automatically.

The client auto-detects `ws://` vs `wss://` from the page protocol, so it works
on both local HTTP and deployed HTTPS with no edits.

---

## Tuning knobs

All at the top of `server.js` (blueprint Section 19 — illustrative defaults):

| Constant         | Default | Meaning                                  |
|------------------|---------|------------------------------------------|
| `GRID_W/H`       | 160     | map size in cells                        |
| `TICK_RATE`      | 15      | server sim ticks per second              |
| `CELLS_PER_SEC`  | 8       | avatar speed                             |
| `ROOM_CAP`       | 24      | max entities (humans + bots) in the room |
| `MIN_BOTS`       | 6       | bots kept alive to populate the world    |
| `SPAWN_SAFE_RADIUS` | 14   | min distance from enemies on spawn       |

Render speed is independent: `CELL_SCREEN` in `index.html` sets pixels per cell.

---

## Ruleset (locked in `server.js`)

- Trail cut: entering any active trail kills that trail's owner.
- Crossing your own trail kills you.
- Safe only in **your own** territory.
- Head-to-head same cell: both die.
- Hitting the map border: death.
- On death: captured territory is **released to neutral**.

## What's NOT in this version (deliberately — blueprint Phase 3+)

- Client-side prediction / reconciliation. The server is authoritative and sends
  full snapshots each tick, so your own turns have one round-trip of latency.
  On a fast host it's barely noticeable; if it bugs you, prediction is the next
  step (blueprint Section 6).
- Multi-room matchmaking, accounts, persistence, IAP/ads. One room, guest play.

## Files

- `server.js` — authoritative sim + HTTP/WS server
- `index.html` — the game client (served by the server at `/`)
- `package.json` — deps + start script
