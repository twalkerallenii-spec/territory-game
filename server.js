// ============================================================================
// PAPER.IO-CLASS GAME — AUTHORITATIVE SERVER
// Node + ws. One room. Grid is the source of truth. Clients send turn intent,
// server runs the whole sim and broadcasts state. (Blueprint Phase 2.)
// ============================================================================
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

// ---- TUNABLE KNOBS (Blueprint Sec 19 — illustrative defaults) --------------
const GRID_W = 160;
const GRID_H = 160;
const TICK_RATE = 15;                 // sim ticks per second
const CELLS_PER_SEC = 8;              // avatar speed
const ROOM_CAP = 24;                  // max entities (humans + bots)
const MIN_BOTS = 6;                   // keep world populated
const SPAWN_BLOB = 3;                 // half-size of starting square (3 => 7x7)
const SPAWN_SAFE_RADIUS = 14;         // min cells to nearest enemy avatar/trail
const RESPAWN_DELAY_MS = 1500;
const PORT = process.env.PORT || 3000;

const CELL_PER_TICK = CELLS_PER_SEC / TICK_RATE;

// Distinct, readable colors for up to ROOM_CAP entities.
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0',
  '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324',
  '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1', '#000075',
  '#a9a9a9', '#ff6f61', '#6b5b95', '#88b04b', '#92a8d1', '#955251',
];

// ---- WORLD STATE -----------------------------------------------------------
// owner: 0 = neutral, else entity id. trail: 0 = none, else entity id.
const owner = new Uint8Array(GRID_W * GRID_H);
const trail = new Uint8Array(GRID_W * GRID_H);
const idx = (x, y) => y * GRID_W + x;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;

const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };

let nextId = 1;                       // entity ids; 0 reserved for neutral
const entities = new Map();           // id -> entity

function freeColor() {
  const used = new Set([...entities.values()].map(e => e.color));
  for (const c of PALETTE) if (!used.has(c)) return c;
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

// ---- SPAWNING (Blueprint Sec 5C) -------------------------------------------
function distToNearestEnemy(cx, cy, selfId) {
  let best = Infinity;
  for (const e of entities.values()) {
    if (e.id === selfId || e.dead) continue;
    const d = Math.abs(e.cx - cx) + Math.abs(e.cy - cy);
    if (d < best) best = d;
  }
  return best;
}

function findSpawn(selfId) {
  for (let tries = 0; tries < 200; tries++) {
    const cx = SPAWN_BLOB + 2 + Math.floor(Math.random() * (GRID_W - 2 * SPAWN_BLOB - 4));
    const cy = SPAWN_BLOB + 2 + Math.floor(Math.random() * (GRID_H - 2 * SPAWN_BLOB - 4));
    // blob must be neutral
    let ok = true;
    for (let y = cy - SPAWN_BLOB; y <= cy + SPAWN_BLOB && ok; y++)
      for (let x = cx - SPAWN_BLOB; x <= cx + SPAWN_BLOB; x++)
        if (owner[idx(x, y)] !== 0) { ok = false; break; }
    if (!ok) continue;
    if (distToNearestEnemy(cx, cy, selfId) < SPAWN_SAFE_RADIUS) continue;
    return { cx, cy };
  }
  // fallback: anywhere central-ish
  return { cx: Math.floor(GRID_W / 2), cy: Math.floor(GRID_H / 2) };
}

function headingTowardCenter(cx, cy) {
  // Point the avatar at the map interior so a fresh spawn never walks straight
  // into the border (and can't be forced to wall-die before its first turn).
  const dx = (GRID_W / 2) - cx, dy = (GRID_H / 2) - cy;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
}

function paintSpawnBlob(e) {
  for (let y = e.cy - SPAWN_BLOB; y <= e.cy + SPAWN_BLOB; y++)
    for (let x = e.cx - SPAWN_BLOB; x <= e.cx + SPAWN_BLOB; x++)
      if (inBounds(x, y)) owner[idx(x, y)] = e.id;
}

function spawnEntity({ isBot, name }) {
  const id = nextId++;
  const { cx, cy } = findSpawn(id);
  const e = {
    id, isBot, name: name || (isBot ? 'Bot ' + id : 'Player ' + id),
    color: freeColor(),
    cx, cy,
    px: cx + 0.5, py: cy + 0.5,        // continuous position (Blueprint Sec 1)
    heading: headingTowardCenter(cx, cy),
    pendingTurn: null,
    isOutside: false,
    trailCells: [],
    area: 0,
    dead: false,
    respawnAt: 0,
    ws: null,
  };
  entities.set(id, e);
  paintSpawnBlob(e);
  recomputeArea(e);
  return e;
}

function clearEntityFromGrid(e) {
  // Release territory to neutral + clear active trail (Blueprint Sec 3B).
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === e.id) owner[i] = 0;
    if (trail[i] === e.id) trail[i] = 0;
  }
  e.trailCells.length = 0;
  e.isOutside = false;
}

function recomputeArea(e) {
  let n = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] === e.id) n++;
  e.area = n;
}

