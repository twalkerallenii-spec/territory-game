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
const crypto = require('crypto');

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
const BR_START_BOTS = 14;             // Battle Royale starts with a full lobby
const BR_STORM_START_MS = 25000;      // grace period before the storm begins
const BR_STORM_SHRINK_MS = 90000;     // time for the storm to fully close in
const BR_COIN_WIN = 2000;             // coins for a Victory Royale
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
  '#ff3b6b', '#2ee66b', '#3d7bff', '#ff9f1c', '#b15cff', '#18d6c8',
  '#ff4fd8', '#a6e22e', '#ff6a3d', '#00c2a8', '#8b5cf6', '#f2b134',
  '#ffd23f', '#ff2e63', '#22c55e', '#7cc00f', '#f97316', '#4361ff',
  '#9d7bff', '#e0359e', '#2dd4bf', '#ef4444', '#3b9dff', '#a855f7',
  '#f43f5e', '#10b981', '#eab308', '#fb7185', '#38bdf8', '#f59e0b',
  '#c026d3', '#34d399', '#f472b6', '#e07a3c', '#06b6d4', '#facc15',
];

// ---- WORLD STATE (per-room; the active room's state is bound here) ---------
// These are rebound by useRoom(room) before each room's logic runs, so the
// existing functions can keep referring to them by name while each game mode
// gets its own isolated world.
let owner = new Uint8Array(GRID_W * GRID_H);
let trail = new Uint8Array(GRID_W * GRID_H);
let blocked = new Uint8Array(GRID_W * GRID_H);
let totems = [];                      // active room's totems; rebound by useRoom()
const idx = (x, y) => y * GRID_W + x;
const inBoundsRaw = (x, y) => x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
const inBounds = (x, y) => inBoundsRaw(x, y) && blocked[idx(x, y)] === 0;

// ---- MAP SHAPES ------------------------------------------------------------
// Three easy worlds with ONLY straight horizontal/vertical edges. On a 4-dir
// grid these have no tucked-in diagonal corners, so you can always reach the
// last cells head-on and actually finish at 100% (no getting stuck at 88%).
const MAP_SHAPES = [
  { id:'square', name:'The Square',  fn:shapeSquare },
  { id:'wide',   name:'The Field',   fn:shapeWide },
  { id:'tall',   name:'The Tower',   fn:shapeTall },
  { id:'pillars',name:'The Pillars', fn:shapePillars },
  { id:'arena',  name:'The Arena',   fn:shapeArena },
  { id:'corners',name:'The Bastion', fn:shapeCorners },
];
let currentMap = MAP_SHAPES[0];   // rebound per room by useRoom()

function clearBlocked(){ blocked.fill(0); }

// A simple rectangular play area defined by margins; everything outside = void.
function fillRect(x0, y0, x1, y1){
  for(let y=0;y<GRID_H;y++)for(let x=0;x<GRID_W;x++){
    if(x<x0||x>x1||y<y0||y>y1) blocked[idx(x,y)]=1;
  }
}

function shapeSquare(){ const m=6; fillRect(m, m, GRID_W-1-m, GRID_H-1-m); }
// Block an interior rectangle (a wall/pillar). Flat edges keep every neighbour
// head-on reachable on the 4-dir grid, and the win% counts only playable cells,
// so 100% stays achievable with obstacles present.
function blockRect(x0, y0, x1, y1){ for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++) if(inBoundsRaw(x,y)) blocked[idx(x,y)]=1; }
function shapePillars(){ const m=6; fillRect(m, m, GRID_W-1-m, GRID_H-1-m);
  const cx=GRID_W>>1, cy=GRID_H>>1, s=5, d=Math.round(GRID_W*0.22);
  blockRect(cx-d-s,cy-d-s,cx-d+s,cy-d+s); blockRect(cx+d-s,cy-d-s,cx+d+s,cy-d+s);
  blockRect(cx-d-s,cy+d-s,cx-d+s,cy+d+s); blockRect(cx+d-s,cy+d-s,cx+d+s,cy+d+s); }
function shapeArena(){ const m=6; fillRect(m, m, GRID_W-1-m, GRID_H-1-m);
  const cx=GRID_W>>1, cy=GRID_H>>1, s=Math.round(GRID_W*0.13); blockRect(cx-s,cy-s,cx+s,cy+s); }
function shapeCorners(){ const m=6; fillRect(m, m, GRID_W-1-m, GRID_H-1-m);
  const s=Math.round(GRID_W*0.16), a=m, b=GRID_W-1-m, c=GRID_H-1-m;
  blockRect(a,a,a+s,a+s); blockRect(b-s,a,b,a+s); blockRect(a,c-s,a+s,c); blockRect(b-s,c-s,b,c); }
function shapeWide(){   // wide rectangle (letterbox)
  const mx=4, my=Math.round(GRID_H*0.18); fillRect(mx, my, GRID_W-1-mx, GRID_H-1-my); }
function shapeTall(){   // tall rectangle (portrait)
  const mx=Math.round(GRID_W*0.18), my=4; fillRect(mx, my, GRID_W-1-mx, GRID_H-1-my); }

// Rectangular outline for the client to draw a clean boundary.
function mapOutline(){
  let x0,y0,x1,y1;
  if(currentMap.id==='wide'){ const mx=4, my=Math.round(GRID_H*0.18); x0=mx;y0=my;x1=GRID_W-1-mx;y1=GRID_H-1-my; }
  else if(currentMap.id==='tall'){ const mx=Math.round(GRID_W*0.18), my=4; x0=mx;y0=my;x1=GRID_W-1-mx;y1=GRID_H-1-my; }
  else { const m=6; x0=m;y0=m;x1=GRID_W-1-m;y1=GRID_H-1-m; }
  // r:0 -> sharp rectangle (no rounding, so no diagonal corner cells)
  return { kind:'rrect', x0, y0, x1, y1, r:0 };
}

function applyMapShape(shape){
  currentMap = shape;
  clearBlocked();
  shape.fn();
}


const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };

// ---- ROOMS -----------------------------------------------------------------
// Each game mode runs in its own isolated world. A Room holds all the state the
// game functions read via the module-level bindings above; useRoom(room) swaps
// the bindings to point at that room before its logic runs, so the existing
// ~40 functions work unchanged on whichever room is active.
const VALID_MODES = ['classic', 'br', '3d', 'teams', 'tron', 'speed', 'tiny', 'bounty', 'chaos', 'koth'];
const KOTH_R = 16;       // King-of-the-Hill zone radius (cells)
const KOTH_WIN = 20;     // points needed to win a KotH round
const KOTH_TICK = 1000;  // award a point every second to whoever holds the hill
const rooms = {};   // mode -> Room

function makeRoom(mode) {
  const r = {
    mode,
    owner: new Uint8Array(GRID_W * GRID_H),
    trail: new Uint8Array(GRID_W * GRID_H),
    blocked: new Uint8Array(GRID_W * GRID_H),
    entities: new Map(),
    totems: [],
    currentMap: MAP_SHAPES[0],
    botNameCursor: 0,
    roundResetting: false,
    freezeUntil: 0,
    freezeCasterId: 0,
    // Battle Royale match state
    brActive: false,
    brEnding: false,
    brStart: 0,          // match start timestamp
    brStormInset: 0,     // how many cells the storm has eaten from each side
    // King of the Hill
    kothScores: {},      // tid -> points
    kothAt: 0,           // next scoring tick
    kothLeader: 0,       // current leader's tid (0 = contested/empty)
  };
  return r;
}

let activeRoom = null;
function saveActiveRoom() {
  if (!activeRoom) return;
  activeRoom.owner = owner;
  activeRoom.trail = trail;
  activeRoom.blocked = blocked;
  activeRoom.entities = entities;
  activeRoom.currentMap = currentMap;
  activeRoom.botNameCursor = botNameCursor;
  activeRoom.roundResetting = roundResetting;
  activeRoom.freezeUntil = freezeUntil;
  activeRoom.freezeCasterId = freezeCasterId;
  activeRoom.totems = totems;
}function useRoom(room) {
  if (activeRoom === room) return;
  saveActiveRoom();
  activeRoom = room;
  owner = room.owner;
  trail = room.trail;
  blocked = room.blocked;
  entities = room.entities;
  currentMap = room.currentMap;
  botNameCursor = room.botNameCursor;
  roundResetting = room.roundResetting;
  freezeUntil = room.freezeUntil;
  freezeCasterId = room.freezeCasterId;
  totems = room.totems;
}

// Mode-specific terrain applied AFTER the base map shape (tiny = cramped box).
function applyModeTerrain() {
  if (!activeRoom || (activeRoom.mode !== 'tiny' && activeRoom.mode !== 'tron')) return;
  const ins = activeRoom.mode === 'tiny' ? 50 : 40;   // tiny 60x60, tron 80x80
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (x < ins || x >= GRID_W - ins || y < ins || y >= GRID_H - ins) blocked[idx(x, y)] = 1;
}

function getRoom(mode) {
  const m = VALID_MODES.includes(mode) ? mode : 'classic';
  if (!rooms[m]) {
    const room = makeRoom(m);
    rooms[m] = room;
    room.speedMult = (m === 'speed') ? 1.6 : 1;
    room.chaosNextAt = Date.now() + 20000;
    room.chaosSpeedUntil = 0;
    // initialize this room's world (map shape + bots)
    useRoom(room);
    applyMapShape(MAP_SHAPES[(Math.random() * MAP_SHAPES.length) | 0]);
    applyModeTerrain();
    if (m === 'teams') {
      for (let t = 0; t < 3; t++) {           // 3 bot teams to start
        const a = spawnEntity({ isBot: true, mode: m });
        if (!a) break;
        joinTeam(a, a.id, null);
        spawnTeamMate(a);                      // partner starts in the same patch
      }
    } else {
      const startBots = (m === 'br') ? BR_START_BOTS : MIN_BOTS;
      for (let i = 0; i < startBots; i++) spawnEntity({ isBot: true, mode: m });
    }
    if (m === 'br') startBrMatch(room);
    placeTotems();
  }
  return rooms[m];
}

