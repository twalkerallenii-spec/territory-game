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
const TICK_RATE = 20;                 // sim ticks per second (was 15 — smoother)
const CELLS_PER_SEC = 13;             // base avatar speed (was 8 — faster game)
const BOOST_MULT = 1.7;               // active speed-boost multiplier
const BOOST_DURATION_MS = 10000;      // boost lasts 10s
const BOOST_COOLDOWN_MS = 10000;      // then 10s to recharge
const ROOM_CAP = 22;                  // max entities (humans + bots)
const MIN_BOTS = 6;                   // CPU field (was 12)
const SPAWN_BLOB = 3;                 // half-size of starting square (3 => 7x7)
const SPAWN_SAFE_RADIUS = 14;         // min cells to nearest enemy avatar/trail
const BOT_RESPAWN_MS = 120000;        // bots stay dead 2 minutes before auto-respawn
const PLAYER_MIN_DEAD_MS = 0;         // humans respawn instantly on Space press
const COIN_PER_KILL = 20;             // coins for cutting a rival
const COIN_FULL_MAP = 1000;           // coins for controlling 100% of the map
const PORT = process.env.PORT || 3000;

const CELL_PER_TICK = CELLS_PER_SEC / TICK_RATE;

// Distinct, saturated colors that read clearly on a white paper background.
// 36 hand-picked hues — more than ROOM_CAP, so no two live players ever share.
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#1ba3a3',
  '#f032e6', '#9bb800', '#e8762a', '#008080', '#a05bd6', '#9a6324',
  '#c79a00', '#d11141', '#2a9d4a', '#5a6e00', '#c2691f', '#000075',
  '#6b5b95', '#88154b', '#1f7a8c', '#b03a2e', '#2874a6', '#7d3c98',
  '#cb4335', '#117864', '#b9770e', '#4a235a', '#1e6091', '#d4661a',
  '#7a1fa2', '#2e8b57', '#c2185b', '#5d4037', '#00838f', '#827717',
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