// ---- DEATH (Blueprint Sec 3B) ----------------------------------------------
function killEntity(e, reason) {
  if (e.dead) return;
  e.dead = true;
  e.respawnAt = Date.now() + RESPAWN_DELAY_MS;
  clearEntityFromGrid(e);
  e.area = 0;
  if (e.ws && e.ws.readyState === 1) {
    send(e.ws, { t: 'death', reason });
  }
}

// ---- CAPTURE: inverse flood fill (Blueprint Sec 2A) ------------------------
// Bounding-box optimized: only consider the box covering this player's
// territory + trail, padded by 1.
function captureTerritory(e) {
  if (e.trailCells.length === 0) return;

  let minX = GRID_W, minY = GRID_H, maxX = 0, maxY = 0;
  const expand = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === e.id || trail[i] === e.id) {
      expand(i % GRID_W, (i / GRID_W) | 0);
    }
  }
  minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1);
  maxX = Math.min(GRID_W - 1, maxX + 1); maxY = Math.min(GRID_H - 1, maxY + 1);

  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  // mark: 0 unknown, 1 barrier (mine), 2 outside
  const mark = new Uint8Array(bw * bh);
  const bi = (x, y) => (y - minY) * bw + (x - minX);

  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const i = idx(x, y);
      if (owner[i] === e.id || trail[i] === e.id) mark[bi(x, y)] = 1;
    }

  // Flood OUTSIDE inward from the box border through non-barrier cells.
  const stack = [];
  for (let x = minX; x <= maxX; x++) {
    for (const y of [minY, maxY]) {
      const m = bi(x, y);
      if (mark[m] === 0) { mark[m] = 2; stack.push(x, y); }
    }
  }
  for (let y = minY; y <= maxY; y++) {
    for (const x of [minX, maxX]) {
      const m = bi(x, y);
      if (mark[m] === 0) { mark[m] = 2; stack.push(x, y); }
    }
  }
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    const nb = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of nb) {
      if (nx < minX || ny < minY || nx > maxX || ny > maxY) continue;
      const m = bi(nx, ny);
      if (mark[m] === 0) { mark[m] = 2; stack.push(nx, ny); }
    }
  }

  // Anything still unknown is enclosed -> capture. Also capture trail cells.
  const touchedEnemies = new Set();
  for (let y = minY; y <= maxY; y++)
    for (let x = minX; x <= maxX; x++) {
      const i = idx(x, y);
      const enclosed = mark[bi(x, y)] === 0;
      if (enclosed || trail[i] === e.id) {
        const prev = owner[i];
        if (prev !== 0 && prev !== e.id) touchedEnemies.add(prev);
        owner[i] = e.id;
        trail[i] = 0;
      }
    }

  e.trailCells.length = 0;
  e.isOutside = false;
  recomputeArea(e);

  // Enemies who lost land: recompute; zero-territory rule => keep playing
  // (their avatar persists), matching the "release to neutral" fairness choice.
  for (const enemyId of touchedEnemies) {
    const enemy = entities.get(enemyId);
    if (enemy) recomputeArea(enemy);
  }
}

// ---- LOGICAL STEP into a new cell (Blueprint Sec 3A) -----------------------
function enterCell(e, x, y) {
  if (!inBounds(x, y)) { killEntity(e, 'wall'); return; }   // RULE 5
  const i = idx(x, y);

  // Stepping onto ANY active trail kills that trail's owner (RULE 1 & 2).
  const tOwner = trail[i];
  if (tOwner !== 0) {
    const victim = entities.get(tOwner);
    if (victim) killEntity(victim, victim.id === e.id ? 'self' : 'cut');
    if (e.dead) return;  // self-cut: we just died
  }

  e.cx = x; e.cy = y;

  if (owner[i] === e.id) {
    // Back home: close the loop.
    if (e.isOutside && e.trailCells.length > 0) {
      captureTerritory(e);
    }
    e.isOutside = false;
  } else {
    // Outside our own land: lay trail.
    e.isOutside = true;
    trail[i] = e.id;
    e.trailCells.push(i);
  }
}

// Supercover march from one cell to an adjacent cell. For 4-dir movement the
// step is always exactly one cell, but we keep this explicit for clarity and
// to guard against future speed changes (Blueprint Sec 3C anti-tunneling).
function advance(e) {
  if (e.dead) return;
  const [dx, dy] = DIRS[e.heading];
  e.px += dx * CELL_PER_TICK;
  e.py += dy * CELL_PER_TICK;

  // Has the continuous position crossed into a new cell center?
  const ncx = Math.floor(e.px);
  const ncy = Math.floor(e.py);
  if (ncx !== e.cx || ncy !== e.cy) {
    // Apply a queued turn only when aligned to the grid (Blueprint Sec 4A).
    if (e.pendingTurn && e.pendingTurn !== OPP[e.heading]) {
      e.heading = e.pendingTurn;
    }
    e.pendingTurn = null;
    enterCell(e, ncx, ncy);
    // re-center continuous pos to the new cell to keep turns axis-aligned
    if (!e.dead) { e.px = e.cx + 0.5; e.py = e.cy + 0.5; }
  }
}

