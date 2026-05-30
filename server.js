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
// blocked: 1 = unplayable cell (void/wall) for the current map shape.
const owner = new Uint8Array(GRID_W * GRID_H);
const trail = new Uint8Array(GRID_W * GRID_H);
const blocked = new Uint8Array(GRID_W * GRID_H);
const idx = (x, y) => y * GRID_W + x;
const inBoundsRaw = (x, y) => x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
// "in bounds" now also means "not a blocked void cell" — avatars slide off these
// just like the map border.
const inBounds = (x, y) => inBoundsRaw(x, y) && blocked[idx(x, y)] === 0;

// ---- MAP SHAPES ------------------------------------------------------------
// Three worlds only, all with soft/rounded edges (no harsh corners or corridors).
// Each shape fills `blocked` so only the playable region is open.
const MAP_SHAPES = [
  { id:'circle',   name:'The Colosseum', fn:shapeCircle },
  { id:'square',   name:'The Arena',     fn:shapeRoundedSquare },
  { id:'triangle', name:'The Pyramid',   fn:shapeRoundedTriangle },
];
let currentMap = MAP_SHAPES[0];

function clearBlocked(){ blocked.fill(0); }

function shapeCircle(){
  const cx=GRID_W/2, cy=GRID_H/2, R=Math.min(GRID_W,GRID_H)/2 - 3;
  for(let y=0;y<GRID_H;y++)for(let x=0;x<GRID_W;x++){
    const dx=x-cx+0.5, dy=y-cy+0.5; if(dx*dx+dy*dy > R*R) blocked[idx(x,y)]=1;
  }
}

// Square with generously rounded corners (a "squircle"-style rounded rect).
function shapeRoundedSquare(){
  const m=4;                                   // margin from the map edge
  const x0=m, y0=m, x1=GRID_W-1-m, y1=GRID_H-1-m;
  const r=Math.min(GRID_W,GRID_H)*0.22;        // corner radius
  for(let y=0;y<GRID_H;y++)for(let x=0;x<GRID_W;x++){
    let bad = (x<x0||x>x1||y<y0||y>y1);
    if(!bad){
      // round each corner: if we're in a corner box, require distance<=r
      const inLeft=x<x0+r, inRight=x>x1-r, inTop=y<y0+r, inBot=y>y1-r;
      if((inLeft||inRight)&&(inTop||inBot)){
        const ccx = inLeft ? x0+r : x1-r;
        const ccy = inTop  ? y0+r : y1-r;
        const dx=x-ccx, dy=y-ccy;
        if(dx*dx+dy*dy > r*r) bad=true;
      }
    }
    if(bad) blocked[idx(x,y)]=1;
  }
}

// Equilateral-ish triangle (point up) with rounded corners via a small inward
// inset: a cell is playable if it's inside all three edges by a soft margin.
function shapeRoundedTriangle(){
  // Wide 3-point triangle: apex near top-center, base corners near bottom-left
  // and bottom-right, so all three points reach out toward the map corners.
  const cx=GRID_W/2, top=4, bot=GRID_H-5;
  const halfBase=(GRID_W/2)-3;
  const ax=cx, ay=top, bx=cx-halfBase, by=bot, cxr=cx+halfBase, cyr=bot;
  const soft=4;   // small inward inset so the edge isn't right on the border
  function sideSign(px,py, x1,y1,x2,y2){ return (x2-x1)*(py-y1)-(y2-y1)*(px-x1); }
  for(let y=0;y<GRID_H;y++)for(let x=0;x<GRID_W;x++){
    const d1=sideSign(x,y, ax,ay, bx,by);
    const d2=sideSign(x,y, bx,by, cxr,cyr);
    const d3=sideSign(x,y, cxr,cyr, ax,ay);
    const inside = (d1<=-soft) && (d2<=-soft) && (d3<=-soft);
    if(!inside) blocked[idx(x,y)]=1;
  }
}

// Expose the current map's smooth outline (in cell coords) so the client can
// draw a clean anti-aliased boundary over the gridded play area.
function mapOutline(){
  const cx=GRID_W/2, cy=GRID_H/2;
  if(currentMap.id==='circle'){
    return { kind:'circle', cx, cy, r:Math.min(GRID_W,GRID_H)/2 - 3 };
  }
  if(currentMap.id==='triangle'){
    const top=4, bot=GRID_H-5, halfBase=(GRID_W/2)-3;
    return { kind:'poly', pts:[[cx,top],[cx-halfBase,bot],[cx+halfBase,bot]] };
  }
  // square (rounded)
  const m=4, r=Math.min(GRID_W,GRID_H)*0.22;
  return { kind:'rrect', x0:m, y0:m, x1:GRID_W-1-m, y1:GRID_H-1-m, r };
}