// Strictly unique color per live entity: pick an unused palette color at random;
// if the palette is somehow exhausted, synthesize a distinct HSL hue.
function freeColor() {
  const used = new Set([...entities.values()].map(e => e.color));
  const avail = PALETTE.filter(c => !used.has(c));
  if (avail.length) return avail[(Math.random() * avail.length) | 0];
  // fallback: spin the hue wheel until we land on an unused color
  for (let k = 0; k < 360; k++) {
    const hue = (k * 47) % 360;                    // 47 is coprime-ish to 360
    const c = `hsl(${hue},70%,45%)`;
    if (!used.has(c)) return c;
  }
  return `hsl(${(Math.random() * 360) | 0},70%,45%)`;
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

function findSpawn(selfId, blob) {
  const B = blob || SPAWN_BLOB;
  const M = 2;  // neutral margin around the spawn blob
  for (let tries = 0; tries < 300; tries++) {
    const cx = B + M + 1 + Math.floor(Math.random() * (GRID_W - 2 * (B + M) - 2));
    const cy = B + M + 1 + Math.floor(Math.random() * (GRID_H - 2 * (B + M) - 2));
    // blob + margin must be entirely neutral (never spawn inside or touching land)
    let ok = true;
    for (let y = cy - B - M; y <= cy + B + M && ok; y++)
      for (let x = cx - B - M; x <= cx + B + M; x++) {
        if (!inBounds(x, y) || owner[idx(x, y)] !== 0) { ok = false; break; }
      }
    if (!ok) continue;
    if (distToNearestEnemy(cx, cy, selfId) < SPAWN_SAFE_RADIUS) continue;
    return { cx, cy };
  }
  // relaxed fallback 1: blob itself must be neutral (drop the safety radius)
  for (let tries = 0; tries < 400; tries++) {
    const cx = B + 1 + Math.floor(Math.random() * (GRID_W - 2 * B - 2));
    const cy = B + 1 + Math.floor(Math.random() * (GRID_H - 2 * B - 2));
    let ok = true;
    for (let y = cy - B; y <= cy + B && ok; y++)
      for (let x = cx - B; x <= cx + B; x++)
        if (!inBounds(x, y) || owner[idx(x, y)] !== 0) { ok = false; break; }
    if (ok) return { cx, cy };
  }
  // fallback 2: exhaustive scan for ANY fully-neutral blob (guarantees we never
  // spawn inside someone's territory as long as one empty spot exists)
  for (let cy = B + 1; cy < GRID_H - B - 1; cy++) {
    for (let cx = B + 1; cx < GRID_W - B - 1; cx++) {
      let ok = true;
      for (let y = cy - B; y <= cy + B && ok; y++)
        for (let x = cx - B; x <= cx + B; x++)
          if (owner[idx(x, y)] !== 0) { ok = false; break; }
      if (ok) return { cx, cy };
    }
  }
  // last resort (map essentially full): center, and clear a small patch
  const cx = Math.floor(GRID_W / 2), cy = Math.floor(GRID_H / 2);
  for (let y = cy - B; y <= cy + B; y++)
    for (let x = cx - B; x <= cx + B; x++)
      if (inBounds(x, y)) owner[idx(x, y)] = 0;
  return { cx, cy };
}

function headingTowardCenter(cx, cy) {
  // Point the avatar at the map interior so a fresh spawn never walks straight
  // into the border (and can't be forced to wall-die before its first turn).
  const dx = (GRID_W / 2) - cx, dy = (GRID_H / 2) - cy;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
}

function paintSpawnBlob(e) {
  const B = e.blob || SPAWN_BLOB;
  for (let y = e.cy - B; y <= e.cy + B; y++)
    for (let x = e.cx - B; x <= e.cx + B; x++)
      if (inBounds(x, y)) owner[idx(x, y)] = e.id;
}

// Exactly 12 fixed bot names (one per bot in the default field).
const BOT_NAMES = [
  'Aymeric', 'Boris', 'Vincent', 'Helga', 'Mateo', 'Priya',
  'Søren', 'Akira', 'Olga', 'Diego', 'Freya', 'Tariq',
];
let botNameCursor = 0;
function nextBotName() {
  const used = new Set([...entities.values()].filter(e => e.isBot).map(e => e.name));
  for (let k = 0; k < BOT_NAMES.length; k++) {
    const n = BOT_NAMES[(botNameCursor + k) % BOT_NAMES.length];
    if (!used.has(n)) { botNameCursor = (botNameCursor + k + 1) % BOT_NAMES.length; return n; }
  }
  return BOT_NAMES[(botNameCursor++) % BOT_NAMES.length];
}

// Power-up effects the server enforces. Loadout comes from the client on join;
// validated against this whitelist so a hacked client can't invent effects.
// 'boost' is the rechargeable active speed boost (tap to use). Others are passive.
const POWERUPS = {
  boost:  { hasBoost: true },     // tap to go fast 10s, 10s cooldown
  big:    { sizeMult: 1.7 },      // bigger character
  zoom:   { zoomOut: true },      // client renders a wider view
  head:   { startBlob: 5 },       // bigger starting territory
  magnet: { coinMult: 1.5 },      // client-side coin bonus
  shield: { shieldMs: 4000 },     // spawn protection (server-enforced)
  phase:  { phaseTrail: true },   // your trail is slightly shorter-lived (cosmetic-ish)
  rich:   { startCoins: true },   // client grants bonus coins on join
  swift:  { turnPrio: true },     // queue turns a touch earlier (handled client/animation)
  guard:  { shieldMs: 2500 },     // shorter shield variant
};

function spawnEntity({ isBot, name, loadout, mode }) {
  const id = nextId++;
  // Bigger starting blob if the "head start" power-up is equipped.
  const lo = sanitizeLoadout(loadout);
  const blob = lo.includes('head') ? POWERUPS.head.startBlob : SPAWN_BLOB;
  const { cx, cy } = findSpawn(id, blob);
  const shieldMs = lo.includes('shield') ? POWERUPS.shield.shieldMs
                 : lo.includes('guard') ? POWERUPS.guard.shieldMs : 0;
  const e = {
    id, isBot, name: name || (isBot ? nextBotName() : 'Player ' + id),
    color: freeColor(),
    cx, cy, blob,
    mode: mode === 'br' ? 'br' : 'classic',
    px: cx + 0.5, py: cy + 0.5,        // continuous position (Blueprint Sec 1)
    heading: headingTowardCenter(cx, cy),
    pendingTurn: null,
    isOutside: false,
    trailCells: [],
    area: 0,
    dead: false,
    eliminated: false,                 // battle-royale: out for good
    respawnAt: 0,
    killerId: 0,
    kills: 0,
    loadout: lo,
    sizeMult: lo.includes('big') ? POWERUPS.big.sizeMult : 1,
    // rechargeable boost state
    hasBoost: lo.includes('boost'),
    boosting: false,
    boostUntil: 0,
    boostReadyAt: 0,
    // spawn shield
    shieldUntil: shieldMs ? Date.now() + shieldMs : 0,
    // bot personality (varies behavior so 12 AI don't act identically)
    botAggro: isBot ? 0.3 + Math.random() * 0.6 : 0,   // willingness to hunt trails
    botGreed: isBot ? 12 + Math.random() * 28 : 0,      // trail length before retreating
    botTarget: null,
    ws: null,
  };
  entities.set(id, e);
  paintSpawnBlob(e);
  recomputeArea(e);
  return e;
}

function sanitizeLoadout(loadout) {
  if (!Array.isArray(loadout)) return [];
  const valid = Object.keys(POWERUPS);
  return [...new Set(loadout)].filter(p => valid.includes(p)).slice(0, 6);
}

function clearTrail(e) {
  // Remove only the active trail (used when transferring territory to a killer,
  // since the dead player's trail should never persist).
  for (const i of e.trailCells) if (trail[i] === e.id) trail[i] = 0;
  // Defensive sweep in case trailCells drifted from the grid.
  for (let i = 0; i < trail.length; i++) if (trail[i] === e.id) trail[i] = 0;
  e.trailCells.length = 0;
  e.isOutside = false;
}

function releaseTerritory(e) {
  // Send all owned land back to neutral.
  for (let i = 0; i < owner.length; i++) if (owner[i] === e.id) owner[i] = 0;
}

function transferTerritory(fromId, toId) {
  // Killer absorbs the victim's land (Blueprint Sec 3B [CHOICE]: awarded to killer).
  for (let i = 0; i < owner.length; i++) if (owner[i] === fromId) owner[i] = toId;
}

function recomputeArea(e) {
  let n = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] === e.id) n++;
  e.area = n;
}