let entities = new Map();             // active room's entities; rebound by useRoom()

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
  // Last resort: the blob couldn't be placed cleanly anywhere. Find the open
  // (non-wall) cell closest to the map center and carve a small neutral pocket
  // there. This guarantees we NEVER spawn inside a wall/void.
  let best = null, bestD = Infinity;
  const ccx = GRID_W / 2, ccy = GRID_H / 2;
  for (let y = B + 1; y < GRID_H - B - 1; y++) {
    for (let x = B + 1; x < GRID_W - B - 1; x++) {
      if (!inBounds(x, y)) continue;                 // skip wall/void cells
      const d = (x - ccx) * (x - ccx) + (y - ccy) * (y - ccy);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  if (best) {
    const [cx, cy] = best;
    // clear a neutral pocket, but only in playable cells (don't touch walls)
    for (let y = cy - B; y <= cy + B; y++)
      for (let x = cx - B; x <= cx + B; x++)
        if (inBounds(x, y)) owner[idx(x, y)] = 0;
    return { cx, cy };
  }
  // Absolute fallback (no open cell at all — shouldn't happen): map center.
  return { cx: Math.floor(ccx), cy: Math.floor(ccy) };
}

function headingTowardCenter(cx, cy) {
  // Point the avatar at the map interior so a fresh spawn never walks straight
  // into the border (and can't be forced to wall-die before its first turn).
  const dx = (GRID_W / 2) - cx, dy = (GRID_H / 2) - cy;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'E' : 'W') : (dy > 0 ? 'S' : 'N');
}

// ---- TEAMS helpers ---------------------------------------------------------
// In 'teams' mode a pair shares ONE territory blob. The grid stores a "territory
// id" — the team anchor's entity id — instead of each member's own id. Outside
// teams mode tid(e) is just e.id, so classic/BR/3D behavior is unchanged.
function tid(e) { return e.team || e.id; }
function teammateOf(e) {
  if (!e.team) return null;
  for (const o of entities.values()) if (o.id !== e.id && tid(o) === tid(e)) return o;
  return null;
}
function sameTeam(a, b) { return a && b && a.team && b.team && tid(a) === tid(b); }

function paintSpawnBlob(e) {
  if (e.mode === 'tron') return;               // Tron: no territory at all
  const B = e.blob || SPAWN_BLOB;
  for (let y = e.cy - B; y <= e.cy + B; y++)
    for (let x = e.cx - B; x <= e.cx + B; x++)
      if (inBounds(x, y)) owner[idx(x, y)] = tid(e);
}

// Exactly 12 fixed bot names (one per bot in the default field).
const BOT_NAMES = [
  'Aymeric', 'Boris', 'Vincent', 'Helga', 'Mateo', 'Priya',
  'Søren', 'Akira', 'Olga', 'Diego', 'Freya', 'Tariq',
];
let botNameCursor = 0;   // rebound per room
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

// Owned-name registry: name -> secret token. Best-effort persistence to disk
// (survives restarts; wiped by a redeploy — real permanence needs accounts).
const ACCTS_FILE = path.join(__dirname, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACCTS_FILE, 'utf8')) || {}; } catch (_) {}
let acctSaveTimer = null;
function saveAccounts() {           // throttled write
  if (acctSaveTimer) return;
  acctSaveTimer = setTimeout(() => { acctSaveTimer = null;
    try { fs.writeFileSync(ACCTS_FILE, JSON.stringify(accounts)); } catch (_) {} }, 500);
}
function pinHash(pin) {             // LEGACY hash — kept only to verify + upgrade old accounts
  let h = 5381; const str = 'papersalt:' + pin;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
// Proper password hashing with scrypt (built into Node — no extra deps).
// Stored as "scrypt:<saltHex>:<hashHex>".
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}
function verifyPassword(account, pw) {
  if (!account) return false;
  if (typeof account.pw === 'string' && account.pw.startsWith('scrypt:')) {
    const parts = account.pw.split(':');
    const want = Buffer.from(parts[2] || '', 'hex');
    let got;
    try { got = crypto.scryptSync(String(pw), parts[1] || '', want.length || 64); } catch (_) { return false; }
    return want.length > 0 && want.length === got.length && crypto.timingSafeEqual(want, got);
  }
  // Legacy account (djb2 pin): verify with the old hash, then transparently
  // upgrade it to scrypt so the weak hash is gone after the next login.
  if (account.pin && account.pin === pinHash(pw)) {
    account.pw = hashPassword(pw); delete account.pin; saveAccounts();
    return true;
  }
  return false;
}
const CHEAT_PRICES = { god:10000, mach:8000, thief:7000, quake:6000, titan:5000,
                       empire:4500, freeze:3800, phantom:3200, grand:2000 };
function acctOf(p) { return p && p.account ? accounts[p.account] : null; }
function creditAcct(p, n) {         // server-side coin earn + push the new balance
  const a = acctOf(p); if (!a) return;
  a.coins = Math.min(100000000, (a.coins || 0) + n); saveAccounts();
  acctSync(p);
}

// ---- PROGRESSION: XP, levels, daily quests --------------------------------
function xpNeededFor(level) { return 300 + (level - 1) * 150; }   // XP from `level` -> level+1
function levelFromXp(xp) { let lvl = 1, acc = 0; while (xp >= acc + xpNeededFor(lvl)) { acc += xpNeededFor(lvl); lvl++; } return lvl; }
function xpFloor(level) { let acc = 0; for (let l = 1; l < level; l++) acc += xpNeededFor(l); return acc; }
function acctSync(p) {
  const a = acctOf(p); if (!a || !p.ws || p.ws.readyState !== 1) return;
  const lvl = a.level || 1;
  send(p.ws, { t: 'acctsync', coins: a.coins, cheats: a.cheats, xp: a.xp || 0, level: lvl,
               into: (a.xp || 0) - xpFloor(lvl), need: xpNeededFor(lvl), daily: (a.daily && a.daily.quests) || [] });
}
function addXp(p, n) {
  const a = acctOf(p); if (!a || !n) return;
  const before = a.level || 1;
  a.xp = (a.xp || 0) + n; a.level = levelFromXp(a.xp);
  saveAccounts();
  if (p.ws && p.ws.readyState === 1 && a.level > before) send(p.ws, { t: 'levelup', level: a.level });
  acctSync(p);
}
const QUEST_POOL = [
  { id: 'cells400', text: 'Capture 400 cells of land', goal: 400, metric: 'cells', coins: 350, xp: 180 },
  { id: 'cells1k',  text: 'Capture 1,000 cells of land', goal: 1000, metric: 'cells', coins: 800, xp: 400 },
  { id: 'totem2',   text: 'Capture 2 totems',       goal: 2,  metric: 'totem', coins: 450, xp: 220 },
  { id: 'kills5',  text: 'Cut 5 rivals',           goal: 5,  metric: 'kills', coins: 300, xp: 150 },
  { id: 'kills12', text: 'Cut 12 rivals',          goal: 12, metric: 'kills', coins: 700, xp: 350 },
  { id: 'win1',    text: 'Win a round or match',   goal: 1,  metric: 'wins',  coins: 500, xp: 300 },
  { id: 'win2',    text: 'Win twice',              goal: 2,  metric: 'wins',  coins: 900, xp: 500 },
  { id: 'play3',   text: 'Play 3 different modes', goal: 3,  metric: 'modes', coins: 400, xp: 200 },
];
function ensureDaily(a) {
  const today = new Date().toDateString();
  if (!a.daily || a.daily.date !== today) {
    const pool = [...QUEST_POOL], picks = [];
    while (picks.length < 3 && pool.length) picks.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
    a.daily = { date: today, modes: {}, quests: picks.map(q => ({ id: q.id, text: q.text, goal: q.goal, metric: q.metric, coins: q.coins, xp: q.xp, prog: 0, done: false })) };
  }
  return a.daily;
}
function questBump(p, metric, val, absolute) {
  const a = acctOf(p); if (!a) return;
  const d = ensureDaily(a); let changed = false, rewardXp = 0;
  for (const q of d.quests) {
    if (q.done || q.metric !== metric) continue;
    q.prog = absolute ? val : Math.min(q.goal, q.prog + val);
    if (q.prog >= q.goal) {
      q.done = true; a.coins = Math.min(100000000, (a.coins || 0) + q.coins); rewardXp += q.xp;
      if (p.ws && p.ws.readyState === 1) send(p.ws, { t: 'questDone', text: q.text, coins: q.coins, xp: q.xp });
    }
    changed = true;
  }
  if (changed) { saveAccounts(); if (rewardXp) addXp(p, rewardXp); else acctSync(p); }
}

// ---- SESSIONS (stay-logged-in tokens; in-memory, cleared on restart) -------
const sessions = {};   // token -> account key
function newSession(key) { const t = crypto.randomBytes(18).toString('hex'); sessions[t] = key; return t; }
function acctPayload(a, name) {
  const lvl = a.level || 1;
  return { name, coins: a.coins, kills: a.kills || 0, wins: a.wins || 0, cheats: a.cheats,
           xp: a.xp || 0, level: lvl, into: (a.xp || 0) - xpFloor(lvl), need: xpNeededFor(lvl),
           daily: ensureDaily(a).quests };
}

