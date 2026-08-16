# Territory — itch.io store page kit

Everything below is ready to paste into your itch.io project page. Edit the voice to taste.

---

## Title
**Territory**

## Short tagline (itch "Short description / tagline" field, ~140 chars)
Leave home, draw a loop, steal the map. A fast paper.io-style land-grab with 9 modes, teams, totems, and one-life battle royale.

## Genre / classification
- **Kind of project:** HTML5 (embed)
- **Genre:** Action / Arcade (.io)
- **Made with:** JavaScript, Node, HTML5 Canvas + Three.js

---

## Full description (paste into the page body)

**Cut a trail. Close the loop. Take the land.**

Territory is a fast, competitive paper.io-style land-grab. Leave your colored home, draw a trail behind you, and loop back to claim everything you enclosed. Cut a rival's trail and you steal their **entire** kingdom — but if anyone touches *your* trail, including you, it's over.

The world is always full: competitive CPU rivals expand, retreat to bank their captures, and hunt your trail with their own personalities, so it never feels empty.

**9 ways to play**
- ♾️ **Classic** — endless land-grab, respawn and keep climbing.
- 👑 **Battle Royale** — one life, a shrinking storm, last one standing wins.
- 🧊 **3D** — the same game from a high top-down 3D view.
- 🤝 **Teams** — 2v2, shared territory, spawn together.
- 🏍️ **Tron** — every trail is a permanent wall; last rider alive wins.
- 💨 **Speed** — everything moves 1.6×.
- 🔬 **Tiny** — a cramped micro-arena; pure chaos.
- 🎯 **Bounty** — cut the #1 player for 5× coins.
- 🎲 **Chaos** — random global events keep you honest.

**Totems** — capture power objects by looping around them: ⚡ Speed (stacking), ✴️ Spreading (grows your land), 🕸️ Slowing (drags down rivals), 🌀 Teleport Gates (warp across the map).

**Progress that sticks** — earn coins from kills and big captures, spend them in the shop on power-ups, skins, and cheats. Sign up for a free account to save your coins, kills, and wins across sessions — or jump in instantly as a guest.

**Controls**
- Steer: Arrow keys / WASD (or swipe on mobile)
- Boost: Shift
- Respawn: Space
- Quick emotes: Z X C V
- Cheats: number keys 1–0

*Heads-up: the first load can take ~30 seconds while the server wakes up. After that it's instant.*

---

## Tags (itch allows up to 10)
`io` `multiplayer` `paper-io` `arcade` `action` `competitive` `browser` `singleplayer` `fast-paced` `territory`

---

## Suggested screenshots to capture from the live game
1. A busy Classic match — lots of colored territories and trails mid-fight.
2. Battle Royale with the purple storm edge closing in.
3. The 3D mode top-down view with raised blocks.
4. A totem being captured (owner-colored ring + icon).
5. The menu with the side leaderboards visible (wide screen).

---

## itch.io upload settings (how to wire it up)

1. Create a new project → **Kind of project: HTML**.
2. Zip **itch-embed.html** (rename it to `index.html` inside the zip) and upload it. Check **"This file will be played in the browser."**
3. **Embed options:**
   - Viewport dimensions: **1280 × 720** (or "Fullscreen"/"Manually set size" to taste).
   - ✅ Fullscreen button
   - ✅ Mobile friendly (Orientation: default)
   - ✅ Automatically start on page load (optional)
4. Upload the **cover image** (`cover.png`, 630×500) and your screenshots.
5. Set pricing to **"No payments / free"** (or "pay what you want").
6. Publish.

**Why the embed?** itch.io serves static files only — it can't run your Node WebSocket server. `itch-embed.html` is a thin wrapper that loads your live game from Render inside an iframe, so multiplayer, accounts, and bots all keep working exactly as they do now.