// ---- DEATH (Blueprint Sec 3B) ----------------------------------------------
// killer (optional): the entity whose trail/head caused the death. If present,
// the victim's territory is awarded to the killer; otherwise released to neutral
// (e.g. wall death or self-cut with no aggressor).
function killEntity(e, reason, killer) {
  if (e.dead) return;
  // Spawn shield: ignore lethal hits while active (but the shield doesn't make
  // YOU lethal to others — it just protects you).
  if (e.shieldUntil && Date.now() < e.shieldUntil && reason !== 'self') return;

  e.dead = true;
  // Battle-royale: one life. Mark eliminated so the player can't respawn.
  if (e.mode === 'br') e.eliminated = true;
  e.respawnAt = Date.now() + (e.isBot ? BOT_RESPAWN_MS : PLAYER_MIN_DEAD_MS);
  e.killerId = (killer && killer.id !== e.id) ? killer.id : 0;
  e.boosting = false;

  clearTrail(e);
  const stolen = killer && killer.id !== e.id && !killer.dead;
  if (stolen) {
    transferTerritory(e.id, killer.id);
    recomputeArea(killer);
    killer.kills = (killer.kills || 0) + 1;
    if (!killer.isBot && killer.ws && killer.ws.readyState === 1) {
      send(killer.ws, { t: 'kill', coins: COIN_PER_KILL, total: killer.kills });
    }
  } else {
    releaseTerritory(e);
  }
  e.area = 0;

  if (e.mode === 'br') {
    // Battle Royale: you're out. Full death/spectate + placement.
    if (e.ws && e.ws.readyState === 1) {
      send(e.ws, { t: 'death', reason, killerId: e.killerId, eliminated: true,
                   placement: brPlacement() });
    }
  } else {
    // Classic: you lose your land but immediately get a fresh beginner plot and
    // keep playing — a quick "you got cut" notice, no spectate screen.
    if (e.ws && e.ws.readyState === 1) {
      send(e.ws, { t: 'cut', by: killer && killer.id !== e.id ? killer.name : null, reason });
    }
    respawnEntity(e);
  }
}

