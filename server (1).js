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
let pickups = [];                     // collectible coin pickups; rebound by useRoom()
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
    pickups: [],
    pickupAt: 0,
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
  activeRoom.pickups = pickups;
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
  pickups = room.pickups;
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
    placePickups();
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
// ---- ACCOUNT PERSISTENCE --------------------------------------------------
// Render's FREE tier has an EPHEMERAL disk: accounts.json is wiped whenever the
// server sleeps (15-min idle) or redeploys, which is why accounts "disappear".
// To persist for real, create a FREE Upstash Redis database and set two env vars
// on Render:  UPSTASH_REDIS_REST_URL  and  UPSTASH_REDIS_REST_TOKEN
// With those set, accounts survive every restart/deploy. With nothing set, we
// fall back to the local file exactly as before. (DATA_DIR can point the file at
// a mounted persistent disk if you use that route instead.)
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY = 'territory:accounts';
const useKV = !!(KV_URL && KV_TOKEN);
const ACCTS_FILE = path.join(process.env.DATA_DIR || __dirname, 'accounts.json');
let accounts = {};

async function kvCmd(cmd) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error('http ' + res.status);
  return res.json();
}
async function loadAccounts() {
  if (useKV) {
    try {
      const r = await kvCmd(['GET', KV_KEY]);
      if (r && r.result) { accounts = JSON.parse(r.result) || {}; console.log('accounts: loaded ' + Object.keys(accounts).length + ' from Upstash'); return; }
      console.log('accounts: Upstash empty — starting fresh'); return;
    } catch (e) { console.log('accounts: Upstash load failed (' + e.message + '); using local file'); }
  }
  try { accounts = JSON.parse(fs.readFileSync(ACCTS_FILE, 'utf8')) || {}; } catch (_) {}
}
let acctSaveTimer = null;
function saveAccounts() {            // throttled write
  if (acctSaveTimer) return;
  acctSaveTimer = setTimeout(() => {
    acctSaveTimer = null;
    const data = JSON.stringify(accounts);
    if (useKV) { kvCmd(['SET', KV_KEY, data]).catch(() => { try { fs.writeFileSync(ACCTS_FILE, data); } catch (_) {} }); }
    else { try { fs.writeFileSync(ACCTS_FILE, data); } catch (_) {} }
  }, 500);
}
// Best-effort flush so a pending throttled write isn't lost when the host stops us.
function flushAccountsSync() { try { fs.writeFileSync(ACCTS_FILE, JSON.stringify(accounts)); } catch (_) {} }
process.on('SIGTERM', () => { flushAccountsSync(); process.exit(0); });
process.on('SIGINT', () => { flushAccountsSync(); process.exit(0); });
loadAccounts();
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
const TOTEM_SPEED_MULT = 1.5;    // each owned speed totem multiplies speed x1.5 (stacks)
const TOTEM_SPEED_MAX = 8;       // sanity cap so movement stays controllable
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

// ---- COIN PICKUPS (collect by driving over them) --------------------------
const PICKUP_MAX = 8;
const PICKUP_VAL = 120;
function addPickup() {
  for (let tries = 0; tries < 120; tries++) {
    const x = 6 + ((Math.random() * (GRID_W - 12)) | 0);
    const y = 6 + ((Math.random() * (GRID_H - 12)) | 0);
    if (!inBounds(x, y) || owner[idx(x, y)] !== 0) continue;
    if (pickups.some(p => p.x === x && p.y === y)) continue;
    pickups.push({ x, y, val: PICKUP_VAL }); return true;
  }
  return false;
}
function placePickups() {
  pickups = [];
  if (!activeRoom || activeRoom.mode === 'tron') return;
  for (let i = 0; i < PICKUP_MAX; i++) addPickup();
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
  pickups = pickups.filter(p => blocked[idx(p.x, p.y)] === 0);
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
    placePickups();
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
  placePickups();
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

  // Coin pickup: driving over one grabs it (humans earn coins + a little XP).
  if (pickups.length) {
    const pi = pickups.findIndex(pk => pk.x === x && pk.y === y);
    if (pi >= 0) {
      const pk = pickups[pi]; pickups.splice(pi, 1);
      if (!e.isBot) {
        if (acctOf(e)) creditAcct(e, pk.val);
        addXp(e, 5);
        if (e.ws && e.ws.readyState === 1) send(e.ws, { t: 'pickup', coins: pk.val, x, y });
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
    if (sp) mult *= Math.min(TOTEM_SPEED_MAX, Math.pow(TOTEM_SPEED_MULT, sp));
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
  // Keep coin pickups topped up over time.
  if (activeRoom && activeRoom.mode !== 'tron' && pickups.length < PICKUP_MAX && now >= (activeRoom.pickupAt || 0)) {
    activeRoom.pickupAt = now + 3000; addPickup();
  }

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
    pick: pickups.map(p => ({ x: p.x, y: p.y })),
  });
  for (const e of entities.values()) {
    if (e.ws && e.ws.readyState === 1) e.ws.send(msg);
  }
}

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }

// ---- HTTP (serves the client) + WS -----------------------------------------
const FAVICON = Buffer.from('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', 'base64');
// Only the game page is served. Everything else (server.js, accounts.json,
// owned-names.json, package.json...) stays private — critical now that we hold
// password hashes on disk.
const STATIC_OK = new Set(['/index.html']);
const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(FAVICON); }
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