const NAMES_FILE = path.join(__dirname, 'owned-names.json');
let ownedNames = {};
try { ownedNames = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')) || {}; } catch (_) {}
function saveOwnedNames() { try { fs.writeFileSync(NAMES_FILE, JSON.stringify(ownedNames)); } catch (_) {} }

function validateName(raw, token) {
  const trimmed = ('' + raw).trim();
  if (trimmed.length < 1) return { ok:false, reason:'empty', message:'Please enter a name.' };
  const norm = normalizeName(trimmed);
  if (norm.length < 1) return { ok:false, reason:'empty', message:'Please enter a real name.' };
  // owned names: only the owner (matching token) may use them
  const ownKey = norm.toLowerCase();
  if (ownedNames[ownKey] && ownedNames[ownKey] !== token) {
    return { ok:false, reason:'owned', message:'That name is owned by another player. 🔒' };
  }
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
  shield: { shieldMs: 4000 },     // spawn protection (server-enforced)
  phase:  { phaseTrail: true },   // fainter trail (cosmetic-ish)
  swift:  { turnPrio: true },     // queue turns a touch earlier
  guard:  { shieldMs: 2500 },     // shorter shield variant
};

// ---- TEAMS: pairing + departure cleanup ------------------------------------
// Pair a newly-joined human: adopt a waiting solo human if one exists,
// otherwise spawn a bot partner. Called with the teams room active.
function joinTeam(member, teamId, color) {
  // spawnEntity painted the starter blob under member.id BEFORE the team was
  // known — migrate it onto the team id so no orphaned land is left behind.
  member.team = teamId;
  if (member.id !== teamId) transferTerritory(member.id, teamId);
  if (color) member.color = color;
  recomputeArea(member);
}
// A playable cell a couple of steps from the anchor, inside its starting patch,
// so both teammates begin in the same square.
function teamSpawnSpot(anchor) {
  const B = anchor.blob || SPAWN_BLOB;
  let best = null, bestScore = Infinity;
  for (let dy = -B; dy <= B; dy++)
    for (let dx = -B; dx <= B; dx++) {
      const x = anchor.cx + dx, y = anchor.cy + dy;
      if (!inBounds(x, y)) continue;
      const score = Math.abs((Math.abs(dx) + Math.abs(dy)) - 2);
      if (score < bestScore) { bestScore = score; best = { cx: x, cy: y }; }
    }
  return best;
}
function spawnTeamMate(anchor) {
  const spot = teamSpawnSpot(anchor);
  const mate = spawnEntity({ isBot: true, mode: 'teams', at: spot });
  if (mate) joinTeam(mate, tid(anchor), anchor.color);
  return mate;
}
function pairIntoTeam(p) {
  // a solo human = human with no living-or-dead partner entity present
  for (const o of entities.values()) {
    if (o.isBot || o.id === p.id) continue;
    if (o.team && !teammateOf(o)) {
      // Move the joining human into their partner's starting patch so both
      // teammates begin in the same square. Release the joiner's own starter
      // blob first (they haven't joined the team yet, so tid(p) === p.id).
      releaseTerritory(p);
      const spot = teamSpawnSpot(o);
      if (spot) {
        p.cx = spot.cx; p.cy = spot.cy; p.px = spot.cx + 0.5; p.py = spot.cy + 0.5;
        p.heading = headingTowardCenter(p.cx, p.cy);
        p.trailCells.length = 0; p.isOutside = false;
      }
      joinTeam(p, tid(o), o.color);
      paintSpawnBlob(p); recomputeArea(p);
      return;
    }
  }
  // no solo human waiting: anchor a fresh team and spawn a bot partner
  joinTeam(p, p.id, null);
  spawnTeamMate(p);
}
// When a team member leaves the room permanently, the grid must never keep a
// territory id that allocId() could recycle. Migrate the blob to the survivor
// or release it, and dissolve bot-only leftovers.
function teamDepart(p) {
  if (!p.team) { clearTrail(p); releaseTerritory(p); return; }
  clearTrail(p);
  const mate = teammateOf(p);
  if (!mate) { releaseTerritory(p); return; }
  if (mate.isBot && !p.isBot) {
    // human left a human+bot team: dissolve it entirely
    clearTrail(mate); releaseTerritory(mate); entities.delete(mate.id);
    return;
  }
  // surviving human keeps the land: migrate the blob onto their own id
  const oldT = tid(p);
  mate.team = mate.id;
  if (oldT !== mate.id) transferTerritory(oldT, mate.id);
  recomputeArea(mate);
  // give the survivor a fresh bot partner, in the survivor's patch
  spawnTeamMate(mate);
}

// Entity IDs are stored in Uint8Array grids, so they MUST stay in 1..255.
// We recycle the lowest free id rather than an ever-increasing counter — with
// IDs ever climbing past 255 they'd wrap (e.g. 256 -> 0) and corrupt the grid,
// which showed up as gray, uncuttable trails after long play sessions.
function allocId() {
  const used = new Set();
  for (const mode of Object.keys(rooms)) {
    for (const id of rooms[mode].entities.keys()) used.add(id);
  }
  for (let i = 1; i <= 255; i++) if (!used.has(i)) return i;
  return 0;  // 255 entities live at once should never happen (ROOM_CAP per room)
}

function spawnEntity({ isBot, name, loadout, mode, at }) {
  const id = allocId();
  if (id === 0) {  // safety: no free id (shouldn't happen) — refuse to spawn
    return null;
  }
  // Bigger starting blob if the "head start" power-up is equipped.
  const lo = sanitizeLoadout(loadout);
  const blob = lo.includes('head') ? POWERUPS.head.startBlob : SPAWN_BLOB;
  // `at` lets a teammate spawn inside the anchor's shared starting patch.
  const { cx, cy } = (at && inBoundsRaw(at.cx, at.cy)) ? { cx: at.cx, cy: at.cy } : findSpawn(id, blob);
  const shieldMs = lo.includes('shield') ? POWERUPS.shield.shieldMs
                 : lo.includes('guard') ? POWERUPS.guard.shieldMs : 0;
  const e = {
    id, isBot, name: name || (isBot ? nextBotName() : 'Player ' + id),
    color: freeColor(),
    cx, cy, blob,
    mode: VALID_MODES.includes(mode) ? mode : 'classic',
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
    // bot personality. BR bots are tougher: more aggressive hunters AND more
    // cautious (they retreat sooner, so they expose themselves less and die less).
    // BR bots are tuned to be tough-but-fun: near-perfect danger avoidance and
    // very cautious (they bank territory with short trails so they rarely get
    // cut), while still expanding and fighting. Classic bots stay moderate.
    botAggro: isBot ? (mode === 'br' ? 0.6 + Math.random() * 0.4 : 0.3 + Math.random() * 0.6) : 0,
    botGreed: isBot ? (mode === 'br' ? 5 + Math.random() * 8 : 12 + Math.random() * 28) : 0,
    botSkill: isBot ? (mode === 'br' ? 1.0 : 0.6) : 0,   // BR bots always dodge danger
    botLook: isBot ? (mode === 'br' ? 4 : 2) : 0,        // danger lookahead distance
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
  // Send all owned land back to neutral (the whole TEAM blob in teams mode —
  // callers must only invoke this when the entire team is gone/dead).
  const t = tid(e);
  for (let i = 0; i < owner.length; i++) if (owner[i] === t) owner[i] = 0;
}

function transferTerritory(fromId, toId) {
  // Killer absorbs the victim's land (Blueprint Sec 3B [CHOICE]: awarded to killer).
  for (let i = 0; i < owner.length; i++) if (owner[i] === fromId) owner[i] = toId;
}

function recomputeArea(e) {
  let n = 0;
  const t = tid(e);
  for (let i = 0; i < owner.length; i++) if (owner[i] === t) n++;
  e.area = n;
}

// ---- TOTEMS ---------------------------------------------------------------
// Neutral objects on the map. You CAPTURE one by enclosing its tile (looping
// around it), which makes that tile your territory. Ownership is read straight
// from the owner grid, so cutting/stealing land transfers totems automatically.
const TOTEM_PLAN = ['spread', 'speed', 'speed', 'slow', 'tele', 'tele']; // tele placed in pairs
const TOTEM_SPREAD_MS = 900;     // how often a spreading totem paints
const TOTEM_SPREAD_MAX = 8;      // max radius a spreading totem grows to
const TOTEM_SLOW_R = 6;          // slowing-totem hazard radius (cells)
const TOTEM_SLOW_MULT = 0.5;     // rival speed multiplier inside a slow field
const TOTEM_SPEED_STEP = 0.05;   // +5% speed per owned speed totem
const TOTEM_SPEED_MAX = 2;       // hard cap on the stacked speed multiplier
const TOTEM_TELE_CD = 5000;      // per-entity teleport cooldown (ms)

function placeTotems() {
  totems = [];
  if (!activeRoom || activeRoom.mode === 'tron') return;   // Tron has no territory to enclose
  const placed = [];
  const tryPlace = () => {
    for (let tries = 0; tries < 300; tries++) {
      const x = 6 + ((Math.random() * (GRID_W - 12)) | 0);
      const y = 6 + ((Math.random() * (GRID_H - 12)) | 0);
      if (!inBounds(x, y) || owner[idx(x, y)] !== 0) continue;   // neutral, playable
      let ok = true;
      for (const p of placed) if (Math.abs(p.x - x) + Math.abs(p.y - y) < 16) { ok = false; break; }
      if (!ok) continue;
      placed.push({ x, y }); return { x, y };
    }
    return null;
  };
  let pairAnchor = null, pairId = 1;
  for (const type of TOTEM_PLAN) {
    const p = tryPlace(); if (!p) continue;
    const t = { x: p.x, y: p.y, type, owner: 0, spreadR: 1, spreadAt: 0, _prevOwner: 0 };
    if (type === 'tele') {
      t.pair = pairId;
      if (pairAnchor == null) pairAnchor = t; else { pairAnchor = null; pairId++; }
    }
    totems.push(t);
  }
}

// Ownership follows the grid; notify a human (and their teammate) on a fresh grab.
function processTotems(now) {
  if (!totems.length) return;
  const spreadOwners = new Set();
  for (const t of totems) {
    t.owner = owner[idx(t.x, t.y)] || 0;
    if (t.owner !== t._prevOwner) {
      t._prevOwner = t.owner;
      if (t.owner) {
        const claimer = [...entities.values()].find(e => tid(e) === t.owner && !e.isBot);
        if (claimer && claimer.ws && claimer.ws.readyState === 1) send(claimer.ws, { t: 'totemGet', ty: t.type });
        if (claimer) { questBump(claimer, 'totem', 1); addXp(claimer, 20); }
      }
    }
    if (t.type === 'spread') {
      if (t.owner) {
        if (now >= (t.spreadAt || 0)) {
          t.spreadAt = now + TOTEM_SPREAD_MS;
          t.spreadR = Math.min(TOTEM_SPREAD_MAX, (t.spreadR || 1) + 1);
          const R = t.spreadR;
          for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > R) continue;
            const x = t.x + dx, y = t.y + dy;
            if (inBounds(x, y) && owner[idx(x, y)] === 0) owner[idx(x, y)] = t.owner;
          }
          spreadOwners.add(t.owner);
        }
      } else t.spreadR = 1;
    }
  }
  for (const tId of spreadOwners)
    for (const e of entities.values()) if (tid(e) === tId) recomputeArea(e);
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
  // Teams: a dead bot leaves its partner alone and its team off the board, so
  // teams bots come back fast (Classic instead refills with brand-new bots).
  e.respawnAt = Date.now() + (e.isBot ? (e.mode === 'teams' ? 4000 : BOT_RESPAWN_MS)
                                      : PLAYER_MIN_DEAD_MS);
  e.killerId = (killer && killer.id !== e.id) ? killer.id : 0;
  e.boosting = false;
  e.streak = 0;  // dying resets your own kill streak

  if (e.mode !== 'tron') clearTrail(e);        // Tron walls persist after death
  if (e.mode === 'tron') e.eliminated = true;  // out until the round resets (server-side only)
  const stolen = killer && killer.id !== e.id && !killer.dead && !sameTeam(e, killer);
  const mate = e.team ? teammateOf(e) : null;
  const mateAlive = !!(mate && !mate.dead);
  let bootToMenu = false;
  if (stolen) {
    // Teams: a single cut kills the victim but the TEAM keeps its shared blob as
    // long as the teammate is still alive. Wipe the whole team -> take it all.
    if (!e.team || !mateAlive) {
      transferTerritory(tid(e), tid(killer));
    }
    recomputeArea(killer);
    const km = killer.team ? teammateOf(killer) : null;
    if (km) recomputeArea(km);
    killer.kills = (killer.kills || 0) + 1;
    // kill streak: consecutive kills without dying -> escalating coin multiplier
    killer.streak = (killer.streak || 0) + 1;
    const streakMult = Math.min(5, killer.streak);   // x1..x5
    let coins = COIN_PER_KILL * streakMult;
    let bounty = false;
    if (e.mode === 'bounty') {
      let top = null;
      for (const o of entities.values()) if (!o.dead || o.id === e.id) { if (!top || o.area > top.area) top = o; }
      if (top && top.id === e.id) { coins *= 5; bounty = true; }
    }
    if (!killer.isBot && killer.ws && killer.ws.readyState === 1) {
      send(killer.ws, { t: 'kill', coins, total: killer.kills, streak: killer.streak, mult: streakMult, bounty });
    }
    const ka = acctOf(killer); if (ka) { ka.kills = (ka.kills || 0) + 1; creditAcct(killer, coins); addXp(killer, 12); questBump(killer, 'kills', 1); }
    // 3-kills-to-menu (Classic only): if this killer has now cut THIS victim 3+
    // times, the victim is sent back to the main menu.
    if (e.mode !== 'br' && e.mode !== 'teams' && !e.isBot) {
      e.deathsBy = e.deathsBy || {};
      e.deathsBy[killer.id] = (e.deathsBy[killer.id] || 0) + 1;
      if (e.deathsBy[killer.id] >= 3) bootToMenu = true;
    }
  } else if (!e.team || !mateAlive) {
    releaseTerritory(e);
  }
  // A dead member of a still-standing team keeps reporting the team's area.
  if (e.team && mateAlive) recomputeArea(e); else e.area = 0;

  // KILL FEED: tell everyone in the room what just happened.
  {
    const feed = JSON.stringify({ t: 'feed', reason,
      v: e.name, vc: e.color,
      k: (killer && killer.id !== e.id) ? killer.name : null,
      kc: (killer && killer.id !== e.id) ? killer.color : null });
    for (const o of entities.values()) if (!o.isBot && o.ws && o.ws.readyState === 1) o.ws.send(feed);
  }

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

// ---- BATTLE ROYALE: match lifecycle + shrinking storm ----------------------
// Begin (or restart) a BR match in the active room.
function startBrMatch(room) {
  room.brActive = true;
  room.brStart = Date.now();
  room.brStormInset = 0;
}

// The storm is a shrinking rectangle: cells outside it become void (blocked),
// so anyone caught outside dies just like hitting a wall, forcing everyone
// toward the center until one remains.
function updateBrStorm() {
  if (!activeRoom || activeRoom.mode !== 'br' || !activeRoom.brActive) return;
  const elapsed = Date.now() - activeRoom.brStart;
  if (elapsed < BR_STORM_START_MS) return;     // grace period, no shrink yet
  const prog = Math.min(1, (elapsed - BR_STORM_START_MS) / BR_STORM_SHRINK_MS);
  // max inset leaves a small arena in the middle (~24 cells across)
  const maxInset = Math.floor((Math.min(GRID_W, GRID_H) / 2) - 12);
  const inset = Math.floor(prog * maxInset);
  if (inset <= activeRoom.brStormInset) return; // only grows
  activeRoom.brStormInset = inset;
  // re-block everything outside the current map shape AND outside the storm box
  currentMap.fn();                              // restore base shape walls
  const x0 = inset, y0 = inset, x1 = GRID_W - 1 - inset, y1 = GRID_H - 1 - inset;
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (x < x0 || x > x1 || y < y0 || y > y1) blocked[idx(x, y)] = 1;
  // anyone (or any territory/trail) now standing in the storm is wiped
  for (const e of entities.values()) {
    if (!e.dead && blocked[idx(e.cx, e.cy)] === 1) {
      killEntity(e, 'storm');                   // caught by the storm
    }
  }
  for (let i = 0; i < owner.length; i++) {
    if (blocked[i] === 1) { owner[i] = 0; trail[i] = 0; }
  }
  totems = totems.filter(t => blocked[idx(t.x, t.y)] === 0);
}

// Check for a Victory Royale: one (or zero) entities left alive.
function checkBrWin() {
  if (!activeRoom || activeRoom.mode !== 'br' || !activeRoom.brActive || activeRoom.brEnding) return;
  // Need at least 2 entities to have ever been in the match (avoid instant win
  // on an empty/just-created room before bots seed).
  const total = [...entities.values()].length;
  if (total < 2) return;
  const alive = [...entities.values()].filter(e => !e.dead && !e.eliminated);
  if (alive.length > 1) return;

  // We have a winner (last one alive — human or bot).
  activeRoom.brActive = false;
  activeRoom.brEnding = true;
  const winner = alive[0] || null;
  const winnerName = winner ? winner.name : 'Nobody';
  const endingRoom = activeRoom;

  // Tell EVERY human in the room the result: the winner gets Victory + coins;
  // everyone else sees who won.
  for (const e of entities.values()) {
    if (e.isBot || !e.ws || e.ws.readyState !== 1) continue;
    if (winner && e.id === winner.id) {
      send(e.ws, { t: 'victory', coins: BR_COIN_WIN, placement: 1, winner: winnerName });
      const va = acctOf(e); if (va) { va.wins = (va.wins || 0) + 1; creditAcct(e, BR_COIN_WIN); addXp(e, 120); questBump(e, 'wins', 1); }
    } else {
      send(e.ws, { t: 'brover', winner: winnerName });
    }
  }

  // brief pause, then start a fresh BR match
  setTimeout(() => {
    const room = rooms['br'];
    if (!room) return;
    useRoom(room);
    owner.fill(0); trail.fill(0);
    applyMapShape(MAP_SHAPES[(Math.random() * MAP_SHAPES.length) | 0]);
    for (const e of [...entities.values()]) if (e.isBot) entities.delete(e.id);
    for (let i = 0; i < BR_START_BOTS; i++) spawnEntity({ isBot: true, mode: 'br' });
    for (const e of entities.values()) {
      if (!e.isBot) {
        e.eliminated = false; e.dead = false; e.kills = 0; e.streak = 0; e.deathsBy = {};
        respawnEntity(e);
        if (e.ws && e.ws.readyState === 1) send(e.ws, { t: 'brnewmatch' });
      }
    }
    room.brEnding = false;
    startBrMatch(room);
    placeTotems();
  }, 5000);
}

// ---- CAPTURE: inverse flood fill (Blueprint Sec 2A) ------------------------
// Bounding-box optimized: only consider the box covering this player's
// territory + trail, padded by 1.
function captureTerritory(e) {
  if (e.trailCells.length === 0) return;
  e._preCapArea = e.area || 0;

  let minX = GRID_W, minY = GRID_H, maxX = 0, maxY = 0;
  const expand = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  const T = tid(e);
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === T || trail[i] === e.id) {
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
      if (owner[i] === T || trail[i] === e.id) mark[bi(x, y)] = 1;
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
        if (prev !== 0 && prev !== T) touchedEnemies.add(prev);
        owner[i] = T;
        trail[i] = 0;
      }
    }

  e.trailCells.length = 0;
  e.isOutside = false;
  recomputeArea(e);
  const mateCap = e.team ? teammateOf(e) : null;
  if (mateCap) recomputeArea(mateCap);

  // Quests/XP: reward the land just banked (area delta measured by the caller's
  // recompute above; approximate via trail length + enclosed count is overkill —
  // the area recompute already ran, so diff against the pre-capture snapshot).
  if (!e.isBot && e._preCapArea != null) {
    const gained = Math.max(0, (e.area || 0) - e._preCapArea);
    if (gained > 0) { questBump(e, 'cells', gained); if (gained >= 40) addXp(e, Math.min(30, 2 + (gained / 25 | 0))); }
  }

  // Enemies who lost land: recompute; zero-territory rule => keep playing
  // (their avatar persists), matching the "release to neutral" fairness choice.
  for (const enemyId of touchedEnemies) {
    // enemyId is a TERRITORY id: recompute every entity whose blob that is.
    for (const o of entities.values()) if (tid(o) === enemyId) recomputeArea(o);
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
    const wa = acctOf(e); if (wa) { wa.wins = (wa.wins || 0) + 1; creditAcct(e, COIN_FULL_MAP); addXp(e, 100); questBump(e, 'wins', 1); }
    // Teams: the WIN belongs to both members — reward the teammate too and
    // bump the session win counters used by the teams leaderboard.
    if (e.mode === 'teams') {
      const mateW = teammateOf(e);
      if (mateW && !mateW.isBot && mateW.ws && mateW.ws.readyState === 1) {
        send(mateW.ws, { t: 'fullmap', coins: COIN_FULL_MAP });
      }
      if (activeRoom) {
        activeRoom.wins = activeRoom.wins || {};
        for (const member of [e, mateW]) {
          if (!member) continue;
          const key = (member.name || '?').toLowerCase();
          activeRoom.wins[key] = (activeRoom.wins[key] || 0) + 1;
        }
      }
    }
    roundReset(e);
  }
}