// Battle-royale: how many BR entities are still alive (your placement = that +1
// since you just died). Used to show "You placed #N".
function brPlacement() {
  let aliveBr = 0;
  for (const e of entities.values()) if (e.mode === 'br' && !e.dead && !e.eliminated) aliveBr++;
  return aliveBr + 1;
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

  // ROUND WIN: dominating the map (≈100%) wipes the board and restarts everyone
  // fresh. The winner gets the big coin reward.
  const total = GRID_W * GRID_H;
  if (e.area >= total * 0.99 && !roundResetting) {
    if (!e.isBot && e.ws && e.ws.readyState === 1) {
      send(e.ws, { t: 'fullmap', coins: COIN_FULL_MAP });
    }
    roundReset(e);
  }
}

// Wipe all territory/trails and respawn every entity with a fresh beginner blob.
let roundResetting = false;
function roundReset(winner) {
  roundResetting = true;
  owner.fill(0);
  trail.fill(0);
  const winnerName = winner ? winner.name : 'Someone';
  for (const ent of entities.values()) {
    ent.trailCells.length = 0;
    ent.isOutside = false;
    ent._gotFullMap = false;
    ent._frac = 0;
    if (ent.mode === 'br') {
      // In BR a 100% means the round is over — that player wins; others stay out.
      if (ent === winner) { /* keep */ }
    }
    if (!ent.dead) {
      const { cx, cy } = findSpawn(ent.id, ent.blob);
      ent.cx = cx; ent.cy = cy; ent.px = cx + 0.5; ent.py = cy + 0.5;
      ent.heading = headingTowardCenter(cx, cy);
      ent.pendingTurn = null; ent.boosting = false;
      paintSpawnBlob(ent); recomputeArea(ent);
    }
    if (!ent.isBot && ent.ws && ent.ws.readyState === 1) {
      send(ent.ws, { t: 'roundreset', winner: winnerName });
    }
  }
  roundResetting = false;
}

// ---- CHEATS (consumable, server-enforced) ----------------------------------
// The client has already verified the player owns/paid for the cheat (coins are
// client-side for now). The server applies the actual world effect so it's real
// in multiplayer. Validated against this whitelist.
const CHEAT_IDS = ['god','mach','thief','quake','titan','empire','freeze','phantom','surge','grand'];

function largestOtherEntity(selfId) {
  let best = null;
  for (const e of entities.values()) {
    if (e.id === selfId || e.dead) continue;
    if (!best || e.area > best.area) best = e;
  }
  return best;
}

function swapTerritories(aId, bId) {
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === aId) owner[i] = bId;
    else if (owner[i] === bId) owner[i] = aId;
  }
}