// ---- BOT BRAIN (Blueprint Sec 1/Phase 1 FSM, lightweight) ------------------
function botThink(e) {
  if (e.dead) return;
  const [dx, dy] = DIRS[e.heading];
  const ahead = [e.cx + dx, e.cy + dy];

  // Retreat as exposure grows (Blueprint Sec 19 threatExposure).
  const exposure = e.trailCells.length;
  const wantHome = exposure > 18 + Math.random() * 20;

  const dangerAhead =
    !inBounds(ahead[0], ahead[1]) ||
    trail[idx(Math.max(0, Math.min(GRID_W - 1, ahead[0])),
              Math.max(0, Math.min(GRID_H - 1, ahead[1])))] === e.id;

  if (dangerAhead || (wantHome && Math.random() < 0.25) || Math.random() < 0.05) {
    const opts = ['N', 'E', 'S', 'W'].filter(d => d !== OPP[e.heading] && d !== e.heading);
    // bias toward owned territory when wanting home
    if (wantHome) {
      opts.sort(() => Math.random() - 0.5);
      for (const d of opts) {
        const [tx, ty] = DIRS[d];
        const nx = e.cx + tx, ny = e.cy + ty;
        if (inBounds(nx, ny) && owner[idx(nx, ny)] === e.id) { e.pendingTurn = d; return; }
      }
    }
    e.pendingTurn = opts[Math.floor(Math.random() * opts.length)];
  }
}

// ---- SIM TICK --------------------------------------------------------------
function maintainBots() {
  const alive = [...entities.values()].filter(e => !e.dead);
  const bots = alive.filter(e => e.isBot).length;
  const humansAndBots = entities.size;
  let need = MIN_BOTS - bots;
  while (need-- > 0 && humansAndBots + 1 <= ROOM_CAP) {
    spawnEntity({ isBot: true });
  }
}

function tick() {
  const now = Date.now();

  // respawns
  for (const e of entities.values()) {
    if (e.dead && now >= e.respawnAt) {
      if (e.isBot && entities.size > ROOM_CAP) { entities.delete(e.id); continue; }
      const { cx, cy } = findSpawn(e.id);
      e.cx = cx; e.cy = cy; e.px = cx + 0.5; e.py = cy + 0.5;
      e.heading = headingTowardCenter(cx, cy);
      e.pendingTurn = null; e.isOutside = false; e.trailCells.length = 0;
      e.dead = false;
      paintSpawnBlob(e); recomputeArea(e);
      if (e.ws && e.ws.readyState === 1) send(e.ws, { t: 'respawn', id: e.id });
    }
  }

  for (const e of entities.values()) if (e.isBot) botThink(e);
  for (const e of entities.values()) advance(e);

  maintainBots();
  broadcastState();
}

// ---- NETWORKING ------------------------------------------------------------
// Full-state snapshot each tick (Phase 2 — no deltas/prediction yet). The grid
// is RLE-encoded to keep payloads small; entity state is tiny.
function rleEncode(arr) {
  const out = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i]; let run = 1;
    while (i + run < arr.length && arr[i + run] === v && run < 65535) run++;
    out.push(v, run);
    i += run;
  }
  return out;
}

function broadcastState() {
  const ents = [];
  for (const e of entities.values()) {
    ents.push({
      id: e.id, n: e.name, c: e.color, b: e.isBot ? 1 : 0,
      x: +e.px.toFixed(2), y: +e.py.toFixed(2), h: e.heading,
      o: e.isOutside ? 1 : 0, a: e.area, d: e.dead ? 1 : 0,
    });
  }
  const msg = JSON.stringify({
    t: 'state',
    w: GRID_W, h: GRID_H,
    owner: rleEncode(owner),
    trail: rleEncode(trail),
    ents,
  });
  for (const e of entities.values()) {
    if (e.ws && e.ws.readyState === 1) e.ws.send(msg);
  }
}

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }

// ---- HTTP (serves the client) + WS -----------------------------------------
const server = http.createServer((req, res) => {
  let p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(__dirname, p);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const mime = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  if ([...entities.values()].filter(e => !e.isBot).length + 1 > ROOM_CAP) {
    send(ws, { t: 'full' });
    ws.close();
    return;
  }
  let player = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }

    if (m.t === 'join') {
      const name = ('' + (m.name || 'Player')).slice(0, 16) || 'Player';
      player = spawnEntity({ isBot: false, name });
      player.ws = ws;
      send(ws, { t: 'welcome', id: player.id, w: GRID_W, h: GRID_H });
    } else if (m.t === 'turn' && player && !player.dead) {
      if (['N', 'E', 'S', 'W'].includes(m.d)) player.pendingTurn = m.d;  // intent only
    }
  });

  ws.on('close', () => {
    if (player) { clearEntityFromGrid(player); entities.delete(player.id); }
  });
});

// seed initial bots
for (let i = 0; i < MIN_BOTS; i++) spawnEntity({ isBot: true });

setInterval(tick, 1000 / TICK_RATE);
server.listen(PORT, () => {
  console.log(`Paper.io-class server on http://localhost:${PORT}  (${TICK_RATE} ticks/s, grid ${GRID_W}x${GRID_H})`);
});