function applyMapShape(shape){
  currentMap = shape;
  clearBlocked();
  shape.fn();
}


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

function blobNeutral(cx, cy, B, margin) {
  const pad = B + (margin || 0);
  for (let y = cy - pad; y <= cy + pad; y++)
    for (let x = cx - pad; x <= cx + pad; x++)
      if (!inBounds(x, y) || owner[idx(x, y)] !== 0) return false;
  return true;
}

function findSpawn(selfId, blob) {
  const B = blob || SPAWN_BLOB;
  const M = 2;  // neutral margin around the spawn blob

  // Pass 1: random spots, fully neutral blob+margin AND far from enemies.
  for (let tries = 0; tries < 400; tries++) {
    const cx = B + M + 1 + Math.floor(Math.random() * (GRID_W - 2 * (B + M) - 2));
    const cy = B + M + 1 + Math.floor(Math.random() * (GRID_H - 2 * (B + M) - 2));
    if (!blobNeutral(cx, cy, B, M)) continue;
    if (distToNearestEnemy(cx, cy, selfId) < SPAWN_SAFE_RADIUS) continue;
    return { cx, cy };
  }
  // Pass 2: random spots, neutral blob (drop the safety radius).
  for (let tries = 0; tries < 400; tries++) {
    const cx = B + 1 + Math.floor(Math.random() * (GRID_W - 2 * B - 2));
    const cy = B + 1 + Math.floor(Math.random() * (GRID_H - 2 * B - 2));
    if (blobNeutral(cx, cy, B, 0)) return { cx, cy };
  }
  // Pass 3: gather ALL valid neutral spots and pick one at RANDOM (so a crowded
  // map never funnels everyone to the same corner). Sample on a stride for speed.
  const candidates = [];
  const step = Math.max(1, B);  // don't need every single cell
  for (let cy = B + 1; cy < GRID_H - B - 1; cy += step)
    for (let cx = B + 1; cx < GRID_W - B - 1; cx += step)
      if (blobNeutral(cx, cy, B, 0)) candidates.push([cx, cy]);
  if (candidates.length) {
    const [cx, cy] = candidates[(Math.random() * candidates.length) | 0];
    return { cx, cy };
  }
  // Last resort (map essentially full): random-ish patch, cleared.
  const cx = B + 1 + ((Math.random() * (GRID_W - 2 * B - 2)) | 0);
  const cy = B + 1 + ((Math.random() * (GRID_H - 2 * B - 2)) | 0);
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

// Normalize a name for comparison: lowercase, map common leetspeak to letters,
// strip non-alphanumerics. Used for both similarity and profanity checks.
function normalizeName(s) {
  return ('' + s).toLowerCase()
    .replace(/[4@]/g, 'a').replace(/[3]/g, 'e').replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o').replace(/[5\$]/g, 's').replace(/[7]/g, 't')
    .replace(/[^a-z0-9]/g, '');
}

// Small PG profanity list (kept conservative; matches as substring of the
// normalized name so leetspoofing is caught).
const BANNED = ['fuck','shit','bitch','cunt','nigger','nigga','faggot','dick',
  'pussy','asshole','bastard','whore','slut','rape','nazi','penis','vagina',
  'sex','cum','porn','retard','damn','crap'];

function validateName(raw) {
  const trimmed = ('' + raw).trim();
  if (trimmed.length < 1) return { ok:false, reason:'empty', message:'Please enter a name.' };
  const norm = normalizeName(trimmed);
  if (norm.length < 1) return { ok:false, reason:'empty', message:'Please enter a real name.' };
  // profanity
  for (const w of BANNED) {
    if (norm.includes(w)) return { ok:false, reason:'inappropriate',
      message:'That name isn\u2019t allowed. Please choose something appropriate.' };
  }
  // duplicate / confusingly-similar to any LIVE entity (humans and bots)
  for (const e of entities.values()) {
    if (e.dead) continue;
    const other = normalizeName(e.name);
    if (other === norm) return { ok:false, reason:'duplicate',
      message:'That name is already taken. Try a different one.' };
    // confusingly similar: one contains the other and they're close in length
    if ((other.includes(norm) || norm.includes(other)) &&
        Math.abs(other.length - norm.length) <= 1 && Math.min(other.length, norm.length) >= 3) {
      return { ok:false, reason:'similar',
        message:'That name is too similar to another player. Try a different one.' };
    }
  }
  return { ok:true };
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
  if (e.mode === 'br') e.eliminated = true;
  e.respawnAt = Date.now() + (e.isBot ? BOT_RESPAWN_MS : PLAYER_MIN_DEAD_MS);
  e.killerId = (killer && killer.id !== e.id) ? killer.id : 0;
  e.boosting = false;
  e.streak = 0;  // dying resets your own kill streak

  clearTrail(e);
  const stolen = killer && killer.id !== e.id && !killer.dead;
  let bootToMenu = false;
  if (stolen) {
    transferTerritory(e.id, killer.id);
    recomputeArea(killer);
    killer.kills = (killer.kills || 0) + 1;
    // kill streak: consecutive kills without dying -> escalating coin multiplier
    killer.streak = (killer.streak || 0) + 1;
    const streakMult = Math.min(5, killer.streak);   // x1..x5
    const coins = COIN_PER_KILL * streakMult;
    if (!killer.isBot && killer.ws && killer.ws.readyState === 1) {
      send(killer.ws, { t: 'kill', coins, total: killer.kills, streak: killer.streak, mult: streakMult });
    }
    // 3-kills-to-menu (Classic only): if this killer has now cut THIS victim 3+
    // times, the victim is sent back to the main menu.
    if (e.mode !== 'br' && !e.isBot) {
      e.deathsBy = e.deathsBy || {};
      e.deathsBy[killer.id] = (e.deathsBy[killer.id] || 0) + 1;
      if (e.deathsBy[killer.id] >= 3) bootToMenu = true;
    }
  } else {
    releaseTerritory(e);
  }
  e.area = 0;

  if (e.mode === 'br') {
    if (e.ws && e.ws.readyState === 1) {
      send(e.ws, { t: 'death', reason, killerId: e.killerId, eliminated: true,
                   placement: brPlacement() });
    }
  } else if (bootToMenu) {
    // Sent home: tell the client to return to menu, then remove the entity.
    if (e.ws && e.ws.readyState === 1) {
      send(e.ws, { t: 'booted', by: killer ? killer.name : null });
    }
    // entity will be cleaned up when its socket closes / on next join; mark it.
    e.eliminated = true;
  } else {
    // Classic death: spectate your killer, press Space to rejoin (no auto respawn).
    if (e.ws && e.ws.readyState === 1) {
      send(e.ws, { t: 'death', reason, killerId: e.killerId, eliminated: false, placement: 0 });
    }
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
  // count only PLAYABLE cells (blocked void cells can never be owned)
  let total = 0;
  for (let i = 0; i < blocked.length; i++) if (blocked[i] === 0) total++;
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
  // pick a new random map shape for the next round
  const shape = MAP_SHAPES[(Math.random() * MAP_SHAPES.length) | 0];
  applyMapShape(shape);
  const winnerName = winner ? winner.name : 'Someone';
  for (const ent of entities.values()) {
    ent.trailCells.length = 0;
    ent.isOutside = false;
    ent._gotFullMap = false;
    ent._frac = 0;
    if (!ent.dead) {
      const { cx, cy } = findSpawn(ent.id, ent.blob);
      ent.cx = cx; ent.cy = cy; ent.px = cx + 0.5; ent.py = cy + 0.5;
      ent.heading = headingTowardCenter(cx, cy);
      ent.pendingTurn = null; ent.boosting = false;
      paintSpawnBlob(ent); recomputeArea(ent);
    }
    if (!ent.isBot && ent.ws && ent.ws.readyState === 1) {
      send(ent.ws, { t: 'roundreset', winner: winnerName, mapId: shape.id, mapName: shape.name,
                     blocked: rleEncode(blocked), outline: mapOutline() });
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
    case 'freeze': {                    // freeze EVERYONE else for 8s
      freezeUntil = now + 8000;
      freezeCasterId = e.id;
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

let freezeUntil = 0, freezeCasterId = 0;

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

  const frozen = now < freezeUntil;
  for (const e of entities.values()) if (e.isBot && !e.dead && !(frozen && e.id !== freezeCasterId)) botThink(e);
  for (const e of entities.values()) { if (frozen && e.id !== freezeCasterId) continue; advance(e); }

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
    // Skip dead entities entirely so no stale/ghost avatar lingers on clients.
    if (e.dead) continue;
    ents.push({
      id: e.id, n: e.name, c: e.color, b: e.isBot ? 1 : 0,
      x: +e.px.toFixed(2), y: +e.py.toFixed(2), h: e.heading,
      o: e.isOutside ? 1 : 0, a: e.area, d: 0,
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
  ()=>`Is that your strategy or your apology?`,
  ()=>`I've seen smarter trails drawn by a sleeping bot.`,
  ()=>`You play like the tutorial gave up on you.`,
  ()=>`Keep dreaming, I'll keep capturing.`,
  ()=>`Your territory called. It wants a real owner.`,
  ()=>`I'd explain how to win but you wouldn't fit it on your map.`,
  ()=>`Nice loop. Shame it's about to be mine.`,
  ()=>`You bring a marker to a land war?`,
  ()=>`Blink and your whole map is gone.`,
  ()=>`Talking trash with 2% of the board, bold move.`,
  ()=>`I almost feel bad. Almost.`,
  ()=>`Your trail is the easiest snack on this map.`,
  ()=>`Did you come here to lose in chat too?`,
  ()=>`That confidence is cute for someone in last place.`,
  ()=>`I've turned bigger players into rubble.`,
  ()=>`Run home. Oh wait, you don't have one anymore.`,
  ()=>`You're the reason the tutorial exists.`,
  ()=>`Squares like you are why I never lose.`,
  ()=>`Keep typing, it makes you easier to corner.`,
  ()=>`I collect territories. Yours is next on the shelf.`,
  ()=>`That's a lot of mouth for a one-cell kingdom.`,
  ()=>`You move like you're apologizing to the grid.`,
  ()=>`Adorable. Now watch a pro draw a real loop.`,
  ()=>`I'd race you but I don't race snails.`,
  ()=>`Your whole empire fits in my shadow.`,
  ()=>`Less chatting, more getting captured.`,
  ()=>`You call that a trail? I call it bait.`,
  ()=>`Even the walls feel sorry for you.`,
  ()=>`I've respawned with more land than you'll ever hold.`,
  ()=>`Keep it up and I'll frame your tiny map.`,
  ()=>`You're playing checkers. I'm drawing masterpieces.`,
  ()=>`Cut once, shame on me. Cut you thrice, see you in the menu.`,
  ()=>`That's a brave thing to say to your future landlord.`,
  ()=>`I'd take you seriously but the leaderboard won't let me.`,
  ()=>`You steer like the arrow keys owe you money.`,
  ()=>`The map's not big enough for your ego or small enough for your skill.`,
  ()=>`Careful, all that talk is slowing your turns.`,
  ()=>`I've already forgotten your name. The board will too.`,
  ()=>`Your strategy is my warm-up.`,
  ()=>`Trash talk costs nothing. Your territory, though — expensive.`,
  ()=>`Keep poking the bear. The bear owns the whole map.`,
  ()=>`You had one trail and you fumbled it.`,
  ()=>`I'd give you a head start but you'd waste it.`,
  ()=>`Aw, the little square has opinions.`,
  ()=>`Welcome to the food chain. You're at the bottom.`,
  ()=>`Spectator mode is calling your name.`,
  ()=>`I've seen bolder moves from a frozen bot.`,
  ()=>`Your loops are rounder than your chances.`,
  ()=>`Talk all you want — I read it from inside your old territory.`,
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
      if (player) return;  // already joined
      const raw = ('' + (m.name || 'Player')).slice(0, 16).trim();
      const verdict = validateName(raw);
      if (!verdict.ok) {
        send(ws, { t: 'nameReject', reason: verdict.reason, message: verdict.message });
        return;
      }
      player = spawnEntity({ isBot: false, name: raw || 'Player', loadout: m.loadout, mode: m.mode });
      player.ws = ws;
      player.skin = (typeof m.skin === 'string') ? m.skin.slice(0, 24) : 'default';
      send(ws, { t: 'welcome', id: player.id, w: GRID_W, h: GRID_H, loadout: player.loadout,
                 boostMs: BOOST_DURATION_MS, cooldownMs: BOOST_COOLDOWN_MS, mode: player.mode,
                 mapId: currentMap.id, mapName: currentMap.name, blocked: rleEncode(blocked),
                 outline: mapOutline() });
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