function applyCheat(e, id) {
  if (!e || e.dead) return false;
  const now = Date.now();
  switch (id) {
    case 'god': {                       // swap your land with the #1 player's
      const top = largestOtherEntity(e.id);
      if (!top) return false;
      swapTerritories(e.id, top.id);
      recomputeArea(e); recomputeArea(top);
      return true;
    }
    case 'mach': {                      // 3x speed for 20s (separate from boost)
      e.boosting = true; e.boostUntil = now + 20000; e.cheatSpeed = 3; e.cheatSpeedUntil = now + 20000;
      return true;
    }
    case 'thief': {                     // steal 25% of the largest player's land
      const top = largestOtherEntity(e.id);
      if (!top) return false;
      let moved = 0, target = Math.floor(top.area * 0.25);
      for (let i = 0; i < owner.length && moved < target; i++) {
        if (owner[i] === top.id) { owner[i] = e.id; moved++; }
      }
      recomputeArea(e); recomputeArea(top);
      return true;
    }
    case 'quake': {                     // everyone else loses trail + 15% land
      for (const o of entities.values()) {
        if (o.id === e.id || o.dead) continue;
        clearTrail(o);
        let drop = Math.floor(o.area * 0.15), done = 0;
        for (let i = 0; i < owner.length && done < drop; i++) {
          if (owner[i] === o.id) { owner[i] = 0; done++; }
        }
        recomputeArea(o);
      }
      return true;
    }
    case 'titan': {                     // 3x size + 15s invulnerability
      e.cheatSize = 3; e.cheatSizeUntil = now + 999999;  // persists this life
      e.shieldUntil = Math.max(e.shieldUntil, now + 15000);
      return true;
    }
    case 'empire': {                    // huge instant territory around you
      const R = 12;
      for (let y = e.cy - R; y <= e.cy + R; y++)
        for (let x = e.cx - R; x <= e.cx + R; x++)
          if (inBounds(x, y)) owner[idx(x, y)] = e.id;
      recomputeArea(e);
      return true;
    }
    case 'freeze': {                    // freeze all bots for 8s
      botFreezeUntil = now + 8000;
      return true;
    }
    case 'phantom': {                   // your trail invisible to others 12s
      e.phantomUntil = now + 12000;
      return true;
    }
    case 'surge': {                     // 3x coins rest of match (client multiplies)
      return true;                      // effect is applied client-side on rewards
    }
    case 'grand': {                     // "grand" payout cheat — handled client-side
      return true;
    }
  }
  return false;
}

let botFreezeUntil = 0;