// Wipe all territory/trails and respawn every entity with a fresh beginner blob.
let roundResetting = false;   // rebound per room
function roundReset(winner) {
  roundResetting = true;
  if (activeRoom && activeRoom.mode === 'koth') { activeRoom.kothScores = {}; activeRoom.kothLeader = 0; }
  owner.fill(0);
  trail.fill(0);
  // pick a new random map shape for the next round
  const shape = MAP_SHAPES[(Math.random() * MAP_SHAPES.length) | 0];
  applyMapShape(shape);
  applyModeTerrain();
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
  placeTotems();
  roundResetting = false;
}

// ---- CHEATS (consumable, server-enforced) ----------------------------------
// The client has already verified the player owns/paid for the cheat (coins are
// client-side for now). The server applies the actual world effect so it's real
// in multiplayer. Validated against this whitelist.
const CHEAT_IDS = ['god','mach','thief','quake','titan','empire','freeze','phantom','grand'];

function largestOtherEntity(selfId) {
  let best = null;
  const self = entities.get(selfId);
  for (const e of entities.values()) {
    if (e.id === selfId || e.dead || (self && sameTeam(e, self))) continue;
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
        if (o.id === e.id || o.dead || sameTeam(o, e)) continue;
        clearTrail(o);
        let drop = Math.floor(o.area * 0.15), done = 0;
        const oT = tid(o);
        for (let i = 0; i < owner.length && done < drop; i++) {
          if (owner[i] === oT) { owner[i] = 0; done++; }
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
          if (inBounds(x, y)) owner[idx(x, y)] = tid(e);
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
    case 'grand': {                     // "grand" payout cheat — handled client-side
      return true;
    }
  }
  return false;
}

let freezeUntil = 0, freezeCasterId = 0;   // rebound per room

// ---- LOGICAL STEP into a new cell (Blueprint Sec 3A) -----------------------
function enterCell(e, x, y) {
  if (!inBounds(x, y)) { return; }   // wall is handled in advance() (slide, no death)
  const i = idx(x, y);

  // Teleport gate: stepping onto a gate YOU'VE captured warps you to its pair.
  if (totems.length) {
    for (const g of totems) {
      if (g.type === 'tele' && g.x === x && g.y === y && g.owner && g.owner === tid(e) && Date.now() >= (e.teleCd || 0)) {
        const dest = totems.find(d => d.type === 'tele' && d.pair === g.pair && d !== g);
        if (dest) {
          e.teleCd = Date.now() + TOTEM_TELE_CD;
          clearTrail(e);
          e.cx = dest.x; e.cy = dest.y; e.px = dest.x + 0.5; e.py = dest.y + 0.5; e._frac = 0;
          e.isOutside = owner[idx(dest.x, dest.y)] !== tid(e);
          if (!e.isBot && e.ws && e.ws.readyState === 1) send(e.ws, { t: 'teleport' });
          return;
        }
      }
    }
  }

  // TRON: the rules invert — running into ANY trail (yours or theirs) kills
  // YOU, and trails never disappear. Last lightcycle alive wins the round.
  if (e.mode === 'tron') {
    if (trail[i] !== 0) { killEntity(e, 'wall'); return; }
    e.cx = x; e.cy = y;
    trail[i] = e.id;
    e.trailCells.push(i);
    return;
  }
  // Stepping onto ANY active trail kills that trail's owner (RULE 1 & 2).
  // Teams exception: a TEAMMATE's trail is harmless — walk straight through it.
  const tOwner = trail[i];
  if (tOwner !== 0) {
    const victim = entities.get(tOwner);
    if (victim && !(victim.id !== e.id && sameTeam(victim, e))) {
      if (victim.id === e.id) {
        killEntity(victim, 'self');          // self-cut: territory to neutral
      } else {
        killEntity(victim, 'cut', e);        // e is the killer -> takes their land
      }
    }
    if (e.dead) return;  // self-cut: we just died
  }

  e.cx = x; e.cy = y;

  if (owner[i] === tid(e)) {
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
  if (activeRoom) {
    mult *= (activeRoom.speedMult || 1);                                  // Speed mode
    if (Date.now() < (activeRoom.chaosSpeedUntil || 0)) mult *= 1.8;      // Chaos surge
  }
  // Totems: stack owned speed totems; get slowed inside an enemy's slow field.
  if (totems.length) {
    const T = tid(e); let sp = 0, slowed = false;
    for (const t of totems) {
      if (t.type === 'speed' && t.owner === T) sp++;
      else if (t.type === 'slow' && t.owner && t.owner !== T &&
               Math.abs(t.x - e.cx) + Math.abs(t.y - e.cy) <= TOTEM_SLOW_R) slowed = true;
    }
    if (sp) mult *= Math.min(TOTEM_SPEED_MAX, 1 + TOTEM_SPEED_STEP * sp);
    if (slowed) mult *= TOTEM_SLOW_MULT;
  }
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
  if (e.mode === 'tron') return trail[i] === 0; // Tron: EVERY trail is a wall
  if (trail[i] === e.id) return false;          // our own trail = death
  return true;
}
function isTeammateTrail(e, cellTrailId) {
  if (cellTrailId === 0 || cellTrailId === e.id) return false;
  const o = entities.get(cellTrailId);
  return !!(o && sameTeam(o, e));
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
      if (t !== 0 && t !== e.id && !isTeammateTrail(e, t)) {
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
    if (cellSafeForBot(e, nx, ny) && inBounds(nx, ny) && owner[idx(nx, ny)] === tid(e)) return d;
  }
  // otherwise: head toward our territory's centroid
  let sx = 0, sy = 0, n = 0;
  const Tn = tid(e);
  for (let i = 0; i < owner.length; i++) if (owner[i] === Tn) { sx += i % GRID_W; sy += (i / GRID_W) | 0; n++; }
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
  // SURVIVE (lookahead) — skilled bots scan several cells ahead so they don't
  // trap themselves. BR bots look ~4 cells out and always react, making them
  // very hard to corner.
  if (e.botSkill && Math.random() < e.botSkill) {
    const depth = e.botLook || 2;
    for (let s = 2; s <= depth; s++) {
      if (!cellSafeForBot(e, e.cx + dx * s, e.cy + dy * s)) {
        const t = safeTurn();
        if (t) { e.pendingTurn = t; return; }
        break;
      }
    }
  }
  // FLEE — if a rival trail is very close, turn away from it early (defensive).
  if (e.botSkill >= 1) {
    const threat = nearestEnemyTrailDir(e, 4);
    if (threat && threat === e.heading) {       // heading straight at danger
      const t = safeTurn();
      if (t) { e.pendingTurn = t; return; }
    }
  }

  // HUNT — chase a nearby enemy trail if this bot is aggressive and not over-extended
  if (exposure < e.botGreed * 1.3 && Math.random() < e.botAggro * 0.5) {
    const hd = nearestEnemyTrailDir(e, 9);
    if (hd && hd !== OPP[e.heading]) {
      const [tx, ty] = DIRS[hd];
      if (cellSafeForBot(e, e.cx + tx, e.cy + ty)) { e.pendingTurn = hd; return; }
    }
  }

  // OBJECTIVE — KotH bots fight for the hill; elsewhere, bots sometimes loop
  // toward an unowned totem so humans have competition for objectives.
  if (activeRoom && Math.random() < 0.25) {
    let tx = null, ty = null;
    if (activeRoom.mode === 'koth') {
      const cx = GRID_W >> 1, cy = GRID_H >> 1, ddx = e.cx - cx, ddy = e.cy - cy;
      if (ddx * ddx + ddy * ddy > KOTH_R * KOTH_R) { tx = cx; ty = cy; }
    } else if (totems.length && Math.random() < 0.35) {
      let best = null, bd = 1e9;
      for (const t of totems) if (t.owner !== tid(e)) { const d = Math.abs(t.x - e.cx) + Math.abs(t.y - e.cy); if (d < bd && d < 45) { bd = d; best = t; } }
      if (best) { tx = best.x; ty = best.y; }
    }
    if (tx != null && exposure <= e.botGreed) {
      const dh = Math.abs(tx - e.cx) > Math.abs(ty - e.cy) ? (tx > e.cx ? 'E' : 'W') : (ty > e.cy ? 'S' : 'N');
      if (dh !== OPP[e.heading]) { const [vx, vy] = DIRS[dh];
        if (cellSafeForBot(e, e.cx + vx, e.cy + vy)) { e.pendingTurn = dh; return; } }
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
  // Battle Royale is last-one-standing: bots must NOT refill, so the field
  // shrinks to a single winner. Only Classic keeps topping up its bot count.
  if (activeRoom && activeRoom.mode === 'br') return;
  if (activeRoom && activeRoom.mode === 'teams') {
    // Every human must have a partner (replace a lost bot mate)...
    for (const e of [...entities.values()]) {
      if (!e.isBot && e.team && !teammateOf(e) && entities.size + 1 <= ROOM_CAP) {
        spawnTeamMate(e);
      }
    }
    // ...and keep at least 3 full BOT teams as rivals.
    const anchors = new Set();
    for (const e of entities.values()) if (e.isBot && e.team && !([...entities.values()].some(o => tid(o) === tid(e) && !o.isBot))) anchors.add(tid(e));
    let needTeams = 3 - anchors.size;
    while (needTeams-- > 0 && entities.size + 2 <= ROOM_CAP) {
      const a = spawnEntity({ isBot: true, mode: 'teams' });
      if (!a) break;
      joinTeam(a, a.id, null);
      spawnTeamMate(a);
    }
    return;
  }
  const alive = [...entities.values()].filter(e => !e.dead);
  const bots = alive.filter(e => e.isBot).length;
  const humansAndBots = entities.size;
  let need = MIN_BOTS - bots;
  while (need-- > 0 && humansAndBots + 1 <= ROOM_CAP) {
    spawnEntity({ isBot: true, mode: activeRoom ? activeRoom.mode : 'classic' });
  }
}

function findTeamSpawn(teamId) {
  // sample the team's owned cells; try to place a small clear pocket beside one
  const cells = [];
  for (let i = 0; i < owner.length; i += 3) if (owner[i] === teamId) cells.push(i);
  for (let tries = 0; tries < 40 && cells.length; tries++) {
    const i = cells[(Math.random() * cells.length) | 0];
    const cx = (i % GRID_W) + ((Math.random() * 7) | 0) - 3;
    const cy = ((i / GRID_W) | 0) + ((Math.random() * 7) | 0) - 3;
    if (cx > 2 && cy > 2 && cx < GRID_W - 3 && cy < GRID_H - 3 &&
        inBounds(cx, cy) && blobNeutral(cx, cy, 1, 1)) return { cx, cy };
  }
  return null;
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

// Top-level tick: run every active room's simulation in isolation. Rooms with
// no connected humans are skipped entirely (no sim, no broadcast) to save CPU
// and bandwidth — they resume the instant a player joins.
function tick() {
  for (const mode of Object.keys(rooms)) {
    const room = rooms[mode];
    let hasHuman = false;
    for (const e of room.entities.values()) { if (!e.isBot && e.ws && e.ws.readyState === 1) { hasHuman = true; break; } }
    if (!hasHuman) continue;
    useRoom(room);
    tickRoom();
  }
}

function tickRoom() {
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
      if (entities.size > ROOM_CAP) { teamDepart(e); entities.delete(e.id); continue; }
      respawnEntity(e);
    }
    // remove eliminated bots so the world stays populated with fresh ones
    if (e.dead && e.isBot && e.eliminated && now >= e.respawnAt) { entities.delete(e.id); }
  }

  const frozen = now < freezeUntil;
  for (const e of entities.values()) if (e.isBot && !e.dead && !(frozen && e.id !== freezeCasterId)) botThink(e);
  for (const e of entities.values()) { if (frozen && e.id !== freezeCasterId) continue; advance(e); }

  // Totems: reconcile ownership from the grid, run spreading, notify captures.
  processTotems(now);

  // King of the Hill: hold the central zone with your snake to score. If exactly
  // one team is inside, they earn a point each second; contested = nobody scores.
  if (activeRoom && activeRoom.mode === 'koth' && now >= (activeRoom.kothAt || 0) && !roundResetting) {
    activeRoom.kothAt = now + KOTH_TICK;
    const cx = GRID_W >> 1, cy = GRID_H >> 1, present = {};
    for (const e of entities.values()) {
      if (e.dead) continue;
      const dx = e.cx - cx, dy = e.cy - cy;
      if (dx * dx + dy * dy <= KOTH_R * KOTH_R) present[tid(e)] = (present[tid(e)] || 0) + 1;
    }
    const teams = Object.keys(present);
    activeRoom.kothLeader = teams.length === 1 ? +teams[0] : 0;
    if (activeRoom.kothLeader) {
      const leader = activeRoom.kothLeader, sc = activeRoom.kothScores;
      sc[leader] = (sc[leader] || 0) + 1;
      if (sc[leader] >= KOTH_WIN) {
        const champ = [...entities.values()].find(e => tid(e) === leader);
        const nm = champ ? champ.name : 'Someone';
        if (champ) { const wa = acctOf(champ); if (wa) { wa.wins = (wa.wins || 0) + 1; creditAcct(champ, COIN_FULL_MAP); addXp(champ, 120); questBump(champ, 'wins', 1); } }
        for (const e of entities.values()) if (!e.isBot && e.ws && e.ws.readyState === 1) send(e.ws, { t: 'kothwin', winner: nm, coins: COIN_FULL_MAP });
        activeRoom.kothScores = {}; activeRoom.kothLeader = 0;
        roundReset(champ);
      }
    }
  }

  // Battle Royale: advance the storm and check for a winner.
  if (activeRoom && activeRoom.mode === 'br') {
    // Self-heal: if there's no active match but the room has entities, start one.
    if (!activeRoom.brActive && entities.size > 0 && !activeRoom.brEnding) {
      startBrMatch(activeRoom);
    }
    const insetBefore = activeRoom.brStormInset;
    updateBrStorm();
    if (activeRoom.brStormInset !== insetBefore) {
      const blob = rleEncode(blocked);
      for (const e of entities.values()) {
        if (!e.isBot && e.ws && e.ws.readyState === 1) {
          send(e.ws, { t: 'storm', blocked: blob, inset: activeRoom.brStormInset });
        }
      }
    }
    checkBrWin();
  }

  // TRON: last one alive wins the round; then wipe the arena and relaunch.
  if (activeRoom && activeRoom.mode === 'tron' && !roundResetting) {
    const aliveT = [...entities.values()].filter(e => !e.dead);
    if (entities.size >= 2 && aliveT.length <= 1) {
      const winT = aliveT[0] || null;
      const msg = JSON.stringify({ t: 'tronwin', winner: winT ? winT.name : 'Nobody',
                                   winnerId: winT ? winT.id : 0, coins: 800 });
      for (const o of entities.values()) if (!o.isBot && o.ws && o.ws.readyState === 1) o.ws.send(msg);
      if (winT && !winT.isBot) { const ta = acctOf(winT); if (ta) { ta.wins = (ta.wins || 0) + 1; creditAcct(winT, 800); addXp(winT, 90); questBump(winT, 'wins', 1); } }
      owner.fill(0); trail.fill(0);
      currentMap.fn(); applyModeTerrain();
      for (const o of entities.values()) {
        o.dead = false; o.eliminated = false; o.trailCells = [];
        const sp = findSpawn(o.id, 1);
        o.cx = sp.cx; o.cy = sp.cy; o.px = sp.cx; o.py = sp.cy; o._frac = 0;
        o.heading = headingTowardCenter(o.cx, o.cy);
      }
    }
  }
  // CHAOS: a random global event every 20-35 seconds.
  if (activeRoom && activeRoom.mode === 'chaos' && now >= activeRoom.chaosNextAt) {
    activeRoom.chaosNextAt = now + 20000 + Math.random() * 15000;
    const pick = (Math.random() * 3) | 0;
    let label = '';
    if (pick === 0) { freezeUntil = now + 1500; activeRoom.freezeUntil = freezeUntil; freezeCasterId = 0; activeRoom.freezeCasterId = 0; label = '🧊 GLOBAL FREEZE'; }
    else if (pick === 1) { for (const o of entities.values()) if (!o.dead) clearTrail(o); label = '🌀 ALL TRAILS WIPED'; }
    else { activeRoom.chaosSpeedUntil = now + 8000; label = '🚀 SPEED SURGE'; }
    const cmsg = JSON.stringify({ t: 'chaosevent', label });
    for (const o of entities.values()) if (!o.isBot && o.ws && o.ws.readyState === 1) o.ws.send(cmsg);
  }

  // AFK PROTECTION: humans idle for 2+ minutes get booted to the menu. Their
  // socket is closed, which runs the normal departure cleanup (teams included),
  // so idle players stop squatting land and burning bandwidth.
  const AFK_MS = 120000;
  for (const e of [...entities.values()]) {
    if (e.isBot || !e.ws || e.ws.readyState !== 1) continue;
    if (e.lastInput && now - e.lastInput > AFK_MS) {
      send(e.ws, { t: 'booted', by: 'being idle (AFK)' });
      try { e.ws.close(); } catch (_) {}
    }
  }

  maintainBots();
  // Broadcast every tick (full rate). A half-rate broadcast saved bandwidth but
  // made trails look stale and cutting feel unresponsive, so it was reverted.
  // The big safe saving (skipping rooms with no players) remains in tick().
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
  // BANDWIDTH SAVER 1: if no humans are connected to this room, don't broadcast
  // anything (and the caller skips most simulation too). Bots idle cheaply.
  let humans = 0;
  for (const e of entities.values()) if (!e.isBot && e.ws && e.ws.readyState === 1) humans++;
  if (humans === 0) return;

  const ents = [];
  for (const e of entities.values()) {
    if (e.dead) continue;
    ents.push({
      id: e.id, n: e.name, c: e.color, b: e.isBot ? 1 : 0,
      x: +e.px.toFixed(1), y: +e.py.toFixed(1), h: e.heading,
      o: e.isOutside ? 1 : 0, a: e.area, d: 0,
      k: e.killerId || 0,
      kl: e.kills || 0,
      w: (activeRoom && activeRoom.wins && activeRoom.wins[(e.name || '?').toLowerCase()]) || 0,
      cn: e.isBot ? (250 + (e.kills || 0) * 150)
        : (e.account && accounts[e.account]) ? accounts[e.account].coins : (e.coins || 0),
      tm: e.team || 0,
      sz: (e.cheatSizeUntil && Date.now() < e.cheatSizeUntil ? (e.cheatSize||3) : (e.sizeMult || 1)),
      sk: e.skin || 'default',
      bo: e.boosting ? 1 : 0, sh: (e.shieldUntil && Date.now() < e.shieldUntil) ? 1 : 0,
    });
  }
  // Battle Royale: include storm timing + alive count so the client can render
  // the shrinking circle and a Fortnite-style countdown.
  let br = null;
  if (activeRoom && activeRoom.mode === 'br') {
    const now = Date.now();
    const elapsed = activeRoom.brActive ? (now - activeRoom.brStart) : 0;
    const aliveCount = [...entities.values()].filter(e => !e.dead && !e.eliminated).length;
    let phase, secsToNext;
    if (elapsed < BR_STORM_START_MS) {
      phase = 'grace';
      secsToNext = Math.ceil((BR_STORM_START_MS - elapsed) / 1000);
    } else {
      const prog = Math.min(1, (elapsed - BR_STORM_START_MS) / BR_STORM_SHRINK_MS);
      phase = prog >= 1 ? 'closed' : 'closing';
      secsToNext = Math.ceil((BR_STORM_SHRINK_MS - (elapsed - BR_STORM_START_MS)) / 1000);
    }
    br = { inset: activeRoom.brStormInset, phase, secs: Math.max(0, secsToNext), alive: aliveCount, total: BR_START_BOTS + 1 };
  }

  // NOTE: we always send the full owner grid. (An earlier "send only when
  // changed" optimization caused late-joiners to start with an empty grid and
  // desync into a corrupted display, so it was removed. The big bandwidth wins
  // are skipping empty rooms and the half-rate broadcast, which are safe.)
  let koth = null;
  if (activeRoom && activeRoom.mode === 'koth') {
    const sc = activeRoom.kothScores || {};
    koth = { cx: GRID_W >> 1, cy: GRID_H >> 1, r: KOTH_R, win: KOTH_WIN, leader: activeRoom.kothLeader || 0,
      scores: Object.keys(sc).map(id => { const e = [...entities.values()].find(x => tid(x) === +id);
        return { id: +id, name: e ? e.name : '?', color: e ? e.color : '#888', pts: sc[id] }; })
        .sort((a, b) => b.pts - a.pts).slice(0, 6) };
  }
  const msg = JSON.stringify({
    t: 'state',
    w: GRID_W, h: GRID_H,
    owner: rleEncode(owner),
    trail: rleEncode(trail),
    ents,
    br,
    koth,
    tot: totems.map(t => ({ x: t.x, y: t.y, ty: t.type, o: t.owner || 0, p: t.pair || 0 })),
  });
  for (const e of entities.values()) {
    if (e.ws && e.ws.readyState === 1) e.ws.send(msg);
  }
}

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }

// ---- HTTP (serves the client) + WS -----------------------------------------
// Only the game page is served. Everything else (server.js, accounts.json,
// owned-names.json, package.json...) stays private — critical now that we hold
// password hashes on disk.
const STATIC_OK = new Set(['/index.html']);
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (!STATIC_OK.has(p)) { res.writeHead(404); return res.end('Not found'); }
  const file = path.join(__dirname, p);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
  let player = null;
  let playerRoom = null;

  ws.on('message', (raw) => {
    // Name purchase works even before joining a game.
    try {
      const peek = JSON.parse(raw);
      if (peek && peek.t === 'buyname') {
        const nm = ('' + (peek.name || '')).trim().slice(0, 16);
        const tok = ('' + (peek.token || '')).slice(0, 64);
        const key = normalizeName(nm).toLowerCase();
        if (!key || !tok) { send(ws, { t: 'buynameResult', ok: false, reason: 'bad' }); return; }
        if (ownedNames[key] && ownedNames[key] !== tok) {
          send(ws, { t: 'buynameResult', ok: false, reason: 'taken' }); return;
        }
        ownedNames[key] = tok; saveOwnedNames();
        send(ws, { t: 'buynameResult', ok: true, name: nm });
        return;
      }
    } catch (_) { return; }
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }

    // Standalone sign-up / log-in (before joining a game). Returns a session
    // token the client stores to stay logged in and to join authenticated.
    if (m.t === 'auth') {
      const nm = ('' + (m.name || '')).slice(0, 16).trim();
      const pass = ('' + (m.pass || '')).slice(0, 64);
      const key = normalizeName(nm).toLowerCase();
      if (!key) { send(ws, { t: 'authReject', reason: 'empty', message: 'Please enter a username.' }); return; }
      for (const bw of BANNED) if (key.includes(bw)) { send(ws, { t: 'authReject', reason: 'inappropriate', message: 'That username isn\u2019t allowed.' }); return; }
      if (m.mode === 'signup') {
        if (pass.length < 4) { send(ws, { t: 'authReject', reason: 'shortpass', message: 'Password must be at least 4 characters.' }); return; }
        if (accounts[key]) { send(ws, { t: 'authReject', reason: 'taken', message: 'That username is taken \u2014 log in instead.' }); return; }
        accounts[key] = { pw: hashPassword(pass), name: nm, color: PALETTE[(Math.random() * PALETTE.length) | 0], coins: 3000, kills: 0, wins: 0, cheats: {}, lastDaily: '', xp: 0, level: 1 };
        const a = accounts[key]; ensureDaily(a);
        const today = new Date().toDateString(); if (a.lastDaily !== today) { a.lastDaily = today; a.coins = Math.min(100000000, a.coins + 500); }
        saveAccounts();
        send(ws, Object.assign({ t: 'authOk', mode: 'signup', token: newSession(key) }, acctPayload(a, nm)));
        return;
      }
      if (m.mode === 'login') {
        if (!accounts[key]) { send(ws, { t: 'authReject', reason: 'nouser', message: 'No account with that name \u2014 sign up first.' }); return; }
        if (!verifyPassword(accounts[key], pass)) { send(ws, { t: 'authReject', reason: 'wrongpass', message: 'Wrong password.' }); return; }
        const a = accounts[key]; a.name = nm; ensureDaily(a);
        const today = new Date().toDateString(); if (a.lastDaily !== today) { a.lastDaily = today; a.coins = Math.min(100000000, a.coins + 500); }
        saveAccounts();
        send(ws, Object.assign({ t: 'authOk', mode: 'login', token: newSession(key) }, acctPayload(a, nm)));
        return;
      }
      send(ws, { t: 'authReject', reason: 'bad', message: 'Unknown auth request.' }); return;
    }
    // Resume a saved session on page load.
    if (m.t === 'resume') {
      const key = sessions['' + (m.token || '')];
      if (!key || !accounts[key]) { send(ws, { t: 'authExpired' }); return; }
      const a = accounts[key];
      const today = new Date().toDateString(); if (a.lastDaily !== today) { a.lastDaily = today; a.coins = Math.min(100000000, a.coins + 500); ensureDaily(a); saveAccounts(); }
      send(ws, Object.assign({ t: 'authOk', mode: 'resume', token: '' + m.token }, acctPayload(a, a.name || key)));
      return;
    }
    // Buy a cheat straight from the shop (menu or in-game) via session token.
    if (m.t === 'buycheat' && m.token) {
      const key = sessions['' + m.token];
      if (!key || !accounts[key]) { send(ws, { t: 'buycheatResult', ok: false, reason: 'expired' }); return; }
      const a = accounts[key], cost = CHEAT_PRICES[m.id];
      if (!cost) { send(ws, { t: 'buycheatResult', ok: false }); return; }
      let qty = Math.max(1, Math.min(99, Math.floor(Number(m.qty) || 1)));
      qty = Math.min(qty, Math.floor((a.coins || 0) / cost));
      if (qty < 1) { send(ws, { t: 'buycheatResult', ok: false, reason: 'poor', coins: a.coins }); return; }
      a.coins -= cost * qty; a.cheats[m.id] = (a.cheats[m.id] || 0) + qty; saveAccounts();
      send(ws, { t: 'buycheatResult', ok: true, id: m.id, coins: a.coins, cheats: a.cheats });
      return;
    }
    // Generic coin spend for account holders (skins / power-ups / crates).
    // The client owns the *item* inventory; the server owns the coin balance.
    if (m.t === 'buy' && m.token) {
      const key = sessions['' + m.token];
      if (!key || !accounts[key]) { send(ws, { t: 'buyResult', ok: false, reason: 'expired' }); return; }
      const a = accounts[key], cost = Math.max(1, Math.floor(Number(m.cost) || 0));
      if ((a.coins || 0) < cost) { send(ws, { t: 'buyResult', ok: false, reason: 'poor', coins: a.coins }); return; }
      a.coins -= cost; saveAccounts();
      send(ws, { t: 'buyResult', ok: true, coins: a.coins });
      return;
    }

    // All-time global ranks (from persistent accounts).
    if (m.t === 'globalboard') {
      const rows = Object.keys(accounts).map(k => {
        const a = accounts[k];
        return { n: a.name || k, c: a.color || '#ffd23f', lvl: a.level || 1, k: a.kills || 0, w: a.wins || 0 };
      });
      send(ws, {
        t: 'globalboard',
        level: [...rows].sort((a, b) => b.lvl - a.lvl || b.k - a.k).slice(0, 10),
        kills: [...rows].sort((a, b) => b.k - a.k).slice(0, 10),
        wins:  [...rows].sort((a, b) => b.w - a.w).slice(0, 10),
      });
      return;
    }

    // Menu-screen side leaderboards: answer standings for anyone (even before
    // they've joined a game), read from the always-populated Classic room.
    if (m.t === 'menuboard') {
      // Persistent player stats (accounts) + live CPU kills, so a player's
      // kills/wins stay on the board even after they leave the game.
      const rows = [];
      // persistent players (accounts)
      for (const k of Object.keys(accounts)) {
        const a = accounts[k];
        rows.push({ n: a.name || k, c: a.color || '#ffd23f', b: 0, k: a.kills || 0, w: a.wins || 0, lvl: a.level || 1 });
      }
      // live CPUs (Classic) + live GUESTS in any room (no account) — these are
      // temporary and drop off the board as soon as the guest leaves the game.
      for (const mode of Object.keys(rooms)) {
        for (const e of rooms[mode].entities.values()) {
          if (e.isBot) { if (mode === 'classic') rows.push({ n: e.name, c: e.color, b: 1, k: e.kills || 0, w: 0 }); }
          else if (!e.account) rows.push({ n: e.name, c: e.color, b: 0, k: e.kills || 0, w: 0 });
        }
      }
      const kills = [...rows].sort((a, b) => b.k - a.k || b.w - a.w).slice(0, 8);
      const wins = [...rows].sort((a, b) => b.w - a.w || b.k - a.k).slice(0, 8);
      send(ws, { t: 'menuboard', kills, wins });
      return;
    }

    if (m.t === 'join') {
      if (player) return;  // already joined
      const mode = VALID_MODES.includes(m.mode) ? m.mode : 'classic';
      playerRoom = getRoom(mode);
      useRoom(playerRoom);
      // capacity check is per-room
      if ([...entities.values()].filter(e => !e.isBot).length + 1 > ROOM_CAP) {
        send(ws, { t: 'full' });
        return;
      }
      const nm = ('' + (m.name || 'Player')).slice(0, 16).trim();
      const verdict = validateName(nm, typeof m.nameToken === 'string' ? m.nameToken.slice(0, 64) : null);
      if (!verdict.ok) {
        send(ws, { t: 'nameReject', reason: verdict.reason, message: verdict.message });
        return;
      }
      // AUTH: sign up (new account), log in (existing), or guest (no account).
      const auth = ['login', 'signup', 'session'].includes(m.auth) ? m.auth : 'guest';
      const pass = ('' + (m.pass || m.pin || '')).trim().slice(0, 64);
      let akey = normalizeName(nm || 'Player').toLowerCase();
      if (auth === 'session') {
        const skey = sessions['' + (m.token || '')];
        if (!skey || !accounts[skey]) { send(ws, { t: 'authReject', reason: 'expired', message: 'Session expired \u2014 please log in again.' }); return; }
        akey = skey;
      } else if (auth === 'signup') {
        if (pass.length < 4) { send(ws, { t: 'authReject', reason: 'shortpass', message: 'Password must be at least 4 characters.' }); return; }
        if (accounts[akey]) { send(ws, { t: 'authReject', reason: 'taken', message: 'That username is taken — try logging in.' }); return; }
      } else if (auth === 'login') {
        if (!accounts[akey]) { send(ws, { t: 'authReject', reason: 'nouser', message: 'No account with that name — sign up first.' }); return; }
        if (!verifyPassword(accounts[akey], pass)) { send(ws, { t: 'authReject', reason: 'wrongpass', message: 'Wrong password.' }); return; }
      } else if (accounts[akey]) {
        send(ws, { t: 'authReject', reason: 'registered', message: 'That name is registered — log in or pick another.' }); return;
      }

      player = spawnEntity({ isBot: false, name: nm || 'Player', loadout: m.loadout, mode });
      if (!player) { send(ws, { t: 'full' }); return; }   // no free id (very unlikely)
      player.ws = ws;
      player.room = playerRoom;
      player.skin = (typeof m.skin === 'string') ? m.skin.slice(0, 24) : 'default';
      if (mode === 'teams') pairIntoTeam(player);
      player.lastInput = Date.now();

      if (auth === 'signup') {
        accounts[akey] = { pw: hashPassword(pass), name: nm, color: player.color,
                           coins: 3000, kills: 0, wins: 0, cheats: {}, lastDaily: '' };
      }
      if (auth !== 'guest') {
        player.account = akey;
        const a = accounts[akey];
        a.name = nm; if (!a.color) a.color = player.color;   // keep display name/color fresh
        const today = new Date().toDateString();
        if (a.lastDaily !== today) { a.lastDaily = today; a.coins = Math.min(100000000, a.coins + 500); }
        saveAccounts();
        const d = ensureDaily(a); d.modes[mode] = 1;
        a.level = levelFromXp(a.xp || 0);
        const lvl = a.level || 1;
        send(ws, { t: 'acct', coins: a.coins, kills: a.kills, wins: a.wins, cheats: a.cheats, name: nm,
                   xp: a.xp || 0, level: lvl, into: (a.xp || 0) - xpFloor(lvl), need: xpNeededFor(lvl), daily: d.quests });
      }
      if (player.account) { addXp(player, 15); const da = acctOf(player); if (da) questBump(player, 'modes', Object.keys(ensureDaily(da).modes).length, true); }
      // client-reported coin balance for the teams leaderboard (self-reported;
      // clamped to sane bounds — see honesty note: no accounts yet)
      const cn = Number(m.coins);
      player.coins = Number.isFinite(cn) ? Math.max(0, Math.min(100000000, cn)) : 0;
      send(ws, { t: 'welcome', id: player.id, w: GRID_W, h: GRID_H, loadout: player.loadout,
                 boostMs: BOOST_DURATION_MS, cooldownMs: BOOST_COOLDOWN_MS, mode: player.mode,
                 mapId: currentMap.id, mapName: currentMap.name, blocked: rleEncode(blocked),
                 outline: mapOutline() });
      return;
    }

    // all other messages operate within the player's room
    if (!player || !playerRoom) return;
    player.lastInput = Date.now();
    if (m.t === 'buycheat') {
      const a = acctOf(player); const cost = CHEAT_PRICES[m.id];
      if (!a || !cost) { send(ws, { t: 'buycheatResult', ok: false }); return; }
      let qty = Math.max(1, Math.min(99, Math.floor(Number(m.qty) || 1)));
      qty = Math.min(qty, Math.floor((a.coins || 0) / cost));   // only what they can afford
      if (qty < 1) { send(ws, { t: 'buycheatResult', ok: false, reason: 'poor', coins: a.coins }); return; }
      a.coins -= cost * qty; a.cheats[m.id] = (a.cheats[m.id] || 0) + qty; saveAccounts();
      send(ws, { t: 'buycheatResult', ok: true, id: m.id, coins: a.coins, cheats: a.cheats });
      return;
    }
    if (m.t === 'coins') {
      if (player.account) return;                  // server owns account balances
      const n = Number(m.n);
      if (Number.isFinite(n)) player.coins = Math.max(0, Math.min(100000000, n));
      return;
    }
    useRoom(playerRoom);

    if (m.t === 'turn' && !player.dead) {
      if (['N', 'E', 'S', 'W'].includes(m.d)) player.pendingTurn = m.d;  // intent only
    } else if (m.t === 'boost' && !player.dead && player.hasBoost) {
      const now = Date.now();
      if (!player.boosting && now >= player.boostReadyAt) {
        player.boosting = true;
        player.boostUntil = now + BOOST_DURATION_MS;
      }
    } else if (m.t === 'cheat' && !player.dead) {
      if (CHEAT_IDS.includes(m.id)) {
        const a = acctOf(player);
        if (!a) { send(ws, { t: 'cheatResult', id: m.id, ok: false, reason: 'guest' }); return; }
        if (!a.cheats[m.id] || a.cheats[m.id] <= 0) {
          send(ws, { t: 'cheatResult', id: m.id, ok: false, reason: 'notowned' });
          return;
        }
        a.cheats[m.id]--; saveAccounts();
        const ok = applyCheat(player, m.id);
        send(ws, { t: 'cheatResult', id: m.id, ok });
      }
    } else if (m.t === 'respawn' && player.dead) {
      // Tron: no mid-round respawns — you're out until the round resets.
      if (!player.eliminated && player.mode !== 'tron') respawnEntity(player);
    } else if (m.t === 'chat') {
      const nowC = Date.now();
      if (player.lastChatAt && nowC - player.lastChatAt < 600) return;
      player.lastChatAt = nowC;
      const text = ('' + (m.text || '')).slice(0, 120).trim();
      if (text) {
        const out = JSON.stringify({ t: 'chat', name: player.name, color: player.color, text });
        for (const e of entities.values()) if (e.ws && e.ws.readyState === 1) e.ws.send(out);
        maybeBotReply(text);
      }
    }
  });

  ws.on('close', () => {
    if (player && playerRoom) {
      useRoom(playerRoom);
      teamDepart(player); entities.delete(player.id);
    }
  });
});

// Pre-create the three mode rooms so bots are populated and ready before the
// first player joins each one.
for (const mode of VALID_MODES) getRoom(mode);

setInterval(tick, 1000 / TICK_RATE);
server.listen(PORT, () => {
  console.log(`Paper.io-class server on http://localhost:${PORT}  (${TICK_RATE} ticks/s, rooms: ${VALID_MODES.join(', ')})`);
});
