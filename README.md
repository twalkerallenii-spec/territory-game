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
| `ROOM_CAP`       | 28      | max entities (humans + bots) in the room |
| `MIN_BOTS`       | 12      | competitive AI kept alive in the world   |
| `BOT_RESPAWN_MS` | 60000   | bots stay dead 1 min, then auto-respawn  |
| `SPAWN_SAFE_RADIUS` | 14   | min distance from enemies on spawn       |

Render speed is independent: `CELL_SCREEN` in `index.html` sets pixels per cell.

---

## Ruleset (locked in `server.js`)

- Trail cut: entering a rival's active trail kills them — **and you absorb their
  entire territory.**
- Crossing your own trail kills you (land released to neutral).
- Hitting the map border kills you (land released to neutral).
- Safe only in **your own** territory.
- Head-to-head same cell: both die.

## Match flow

- **Endless world.** Live leaderboard, no match timer — the goal is to be the
  top territory holder at any moment.
- **12 competitive AI** fill the world. They expand, retreat to bank captures,
  and aggressively hunt and cut other players' trails (each bot has a randomized
  aggression + greed personality so they don't all behave the same).
- **On death you spectate your killer** (Fortnite-style) and press **SPACE** to
  jump back in instantly. (On mobile, tap to respawn.)
- Bots that die stay down for 1 minute before auto-respawning; human players
  respawn instantly on Space.

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

---

## Repository details (added automatically)

- Repo: twalkerallenii-spec/territory-game
- Repo ID: 1253834233
- Languages (from analysis):
  - HTML: 77.2%
  - JavaScript: 22.8%

Top-level entries (name — size bytes — type):

- .git-revert — 84 — file
- README.md — 4220 — file (this file)
- cover.png — 521755 — file (project cover image)
- index (1).html — 140031 — file (alternate client file)
- index (3).html — 140031 — file (alternate client file)
- index (5).html — 140031 — file (alternate client file)
- index.html — 140031 — file (main single-file canvas client)
- itch-embed.html — 2339 — file (Itch.io embedding helper)
- itch-store-page.md — 3768 — file (store page content for itch)
- package.json — 321 — file (npm manifest; Node >=18; dependency: ws)
- server (1).js — 82889 — file (duplicate/variant of server.js)
- server.js — 82889 — file (authoritative server)

package.json summary:
- name: paperio-class
- version: 1.0.0
- main: server.js
- scripts:
  - start: node server.js
- engines: node >=18
- dependencies: ws ^8.21.0

Notable server.js details (authoritative server implementation):
- Main features: authoritative simulation, single shared room per mode, full
  snapshot broadcast each tick, bots to populate the world, multiple game modes
  (classic, br, teams, tron, speed, tiny, bounty, chaos, 3d).
- Tunable constants at top of file (current values):
  - GRID_W = 160, GRID_H = 160
  - TICK_RATE = 20
  - CELLS_PER_SEC = 13
  - BOOST_MULT = 1.7, BOOST_DURATION_MS = 10000, BOOST_COOLDOWN_MS = 10000
  - ROOM_CAP = 22, MIN_BOTS = 6, BOT_RESPAWN_MS = 120000
  - SPAWN_BLOB = 3, SPAWN_SAFE_RADIUS = 14
- World state stored in typed arrays (Uint8Array): owner, trail, blocked
- RLE encoding used for grid transfer to clients
- Persistent files referenced at runtime: accounts.json, owned-names.json (server reads/writes these at repo root if present)
- Static serving restricted to index.html; other files are not exposed over HTTP by default

Notes & tips:
- Start locally with `npm install` then `npm start` (Node 18+).
- The server expects to run as a persistent process (Render, Railway, Fly.io, Glitch, etc.).
- The repo primarily contains HTML (client) and JS (server) in one-folder layout.

If you want, I can:
- Remove duplicate files (e.g., `server (1).js`, `index (1).html` variants) or
  consolidate them.
- Add a short "Development" section with how to debug / inspect the running
  simulation (e.g., toggling TICK_RATE, logging, or loading the client locally).