// ---- LOGICAL STEP into a new cell (Blueprint Sec 3A) -----------------------
function enterCell(e, x, y) {
  if (!inBounds(x, y)) { return; }   // wall is handled in advance() (slide, no death)
  const i = idx(x, y);

  // Stepping onto ANY active trail kills that trail's owner (RULE 1 & 2).
  const tOwner = trail[i];
  if (tOwner !== 0) {
    const victim = entities.get(tOwner);
    if (victim) {
      if (victim.id === e.id) {
        killEntity(victim, 'self');          // self-cut: territory to neutral
      } else {
        killEntity(victim, 'cut', e);        // e is the killer -> takes their land
      }
    }
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

// Advance one tick. Accumulates fractional movement, then commits whole-cell
// steps one at a time (supercover) so even a fast avatar lays trail in every
// cell it passes and can't tunnel through a 1-cell trail (Blueprint Sec 3C).
function advance(e) {
  if (e.dead) return;

  // distance to travel this tick, in cells (boost applies while active)
  // boost or cheat speed; cheat mach-speed (3x) overrides normal boost
  let mult = e.boosting ? BOOST_MULT : 1;
  if (e.cheatSpeedUntil && Date.now() < e.cheatSpeedUntil) mult = Math.max(mult, e.cheatSpeed || 3);
  let remaining = CELL_PER_TICK * mult;
  // fractional position within the current cell, measured along heading
  e._frac = (e._frac || 0);

  while (!e.dead && remaining > 0) {
    const [dx, dy] = DIRS[e.heading];
    const aheadInBounds = inBounds(e.cx + dx, e.cy + dy);

    // WALL = slide, not death. If facing the wall, try a queued turn; if still
    // facing it, stop here for the tick (hold at the edge).
    if (!aheadInBounds) {
      if (e.pendingTurn && e.pendingTurn !== OPP[e.heading]) {
        const [tx, ty] = DIRS[e.pendingTurn];
        if (inBounds(e.cx + tx, e.cy + ty)) { e.heading = e.pendingTurn; e.pendingTurn = null; e._frac = 0; continue; }
      }
      e._frac = 0; e.px = e.cx + 0.5; e.py = e.cy + 0.5;
      break;
    }

    const toBoundary = 1 - e._frac;          // distance left to the next cell center
    if (remaining < toBoundary) {
      e._frac += remaining; remaining = 0;
    } else {
      remaining -= toBoundary; e._frac = 0;
      // we cross into the next cell now; apply a queued turn at the boundary
      if (e.pendingTurn && e.pendingTurn !== OPP[e.heading]) {
        const [tx, ty] = DIRS[e.pendingTurn];
        if (inBounds(e.cx + tx, e.cy + ty)) { e.heading = e.pendingTurn; }
        e.pendingTurn = null;
        // turning consumes the rest of this tick to keep trails axis-aligned
        const [hx, hy] = DIRS[e.heading];
        if (inBounds(e.cx + hx, e.cy + hy)) { enterCell(e, e.cx + hx, e.cy + hy); }
        remaining = 0;
      } else {
        enterCell(e, e.cx + dx, e.cy + dy);
      }
    }
  }

  // sync continuous position from logical cell + fraction (for smooth rendering)
  if (!e.dead) {
    const [hx, hy] = DIRS[e.heading];
    e.px = e.cx + 0.5 + hx * e._frac;
    e.py = e.cy + 0.5 + hy * e._frac;
  }
}

// ---- BOT BRAIN — competitive FSM (plays like a real player) ----------------
// States, in priority order each tick:
//   SURVIVE : something lethal is one step ahead -> turn away.
//   HUNT    : an enemy's active trail is close and we're aggressive -> chase the
//             cell to cut them (steals their whole territory on the kill).
//   RETREAT : our exposed trail is longer than our greed tolerance -> head home
//             to bank the capture before someone cuts us.
//   EXPAND  : default -> push into neutral/enemy land to enclose new area.
function cellSafeForBot(e, x, y) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (trail[i] === e.id) return false;          // our own trail = death
  return true;
}

function nearestEnemyTrailDir(e, range) {
  // Scan a small box around the bot for an enemy trail cell; return the cardinal
  // direction that steps toward the closest one (Manhattan).
  let best = Infinity, bestDir = null;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      const x = e.cx + dx, y = e.cy + dy;
      if (!inBounds(x, y)) continue;
      const t = trail[idx(x, y)];
      if (t !== 0 && t !== e.id) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d > 0 && d < best) {
          best = d;
          bestDir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
        }
      }
    }
  }
  return bestDir;
}

function dirTowardOwnLand(e) {
  // Pick a legal turn that steps onto (or toward) our own territory.
  const cands = ['N', 'E', 'S', 'W'].filter(d => d !== OPP[e.heading]);
  // first preference: a neighbor cell that is already ours
  for (const d of cands) {
    const [tx, ty] = DIRS[d];
    const nx = e.cx + tx, ny = e.cy + ty;
    if (cellSafeForBot(e, nx, ny) && inBounds(nx, ny) && owner[idx(nx, ny)] === e.id) return d;
  }
  // otherwise: head toward our territory's centroid
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < owner.length; i++) if (owner[i] === e.id) { sx += i % GRID_W; sy += (i / GRID_W) | 0; n++; }
  if (n > 0) {
    const cx = sx / n, cy = sy / n;
    const ddx = cx - e.cx, ddy = cy - e.cy;
    const want = Math.abs(ddx) > Math.abs(ddy) ? (ddx > 0 ? 'E' : 'W') : (ddy > 0 ? 'S' : 'N');
    const [tx, ty] = DIRS[want];
    if (want !== OPP[e.heading] && cellSafeForBot(e, e.cx + tx, e.cy + ty)) return want;
  }
  return null;
}

function botThink(e) {
  if (e.dead) return;
  const [dx, dy] = DIRS[e.heading];
  const ax = e.cx + dx, ay = e.cy + dy;
  const exposure = e.trailCells.length;

  // helper: choose any safe legal turn (not reverse, not into own trail/wall)
  const safeTurn = () => {
    const opts = ['N', 'E', 'S', 'W']
      .filter(d => d !== OPP[e.heading])
      .filter(d => { const [tx, ty] = DIRS[d]; return cellSafeForBot(e, e.cx + tx, e.cy + ty); });
    return opts.length ? opts[(Math.random() * opts.length) | 0] : null;
  };

  // SURVIVE — lethal cell directly ahead
  if (!cellSafeForBot(e, ax, ay)) {
    const t = safeTurn();
    if (t) e.pendingTurn = t;
    return;
  }

  // HUNT — chase a nearby enemy trail if this bot is aggressive and not over-extended
  if (exposure < e.botGreed * 1.3 && Math.random() < e.botAggro * 0.5) {
    const hd = nearestEnemyTrailDir(e, 9);
    if (hd && hd !== OPP[e.heading]) {
      const [tx, ty] = DIRS[hd];
      if (cellSafeForBot(e, e.cx + tx, e.cy + ty)) { e.pendingTurn = hd; return; }
    }
  }

  // RETREAT — bank the capture before the trail gets too long
  if (exposure > e.botGreed) {
    const home = dirTowardOwnLand(e);
    if (home) { e.pendingTurn = home; return; }
  }

  // EXPAND — wander outward to enclose new area; occasional turn keeps loops closing
  if (Math.random() < 0.12) {
    const t = safeTurn();
    if (t) e.pendingTurn = t;
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

function respawnEntity(e) {
  const { cx, cy } = findSpawn(e.id, e.blob);
  e.cx = cx; e.cy = cy; e.px = cx + 0.5; e.py = cy + 0.5;
  e.heading = headingTowardCenter(cx, cy);
  e.pendingTurn = null; e.isOutside = false; e.trailCells.length = 0;
  e.dead = false; e.killerId = 0; e._gotFullMap = false; e._frac = 0;
  e.boosting = false; e.boostUntil = 0; e.boostReadyAt = 0;
  e.cheatSpeed = 0; e.cheatSpeedUntil = 0; e.cheatSize = 0; e.cheatSizeUntil = 0; e.phantomUntil = 0;
  e.shieldUntil = 0;  // no re-shield on manual respawn (shield is a fresh-spawn perk)
  paintSpawnBlob(e); recomputeArea(e);
  if (e.ws && e.ws.readyState === 1) send(e.ws, { t: 'respawn', id: e.id });
}

function tick() {
  const now = Date.now();

  // Boost lifecycle: end an active boost when its window closes.
  for (const e of entities.values()) {
    if (e.boosting && now >= e.boostUntil) {
      e.boosting = false;
      e.boostReadyAt = now + BOOST_COOLDOWN_MS;
    }
  }

  // Auto-respawn applies ONLY to bots (after their delay) and NOT to eliminated
  // battle-royale entities. Humans respawn on Space (classic only).
  for (const e of entities.values()) {
    if (e.dead && e.isBot && !e.eliminated && now >= e.respawnAt) {
      if (entities.size > ROOM_CAP) { entities.delete(e.id); continue; }
      respawnEntity(e);
    }
    // remove eliminated bots so the world stays populated with fresh ones
    if (e.dead && e.isBot && e.eliminated && now >= e.respawnAt) { entities.delete(e.id); }
  }

  const botsFrozen = now < botFreezeUntil;
  for (const e of entities.values()) if (e.isBot && !e.dead && !botsFrozen) botThink(e);
  for (const e of entities.values()) { if (e.isBot && botsFrozen) continue; advance(e); }

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
      k: e.killerId || 0,
      sz: (e.cheatSizeUntil && Date.now() < e.cheatSizeUntil ? (e.cheatSize||3) : (e.sizeMult || 1)),
      sk: e.skin || 'default',
      bo: e.boosting ? 1 : 0, sh: (e.shieldUntil && Date.now() < e.shieldUntil) ? 1 : 0,
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

// Bot chat banter: if a player's message names a live bot, that bot fires back
// one of 10 lines (a playful/mean mix), after a short human-like delay.
const BOT_COMEBACKS = [
  (n)=>`Cute. Keep talking, ${n||'champ'}, it won't save your territory.`,
  ()=>`lol who let this one into the lobby`,
  (n)=>`I'd reply but I'm busy taking your land, ${n||'pal'}.`,
  ()=>`Big words for someone about to get cut.`,
  ()=>`Aww, you typed that with both thumbs?`,
  ()=>`Touch grass. Then touch my trail. See what happens.`,
  (n)=>`${n||'You'} talk a lot for a tiny little square.`,
  ()=>`I've eaten players ranked higher than you for breakfast.`,
  ()=>`That's adorable. Anyway — back to winning.`,
  ()=>`Say less. Actually, say nothing. You're embarrassing yourself.`,
];
function maybeBotReply(text) {
  const lower = text.toLowerCase();
  const named = [...entities.values()].find(e =>
    e.isBot && !e.dead && lower.includes(e.name.toLowerCase()));
  if (!named) return;
  const line = BOT_COMEBACKS[(Math.random() * BOT_COMEBACKS.length) | 0];
  const senderName = (lower.match(/\b\w+\b/) || [''])[0];  // rough; not used heavily
  setTimeout(() => {
    if (named.dead) return;
    const out = JSON.stringify({ t: 'chat', name: named.name, color: named.color,
      text: line(undefined) });
    for (const e of entities.values()) if (e.ws && e.ws.readyState === 1) e.ws.send(out);
  }, 700 + Math.random() * 1200);
}

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
      player = spawnEntity({ isBot: false, name, loadout: m.loadout, mode: m.mode });
      player.ws = ws;
      player.skin = (typeof m.skin === 'string') ? m.skin.slice(0, 24) : 'default';
      send(ws, { t: 'welcome', id: player.id, w: GRID_W, h: GRID_H, loadout: player.loadout,
                 boostMs: BOOST_DURATION_MS, cooldownMs: BOOST_COOLDOWN_MS, mode: player.mode });
    } else if (m.t === 'turn' && player && !player.dead) {
      if (['N', 'E', 'S', 'W'].includes(m.d)) player.pendingTurn = m.d;  // intent only
    } else if (m.t === 'boost' && player && !player.dead && player.hasBoost) {
      const now = Date.now();
      if (!player.boosting && now >= player.boostReadyAt) {
        player.boosting = true;
        player.boostUntil = now + BOOST_DURATION_MS;
      }
    } else if (m.t === 'cheat' && player && !player.dead) {
      // Consumable cheat the client already paid for; apply the real effect.
      if (CHEAT_IDS.includes(m.id)) {
        const ok = applyCheat(player, m.id);
        send(ws, { t: 'cheatResult', id: m.id, ok });
      }
    } else if (m.t === 'respawn' && player && player.dead) {
      // Battle-royale: no respawn once eliminated.
      if (!player.eliminated) respawnEntity(player);
    } else if (m.t === 'chat' && player) {
      const text = ('' + (m.text || '')).slice(0, 120).trim();
      if (text) {
        const out = JSON.stringify({ t: 'chat', name: player.name, color: player.color, text });
        for (const e of entities.values()) if (e.ws && e.ws.readyState === 1) e.ws.send(out);
        maybeBotReply(text);   // bots clap back if their name is mentioned
      }
    }
  });

  ws.on('close', () => {
    if (player) { clearTrail(player); releaseTerritory(player); entities.delete(player.id); }
  });
});

// seed initial bots
for (let i = 0; i < MIN_BOTS; i++) spawnEntity({ isBot: true });

setInterval(tick, 1000 / TICK_RATE);
server.listen(PORT, () => {
  console.log(`Paper.io-class server on http://localhost:${PORT}  (${TICK_RATE} ticks/s, grid ${GRID_W}x${GRID_H})`);
});
