// server.js - Planet.io Online v4.0.0
// TON Connect lootbox purchases + secure auto-payout for skin sales
'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { Pool } = require('pg');
const {
  TonClient,
  WalletContractV5R1,
  WalletContractV4,
  WalletContractV3R1,
  WalletContractV3R2,
  internal,
  SendMode,
  Address,
  beginCell,
  toNano
} = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6
});

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const TON_API_KEY = process.env.TON_API_KEY || '';
const TON_ENDPOINT = process.env.TON_ENDPOINT || 'https://toncenter.com/api/v2/jsonRPC';
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const ICON_URL = process.env.ICON_URL || '';
const TWA_RETURN_URL = process.env.TWA_RETURN_URL || '';
const ENV_MNEMONIC = process.env.TON_MNEMONIC || '';
const ENV_WALLET_VERSION = process.env.TON_WALLET_VERSION || '';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '262626');
const LOOTBOX_MAX_SERIAL = 999;

const ORDER_UI_TTL_MS = 30 * 60 * 1000;         // how long the UI treats an order as fresh
const ORDER_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000; // late payments are still delivered for 24h
const TX_VALID_FOR_SEC = 5 * 60;                // TonConnect validUntil
const SCAN_INTERVAL_MS = 4000;
const PAYOUT_WORKER_INTERVAL_MS = 7000;
const PAYOUT_RETRY_BACKOFF_MS = 30000;
const PAYOUT_MAX_ATTEMPTS = 3;
const SEQNO_WAIT_MS = 65000;
const FEE_RESERVE_NANO = toNano('0.02');
const MIN_LOOTBOX_PRICE = 0.001;
const MAX_PENDING_ORDERS_PER_USER = 5;
const PUBLIC_SETTING_KEYS = ['lootbox_price', 'lootbox_remaining', 'lootbox_tag', 'autopay_enabled'];

const WORLD_RADIUS = 1200;
const CX = 1500, CY = 1500;
const FOOD_COUNT = 500;
const BOT_COUNT = 18;
const TICK_RATE = 60;
const START_MASS = 22;
const MAX_CELLS = 16;
const MERGE_TIME = 20;
const MIN_SPLIT_MASS = 36;
const MIN_EJECT_MASS = 34;
const EJECT_MASS_AMOUNT = 14;
const EJECT_COST = 18;
const EAT_MASS_RATIO = 1.15;
const EAT_OVERLAP = 0.4;
const SPLIT_LAUNCH_SPEED = 1300;
const MASS_DECAY_RATE = 0.002;
const MASS_DECAY_MIN = 40;

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.stack ? e.stack : e));

/* ================= SECURITY HELPERS ================= */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const rateBuckets = new Map();
function rateLimited(key, ms) {
  const now = Date.now();
  const last = rateBuckets.get(key) || 0;
  if (now - last < ms) return true;
  rateBuckets.set(key, now);
  if (rateBuckets.size > 5000) {
    for (const [k, t] of rateBuckets) if (now - t > 60000) rateBuckets.delete(k);
  }
  return false;
}

function deriveKey(password) {
  return crypto.scryptSync(String(password), 'planetio_salt_v1', 32);
}
function encryptMnemonic(mnemonic, password) {
  const key = deriveKey(password);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(mnemonic, 'utf8', 'base64');
  enc += cipher.final('base64');
  const tag = cipher.getAuthTag().toString('base64');
  return iv.toString('base64') + ':' + enc + ':' + tag;
}
function decryptMnemonic(payload, password) {
  try {
    const parts = String(payload).split(':');
    if (parts.length !== 3) return null;
    const key = deriveKey(password);
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(parts[1], 'base64', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch (e) { return null; }
}

/* ================= TON ADDRESS / WALLET HELPERS ================= */
// Accepts friendly (EQ/UQ) or raw (0:hex) mainnet addresses. Returns a non-bounceable friendly string.
function normalizeUserAddress(input) {
  const s = String(input || '').trim();
  if (!s || s.length > 100) return null;
  try {
    let addr;
    if (Address.isFriendly(s)) {
      const parsed = Address.parseFriendly(s);
      if (parsed.isTestOnly) return null;
      addr = parsed.address;
    } else {
      addr = Address.parse(s);
    }
    return addr.toString({ bounceable: false, testOnly: false, urlSafe: true });
  } catch (e) { return null; }
}

function createWallet(versionId, publicKey) {
  try {
    switch (versionId) {
      case 'v5r1':
        return WalletContractV5R1.create({ workchain: 0, publicKey });
      case 'v5r1-1':
        return WalletContractV5R1.create({
          workchain: 0,
          publicKey,
          walletId: {
            networkGlobalId: -239,
            context: { walletVersion: 'v5r1', workchain: 0, subwalletNumber: 1 }
          }
        });
      case 'v4r2': return WalletContractV4.create({ workchain: 0, publicKey });
      case 'v3r2': return WalletContractV3R2.create({ workchain: 0, publicKey });
      case 'v3r1': return WalletContractV3R1.create({ workchain: 0, publicKey });
      default: return WalletContractV5R1.create({ workchain: 0, publicKey });
    }
  } catch (e) {
    console.error('createWallet ' + versionId + ':', e.message);
    return null;
  }
}

function walletAddressString(w) {
  return w.address.toString({ bounceable: false, testOnly: false, urlSafe: true });
}

function deriveAllWallets(publicKey) {
  const variants = [
    { id: 'v5r1', name: 'W5 · V5R1 (sub=0) · Tonkeeper default' },
    { id: 'v5r1-1', name: 'W5 · V5R1 (sub=1) · alt' },
    { id: 'v4r2', name: 'V4R2 · MyTonWallet / most' },
    { id: 'v3r2', name: 'V3R2 · legacy' },
    { id: 'v3r1', name: 'V3R1 · legacy' }
  ];
  const out = [];
  for (const v of variants) {
    const w = createWallet(v.id, publicKey);
    if (!w) continue;
    try {
      out.push({ id: v.id, name: v.name, address: walletAddressString(w) });
    } catch (e) {
      console.error('derive ' + v.id + ':', e.message);
    }
  }
  return out;
}

function parseMnemonicWords(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length !== 12 && words.length !== 24) return null;
  return words;
}

function randomMemo() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let out = 'PIO';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function commentPayloadBase64(text) {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell().toBoc().toString('base64');
}

function parseCommentFromBody(body) {
  try {
    if (!body) return null;
    const s = body.beginParse();
    if (s.remainingBits < 32) return null;
    if (s.loadUint(32) !== 0) return null;
    return s.loadStringTail().trim();
  } catch (e) { return null; }
}

function txHashHex(tx) {
  try { return tx.hash().toString('hex'); } catch (e) { return null; }
}

/* ================= DATABASE ================= */
let db = null;
let dbReady = false;

if (DATABASE_URL) {
  const isInternal = DATABASE_URL.includes('.railway.internal');
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: isInternal ? false : { rejectUnauthorized: false },
    max: 10
  });
  db.on('error', (e) => console.error('pg pool error:', e.message));
} else {
  console.warn('⚠️ DATABASE_URL not set — payments and progress are disabled');
}

const DEFAULT_SKINS_JSON = '[{"id":"default","serial":null,"source":"starter","acquiredAt":0}]';

async function initDatabase() {
  if (!db) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        tokens INTEGER DEFAULT 0,
        speed_level INTEGER DEFAULT 0,
        mass_level INTEGER DEFAULT 0,
        unlocked_skins TEXT DEFAULT '${DEFAULT_SKINS_JSON}',
        current_skin TEXT DEFAULT 'default',
        total_kills INTEGER DEFAULT 0,
        high_score INTEGER DEFAULT 0,
        wallet_address TEXT DEFAULT '',
        created_at BIGINT,
        last_seen BIGINT
      );
    `);
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT DEFAULT '';`);

    await db.query(`CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT);`);
    const defaults = [['lootbox_price', '0.01'], ['lootbox_remaining', '-1'], ['lootbox_tag', ''], ['autopay_enabled', '0']];
    for (const [k, v] of defaults) {
      await db.query(`INSERT INTO admin_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING;`, [k, v]);
    }

    await db.query(`
      CREATE TABLE IF NOT EXISTS sell_requests (
        id SERIAL PRIMARY KEY,
        user_id TEXT,
        user_wallet TEXT,
        skin_id TEXT,
        skin_serial INTEGER,
        price_ton NUMERIC(12,6),
        status TEXT DEFAULT 'pending',
        tx_hash TEXT,
        created_at BIGINT,
        paid_at BIGINT
      );
    `);
    await db.query(`ALTER TABLE sell_requests ADD COLUMN IF NOT EXISTS error TEXT;`);
    await db.query(`ALTER TABLE sell_requests ADD COLUMN IF NOT EXISTS attempts INTEGER DEFAULT 0;`);
    await db.query(`ALTER TABLE sell_requests ADD COLUMN IF NOT EXISTS updated_at BIGINT;`);
    await db.query(`CREATE INDEX IF NOT EXISTS sell_requests_status_idx ON sell_requests (status);`);
    await db.query(`CREATE INDEX IF NOT EXISTS sell_requests_user_idx ON sell_requests (user_id);`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS skin_prices (
        skin_id TEXT PRIMARY KEY,
        sell_price NUMERIC(12,6) DEFAULT 0,
        is_sellable BOOLEAN DEFAULT FALSE
      );
    `);
    for (const s of ['mind', 'knight', 'rage']) {
      await db.query(
        `INSERT INTO skin_prices (skin_id, sell_price, is_sellable) VALUES ($1, 0, FALSE) ON CONFLICT (skin_id) DO NOTHING;`,
        [s]
      );
    }
    await db.query(`DELETE FROM skin_prices WHERE skin_id = 'fire';`);

    // legacy table (old client-chosen memos) — kept so old data is not lost
    await db.query(`CREATE TABLE IF NOT EXISTS claimed_memos (memo TEXT PRIMARY KEY, user_id TEXT, claimed_at BIGINT);`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS lootbox_orders (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        memo TEXT UNIQUE NOT NULL,
        amount_nano BIGINT NOT NULL,
        status TEXT DEFAULT 'pending',
        tx_hash TEXT UNIQUE,
        payer TEXT,
        skin_id TEXT,
        serial INTEGER,
        seen BOOLEAN DEFAULT FALSE,
        error TEXT,
        created_at BIGINT,
        paid_at BIGINT
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS lootbox_orders_status_idx ON lootbox_orders (status);`);
    await db.query(`CREATE INDEX IF NOT EXISTS lootbox_orders_user_idx ON lootbox_orders (user_id);`);

    await db.query(`CREATE SEQUENCE IF NOT EXISTS lootbox_serial_seq START 1 MAXVALUE ${LOOTBOX_MAX_SERIAL};`);

    // crash recovery: anything that was mid-flight when the process died is ambiguous → needs a human look
    await db.query(`UPDATE sell_requests SET status = 'check_needed', error = 'Server restarted during payout — verify on chain' WHERE status = 'processing';`);
    await db.query(`UPDATE lootbox_orders SET status = 'refund_failed', error = 'Server restarted during refund — verify on chain' WHERE status = 'refunding';`);

    dbReady = true;
    console.log('✅ Database ready');
  } catch (e) {
    console.error('❌ DB init error:', e.message);
    dbReady = false;
  }
}

function normalizeSkins(skins) {
  let arr = skins;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch (e) { arr = null; }
  }
  if (!Array.isArray(arr)) arr = [];
  const out = [];
  let hasDefault = false;
  for (const s of arr) {
    if (typeof s === 'string') {
      if (s === 'fire') continue;
      out.push({ id: s, serial: null, source: s === 'default' ? 'starter' : 'legacy', acquiredAt: 0 });
      if (s === 'default') hasDefault = true;
    } else if (s && s.id) {
      if (s.id === 'fire') continue;
      out.push({
        id: String(s.id),
        serial: (typeof s.serial === 'number') ? s.serial : null,
        source: s.source || 'unknown',
        acquiredAt: s.acquiredAt || 0
      });
      if (s.id === 'default') hasDefault = true;
    }
  }
  if (!hasDefault) out.unshift({ id: 'default', serial: null, source: 'starter', acquiredAt: 0 });
  return out;
}

async function getOrCreateUser(id, username, firstName) {
  if (!dbReady) return {
    telegram_id: id, username, first_name: firstName,
    tokens: 0, speed_level: 0, mass_level: 0,
    unlocked_skins: DEFAULT_SKINS_JSON,
    current_skin: 'default', total_kills: 0, high_score: 0, wallet_address: ''
  };
  try {
    const r = await db.query('SELECT * FROM users WHERE telegram_id = $1', [id]);
    if (r.rows.length === 0) {
      await db.query(
        `INSERT INTO users (telegram_id, username, first_name, created_at, last_seen)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (telegram_id) DO NOTHING`,
        [id, username, firstName, Date.now(), Date.now()]
      );
      const r2 = await db.query('SELECT * FROM users WHERE telegram_id = $1', [id]);
      return r2.rows[0];
    }
    await db.query('UPDATE users SET last_seen = $1, username = $2 WHERE telegram_id = $3', [Date.now(), username, id]);
    return r.rows[0];
  } catch (e) {
    console.error('getOrCreateUser:', e.message);
    return null;
  }
}

const INT_MAX = 2000000000;
function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

// NOTE: unlocked_skins is server-authoritative. The client can never write it (it used to be possible,
// which let a modified client give itself any skin and sell it for TON).
async function saveProgress(id, data) {
  if (!dbReady || !data) return false;
  try {
    const cur = await db.query('SELECT unlocked_skins FROM users WHERE telegram_id = $1', [id]);
    if (cur.rows.length === 0) return false;
    const owned = normalizeSkins(cur.rows[0].unlocked_skins);
    let currentSkin = String(data.currentSkin || 'default');
    if (!owned.some(s => s.id === currentSkin)) currentSkin = 'default';
    await db.query(
      `UPDATE users SET
        tokens = $1, speed_level = $2, mass_level = $3,
        current_skin = $4, total_kills = $5, high_score = $6, last_seen = $7
       WHERE telegram_id = $8`,
      [
        clampInt(data.tokens, 0, INT_MAX),
        clampInt(data.speedLevel, 0, 50),
        clampInt(data.massLevel, 0, 15),
        currentSkin,
        clampInt(data.totalKills, 0, INT_MAX),
        clampInt(data.highScore, 0, INT_MAX),
        Date.now(),
        id
      ]
    );
    return true;
  } catch (e) {
    console.error('saveProgress:', e.message);
    return false;
  }
}

const SETTING_FALLBACK = { lootbox_price: '0.01', lootbox_remaining: '-1', lootbox_tag: '', autopay_enabled: '0' };

// Only whitelisted keys ever leave the server (the encrypted mnemonic used to be broadcast to every client!).
async function getPublicSettings() {
  if (!dbReady) return Object.assign({}, SETTING_FALLBACK);
  try {
    const r = await db.query('SELECT key, value FROM admin_settings WHERE key = ANY($1)', [PUBLIC_SETTING_KEYS]);
    const out = Object.assign({}, SETTING_FALLBACK);
    for (const row of r.rows) out[row.key] = row.value;
    return out;
  } catch (e) { return Object.assign({}, SETTING_FALLBACK); }
}

async function setAdminSetting(key, value) {
  if (!dbReady) return false;
  try {
    await db.query(
      'INSERT INTO admin_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, String(value)]
    );
    return true;
  } catch (e) { return false; }
}

async function getAdminSetting(key) {
  if (!dbReady) return null;
  try {
    const r = await db.query('SELECT value FROM admin_settings WHERE key = $1', [key]);
    return r.rows.length > 0 ? r.rows[0].value : null;
  } catch (e) { return null; }
}

function getLootboxPrice(settings) {
  const p = parseFloat(settings.lootbox_price);
  if (!Number.isFinite(p) || p < MIN_LOOTBOX_PRICE) return MIN_LOOTBOX_PRICE;
  return Math.min(p, 100000);
}
/* ================= GAME ================= */
const players = new Map();
const botPlayers = new Map();
const food = [];

function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function massToRadius(m) { return Math.sqrt(m) * 4.5; }
function massToSpeed(m) { return 22 * Math.pow(m, -0.32) * 4.5; }
function randomWorldPos(margin) {
  margin = margin || 30;
  const maxR = Math.max(50, WORLD_RADIUS - margin);
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * maxR;
  return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r };
}
function getTotalMass(p) { let s = 0; for (const c of p.cells) s += c.mass; return s; }
function getCenter(p) {
  let tot = 0, sx = 0, sy = 0;
  for (const c of p.cells) { tot += c.mass; sx += c.x * c.mass; sy += c.y * c.mass; }
  return tot > 0 ? { x: sx / tot, y: sy / tot } : { x: CX, y: CY };
}
function spawnFood() {
  const pos = randomWorldPos(30);
  return { x: pos.x, y: pos.y, r: randInt(80, 255), g: randInt(80, 255), b: randInt(80, 255) };
}
for (let i = 0; i < FOOD_COUNT; i++) food.push(spawnFood());

function createPlayer(id, name, color, startMass, isBot) {
  const pos = randomWorldPos(200);
  return {
    id, name: name || 'Player', color: color || '#4a9eff',
    cells: [{ x: pos.x, y: pos.y, mass: startMass || START_MASS, vx: 0, vy: 0, mergeTimer: 0 }],
    targetX: pos.x, targetY: pos.y,
    alive: true, kills: 0, maxMass: startMass || START_MASS,
    isBot: !!isBot, botTimer: 0
  };
}

function updateCell(cell, dt, tx, ty) {
  const dx = tx - cell.x, dy = ty - cell.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.5) return;
  const speed = massToSpeed(cell.mass) * 10;
  const dirX = dx / d, dirY = dy / d;
  let moveSpeed = speed;
  if (d < 40) moveSpeed = speed * (d / 40);
  cell.x += dirX * moveSpeed * dt;
  cell.y += dirY * moveSpeed * dt;
  const r = massToRadius(cell.mass);
  const dxC = cell.x - CX, dyC = cell.y - CY;
  const distC = Math.sqrt(dxC * dxC + dyC * dyC);
  const maxDist = WORLD_RADIUS - r;
  if (distC > maxDist) {
    const nx = dxC / distC, ny = dyC / distC;
    cell.x = CX + nx * maxDist;
    cell.y = CY + ny * maxDist;
  }
  if (cell.mass > MASS_DECAY_MIN) cell.mass -= cell.mass * MASS_DECAY_RATE * dt;
  if (cell.mergeTimer > 0) cell.mergeTimer -= dt;
}

function tick(dt) {
  const allPlayers = [...players.values(), ...botPlayers.values()];
  for (const bot of botPlayers.values()) {
    if (!bot.alive) continue;
    bot.botTimer -= dt;
    if (bot.botTimer > 0) continue;
    bot.botTimer = 0.15 + Math.random() * 0.15;
    const bc = getCenter(bot);
    const bm = getTotalMass(bot);
    let bestFood = null, bestFoodD = Infinity;
    for (let i = 0; i < food.length; i += 2) {
      const f = food[i];
      const d2 = (f.x - bc.x) ** 2 + (f.y - bc.y) ** 2;
      if (d2 < bestFoodD && d2 < 500 * 500) { bestFoodD = d2; bestFood = f; }
    }
    let threat = null, threatD = Infinity, prey = null, preyD = Infinity;
    for (const other of allPlayers) {
      if (other === bot || !other.alive) continue;
      const oc = getCenter(other);
      const om = getTotalMass(other);
      const d2 = (oc.x - bc.x) ** 2 + (oc.y - bc.y) ** 2;
      if (d2 > 500 * 500) continue;
      if (om > bm * 1.15) { if (d2 < threatD) { threatD = d2; threat = oc; } }
      else if (bm > om * 1.3) { if (d2 < preyD) { preyD = d2; prey = oc; } }
    }
    let tx = bc.x, ty = bc.y;
    if (threat && threatD < 300 * 300) { tx = bc.x + (bc.x - threat.x); ty = bc.y + (bc.y - threat.y); }
    else if (prey && preyD < 400 * 400 && Math.random() < 0.7) { tx = prey.x; ty = prey.y; }
    else if (bestFood) { tx = bestFood.x; ty = bestFood.y; }
    else { tx = bc.x + rand(-200, 200); ty = bc.y + rand(-200, 200); }
    const tdx = tx - CX, tdy = ty - CY;
    const td = Math.sqrt(tdx * tdx + tdy * tdy);
    const maxTD = WORLD_RADIUS - 150;
    if (td > maxTD) { tx = CX + (tdx / td) * maxTD; ty = CY + (tdy / td) * maxTD; }
    bot.targetX = tx; bot.targetY = ty;
  }
  for (const p of allPlayers) {
    if (!p.alive) continue;
    for (const cell of p.cells) updateCell(cell, dt, p.targetX, p.targetY);
    for (let a = p.cells.length - 1; a >= 0; a--) {
      if (a >= p.cells.length) continue;
      for (let b = a - 1; b >= 0; b--) {
        if (b >= p.cells.length || a >= p.cells.length) continue;
        const ca = p.cells[a], cb = p.cells[b];
        if (!ca || !cb) continue;
        const dx = cb.x - ca.x, dy = cb.y - ca.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const ov = massToRadius(ca.mass) + massToRadius(cb.mass) - d;
        if (ov > 0) {
          if (ca.mergeTimer <= 0 && cb.mergeTimer <= 0) {
            const big = ca.mass >= cb.mass ? ca : cb;
            const small = ca.mass >= cb.mass ? cb : ca;
            big.mass += small.mass;
            p.cells.splice(p.cells.indexOf(small), 1);
            a = p.cells.length; break;
          } else {
            const nx = dx / d, ny = dy / d, push = ov * 0.5;
            ca.x -= nx * push; ca.y -= ny * push;
            cb.x += nx * push; cb.y += ny * push;
          }
        }
      }
    }
    if (getTotalMass(p) > p.maxMass) p.maxMass = getTotalMass(p);
    if (p.cells.length === 0) p.alive = false;
  }
  for (const p of allPlayers) {
    if (!p.alive) continue;
    for (const cell of p.cells) {
      const cr = massToRadius(cell.mass);
      const cr2 = cr * cr;
      for (let i = food.length - 1; i >= 0; i--) {
        const f = food[i];
        const dx = f.x - cell.x, dy = f.y - cell.y;
        if (dx * dx + dy * dy < cr2) { cell.mass += 1; food.splice(i, 1); }
      }
    }
  }
  while (food.length < FOOD_COUNT) food.push(spawnFood());
  for (let i = 0; i < allPlayers.length; i++) {
    const A = allPlayers[i];
    if (!A.alive) continue;
    for (let j = i + 1; j < allPlayers.length; j++) {
      const B = allPlayers[j];
      if (!B.alive) continue;
      for (let ca = A.cells.length - 1; ca >= 0; ca--) {
        if (ca >= A.cells.length) continue;
        const cellA = A.cells[ca]; if (!cellA) continue;
        for (let cb = B.cells.length - 1; cb >= 0; cb--) {
          if (cb >= B.cells.length) continue;
          const cellB = B.cells[cb]; if (!cellB) continue;
          const dx = cellB.x - cellA.x, dy = cellB.y - cellA.y;
          const d2 = dx * dx + dy * dy;
          const ra = massToRadius(cellA.mass), rb = massToRadius(cellB.mass);
          if (cellA.mass > cellB.mass * EAT_MASS_RATIO) {
            const eatDist = ra - rb * EAT_OVERLAP;
            if (d2 < eatDist * eatDist) {
              cellA.mass += cellB.mass; B.cells.splice(cb, 1); A.kills++;
              if (B.cells.length === 0) B.alive = false;
              continue;
            }
          }
          if (cellB.mass > cellA.mass * EAT_MASS_RATIO) {
            const eatDist = rb - ra * EAT_OVERLAP;
            if (d2 < eatDist * eatDist) {
              cellB.mass += cellA.mass; A.cells.splice(ca, 1); B.kills++;
              if (A.cells.length === 0) A.alive = false;
              break;
            }
          }
        }
      }
    }
  }
  for (const [, bot] of botPlayers) {
    if (!bot.alive) {
      const pos = randomWorldPos(300);
      bot.cells = [{ x: pos.x, y: pos.y, mass: START_MASS, vx: 0, vy: 0, mergeTimer: 0 }];
      bot.targetX = pos.x; bot.targetY = pos.y;
      bot.alive = true; bot.kills = 0; bot.maxMass = START_MASS;
    }
  }
}

function doSplit(p) {
  if (!p.alive) return;
  const c = getCenter(p);
  let dx = p.targetX - c.x, dy = p.targetY - c.y;
  const m = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= m; dy /= m;
  let total = p.cells.length;
  const ncs = [];
  for (let i = 0; i < p.cells.length; i++) {
    if (total >= MAX_CELLS) break;
    const cell = p.cells[i];
    if (cell.mass < MIN_SPLIT_MASS) continue;
    const half = cell.mass / 2;
    cell.mass = half; cell.mergeTimer = MERGE_TIME;
    const newR = massToRadius(half);
    const nX = cell.x + dx * (newR + 5);
    const nY = cell.y + dy * (newR + 5);
    const lf = clamp(Math.pow(half / MIN_SPLIT_MASS, -0.15), 0.6, 1.5);
    const ls = SPLIT_LAUNCH_SPEED * lf;
    ncs.push({ x: nX, y: nY, mass: half, vx: dx * ls, vy: dy * ls, mergeTimer: MERGE_TIME });
    total++;
  }
  for (const n of ncs) p.cells.push(n);
}

function doEject(p) {
  if (!p.alive) return;
  const c = getCenter(p);
  let dx = p.targetX - c.x, dy = p.targetY - c.y;
  const m = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= m; dy /= m;
  for (const cell of p.cells) {
    if (cell.mass < MIN_EJECT_MASS) continue;
    cell.mass -= EJECT_COST;
    const ejX = cell.x + dx * massToRadius(cell.mass);
    const ejY = cell.y + dy * massToRadius(cell.mass);
    food.push({ x: ejX, y: ejY, r: 255, g: 200, b: 100, vx: dx * 1000, vy: dy * 1000, isEjected: true, life: 6 });
  }
}

function initBots() {
  const names = ['Nova','Orion','Luna','Vega','Atlas','Cosmo','Nebula','Astro','Stella','Pulsar','Comet','Quasar','Galaxy','Titan','Phoenix','Zephyr','Hydra','Draco'];
  const colors = ['#ff4d6b', '#33e066', '#4a9eff', '#ffcc00', '#a55cff', '#ff8800', '#00ffaa', '#ff6bd6'];
  for (let i = 0; i < BOT_COUNT; i++) {
    const bot = createPlayer('bot_' + i, names[i % names.length], colors[i % colors.length], START_MASS, true);
    botPlayers.set('bot_' + i, bot);
  }
}
initBots();

/* ================= SKINS / SERIALS ================= */
const ALL_SKINS = ['default', 'mind', 'knight', 'rage'];

async function getSkinPrices() {
  if (!dbReady) return {};
  try {
    const r = await db.query('SELECT skin_id, sell_price, is_sellable FROM skin_prices');
    const out = {};
    for (const row of r.rows) {
      if (row.skin_id === 'fire') continue;
      out[row.skin_id] = { sellPrice: parseFloat(row.sell_price), isSellable: row.is_sellable };
    }
    return out;
  } catch (e) { return {}; }
}

async function getSerialStatus() {
  if (!dbReady) return { next: null, soldOut: false };
  try {
    const r = await db.query(`SELECT last_value, is_called FROM lootbox_serial_seq`);
    const last = parseInt(r.rows[0].last_value, 10);
    const current = r.rows[0].is_called ? last : 0;
    return { next: current + 1, soldOut: current >= LOOTBOX_MAX_SERIAL };
  } catch (e) { return { next: 1, soldOut: false }; }
}

/* ================= TON ENGINE ================= */
let hotWallet = null;
let hotWalletKeyPair = null;
let hotWalletVersion = null;
let hotWalletFromEnv = false;
let tonClient = null;

const userSockets = new Map(); // userId -> Set<socket>

function notifyUser(userId, event, payload) {
  const set = userSockets.get(userId);
  if (!set) return;
  for (const s of set) s.emit(event, payload);
}
function notifyAdmins(event, payload) { io.to('admins').emit(event, payload); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getTonClient() {
  if (!tonClient) tonClient = new TonClient({ endpoint: TON_ENDPOINT, apiKey: TON_API_KEY || undefined });
  return tonClient;
}
function tonReady() { return !!(hotWallet && hotWalletKeyPair && dbReady); }

async function activateWallet(words, versionId) {
  const kp = await mnemonicToPrivateKey(words);
  const wallet = createWallet(versionId, kp.publicKey);
  if (!wallet) throw new Error('createWallet failed');
  hotWalletKeyPair = kp;
  hotWallet = wallet;
  hotWalletVersion = versionId;
  getTonClient();
  return wallet;
}

async function initTonWallet() {
  try {
    if (ENV_MNEMONIC) {
      const words = parseMnemonicWords(ENV_MNEMONIC);
      if (!words) { console.error('❌ TON_MNEMONIC must have 12 or 24 words'); return; }
      const wallet = await activateWallet(words, ENV_WALLET_VERSION || 'v5r1');
      hotWalletFromEnv = true;
      console.log('✅ TON wallet from env (' + hotWalletVersion + '): ' + walletAddressString(wallet));
      return;
    }
    if (!dbReady) return;
    const enc = await getAdminSetting('ton_mnemonic_enc');
    if (!enc) { console.warn('⚠️ No mnemonic saved. Set TON_MNEMONIC env or use the admin panel.'); return; }
    const mnemonic = decryptMnemonic(enc, ADMIN_PASSWORD);
    if (!mnemonic) { console.warn('⚠️ Cannot decrypt mnemonic — admin password changed?'); return; }
    const words = parseMnemonicWords(mnemonic);
    if (!words) { console.error('❌ Bad mnemonic word count'); return; }
    const versionId = (await getAdminSetting('ton_wallet_version')) || 'v5r1';
    const wallet = await activateWallet(words, versionId);
    console.log('✅ TON wallet ready (' + versionId + '): ' + walletAddressString(wallet));
  } catch (e) {
    console.error('❌ initTonWallet:', e.message);
  }
}

async function getHotWalletBalanceNano() {
  if (!hotWallet) return null;
  try { return await getTonClient().getBalance(hotWallet.address); } catch (e) { return null; }
}
async function getHotWalletBalance() {
  const n = await getHotWalletBalanceNano();
  return n === null ? null : Number(n) / 1e9;
}

/* ---------- payout queue (one transfer at a time, seqno-confirmed) ---------- */
let payoutChain = Promise.resolve();
function withPayoutLock(fn) {
  const run = payoutChain.then(() => fn());
  payoutChain = run.catch(() => {});
  return run;
}

async function waitSeqnoAdvance(contract, before, maxMs) {
  const deadline = Date.now() + maxMs;
  let polledOk = false;
  while (Date.now() < deadline) {
    await sleep(2500);
    try {
      const now = await contract.getSeqno();
      polledOk = true;
      if (now > before) return { confirmed: true, polledOk };
    } catch (e) { /* node hiccup — keep polling */ }
  }
  return { confirmed: false, polledOk };
}

async function findOutgoingTxHash(toAddr, nano) {
  for (let i = 0; i < 3; i++) {
    try {
      const txs = await getTonClient().getTransactions(hotWallet.address, { limit: 8 });
      for (const tx of txs) {
        for (const m of tx.outMessages.values()) {
          if (m.info.type === 'internal' && m.info.dest.equals(toAddr) && m.info.value.coins === nano) {
            const h = txHashHex(tx);
            if (h) return h;
          }
        }
      }
    } catch (e) { /* ignore */ }
    await sleep(2000);
  }
  return null;
}

/*
 * Returns one of:
 *  { state: 'sent',    txHash }                       – seqno advanced, transfer is on chain
 *  { state: 'failed',  message, countAttempt }        – definitely NOT sent, safe to retry
 *  { state: 'unknown', message }                      – may or may not have been sent, needs a human check
 */
function sendTonOnce(toAddressStr, nano, text) {
  return withPayoutLock(async () => {
    if (!tonReady()) return { state: 'failed', message: 'TON wallet not configured', countAttempt: false };
    const client = getTonClient();
    let to;
    try { to = Address.parse(toAddressStr); } catch (e) {
      return { state: 'failed', message: 'Invalid destination address', countAttempt: true };
    }
    const contract = client.open(hotWallet);
    let seqnoBefore, balance;
    try {
      seqnoBefore = await contract.getSeqno();
      balance = await client.getBalance(hotWallet.address);
    } catch (e) {
      return { state: 'failed', message: 'TON node unavailable: ' + e.message, countAttempt: false };
    }
    if (balance < nano + FEE_RESERVE_NANO) {
      return { state: 'failed', message: 'Insufficient hot wallet balance', countAttempt: false };
    }
    let sendError = null;
    try {
      await contract.sendTransfer({
        seqno: seqnoBefore,
        secretKey: hotWalletKeyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY, // no IGNORE_ERRORS: a failing message must not look like a success
        messages: [internal({ to, value: nano, bounce: false, body: text })]
      });
    } catch (e) { sendError = e; }

    const wait = await waitSeqnoAdvance(contract, seqnoBefore, SEQNO_WAIT_MS);
    if (wait.confirmed) {
      const h = await findOutgoingTxHash(to, nano);
      return { state: 'sent', txHash: h || ('seqno:' + seqnoBefore) };
    }
    if (sendError && wait.polledOk) {
      return { state: 'failed', message: 'Broadcast failed: ' + sendError.message, countAttempt: true };
    }
    return {
      state: 'unknown',
      message: sendError
        ? 'Broadcast error and chain state unreadable: ' + sendError.message
        : 'Transfer broadcast but not confirmed on chain yet'
    };
  });
}

async function dbRetry(fn, tries) {
  let lastErr;
  for (let i = 0; i < (tries || 3); i++) {
    try { return await fn(); } catch (e) { lastErr = e; await sleep(400 * (i + 1)); }
  }
  throw lastErr;
}

/* ---------- sell requests → auto-pay ---------- */
async function processSellRequest(requestId, opts) {
  if (!dbReady) return { ok: false, message: 'DB error' };
  const force = !!(opts && opts.force);
  const allowed = force ? ['pending', 'failed', 'check_needed'] : ['pending'];
  let req;
  try {
    const lock = await db.query(
      `UPDATE sell_requests SET status = 'processing', updated_at = $2
       WHERE id = $1 AND status = ANY($3) RETURNING *`,
      [requestId, Date.now(), allowed]
    );
    if (lock.rows.length === 0) return { ok: false, message: 'Already processed' };
    req = lock.rows[0];
  } catch (e) { return { ok: false, message: 'DB error' }; }

  const amount = parseFloat(req.price_ton);
  const base = { requestId: req.id, skinId: req.skin_id, serial: req.skin_serial, price: amount };
  notifyUser(req.user_id, 'sell_update', Object.assign({ status: 'processing' }, base));

  let nano;
  try { nano = toNano(String(req.price_ton)); } catch (e) {
    await db.query(`UPDATE sell_requests SET status = 'failed', error = $2, updated_at = $3 WHERE id = $1`,
      [req.id, 'Bad price value', Date.now()]);
    return { ok: false, message: 'Bad price value' };
  }

  const result = await sendTonOnce(req.user_wallet, nano, 'Planet.io skin payout #' + req.id);

  try {
    if (result.state === 'sent') {
      await dbRetry(() => db.query(
        `UPDATE sell_requests SET status = 'paid', tx_hash = $2, paid_at = $3, error = NULL, updated_at = $3 WHERE id = $1`,
        [req.id, result.txHash, Date.now()]
      ));
      notifyUser(req.user_id, 'sell_update', Object.assign({ status: 'paid', txHash: result.txHash }, base));
      return { ok: true, txHash: result.txHash, to: req.user_wallet, amount, requestId: req.id };
    }
    if (result.state === 'failed') {
      const attempts = (req.attempts || 0) + (result.countAttempt ? 1 : 0);
      const next = attempts >= PAYOUT_MAX_ATTEMPTS ? 'failed' : 'pending';
      await db.query(
        `UPDATE sell_requests SET status = $2, error = $3, attempts = $4, updated_at = $5 WHERE id = $1`,
        [req.id, next, result.message, attempts, Date.now()]
      );
      notifyUser(req.user_id, 'sell_update', Object.assign({ status: next, error: result.message }, base));
      return { ok: false, message: result.message, requestId: req.id };
    }
    // unknown
    await db.query(
      `UPDATE sell_requests SET status = 'check_needed', error = $2, updated_at = $3 WHERE id = $1`,
      [req.id, result.message, Date.now()]
    );
    notifyUser(req.user_id, 'sell_update', Object.assign({ status: 'check_needed', error: result.message }, base));
    return { ok: false, message: result.message, requestId: req.id };
  } catch (e) {
    console.error('processSellRequest finalize:', e.message);
    return { ok: false, message: 'DB error while finalizing — check request #' + req.id };
  }
}

let payoutWorkerBusy = false;
async function runPayoutWorker() {
  if (payoutWorkerBusy || !tonReady()) return;
  payoutWorkerBusy = true;
  try {
    const auto = await getAdminSetting('autopay_enabled');
    if (auto !== '1') return;
    const r = await db.query(
      `SELECT id FROM sell_requests
       WHERE status = 'pending' AND (updated_at IS NULL OR updated_at < $1)
       ORDER BY id ASC LIMIT 5`,
      [Date.now() - PAYOUT_RETRY_BACKOFF_MS]
    );
    for (const row of r.rows) {
      const res = await processSellRequest(row.id);
      notifyAdmins('admin_pay_result', Object.assign({ requestId: row.id, auto: true }, res));
    }
  } catch (e) {
    console.error('payoutWorker:', e.message);
  } finally {
    payoutWorkerBusy = false;
  }
}
function kickPayoutWorker() { setTimeout(() => { runPayoutWorker().catch(() => {}); }, 400); }

/* ---------- lootbox orders (server-bound memo, no client-chosen memo anymore) ---------- */
function orderPayload(row) {
  const address = walletAddressString(hotWallet);
  const nano = String(row.amount_nano);
  return {
    orderId: row.id,
    memo: row.memo,
    amountNano: nano,
    amountTon: Number(nano) / 1e9,
    address,
    payload: commentPayloadBase64(row.memo),
    validUntil: Math.floor(Date.now() / 1000) + TX_VALID_FOR_SEC,
    expiresAt: Number(row.created_at) + ORDER_UI_TTL_MS,
    deeplink: 'ton://transfer/' + address + '?amount=' + nano + '&text=' + encodeURIComponent(row.memo)
  };
}

async function createLootboxOrder(userId) {
  if (!dbReady) return { ok: false, message: 'Database offline' };
  if (!tonReady()) return { ok: false, message: 'Payments are offline right now' };
  const serialStatus = await getSerialStatus();
  if (serialStatus.soldOut) return { ok: false, message: 'All 999 serials have been sold' };
  const settings = await getPublicSettings();
  if (parseInt(settings.lootbox_remaining, 10) === 0) return { ok: false, message: 'Lootbox is sold out' };

  const user = await getOrCreateUser(userId, '', '');
  if (!user) return { ok: false, message: 'User error' };
  const owned = new Set(normalizeSkins(user.unlocked_skins).map((s) => s.id));
  if (ALL_SKINS.filter((id) => id !== 'default' && !owned.has(id)).length === 0) {
    return { ok: false, message: 'You already own all skins' };
  }

  const amountNano = toNano(getLootboxPrice(settings).toFixed(9));
  const now = Date.now();
  try {
    const open = await db.query(
      `SELECT * FROM lootbox_orders WHERE user_id = $1 AND status = 'pending' AND created_at > $2 ORDER BY id DESC`,
      [userId, now - ORDER_MATCH_WINDOW_MS]
    );
    const fresh = open.rows.find((o) => BigInt(o.amount_nano) === amountNano && now - Number(o.created_at) < ORDER_UI_TTL_MS);
    if (fresh) return { ok: true, order: orderPayload(fresh) };
    if (open.rows.length >= MAX_PENDING_ORDERS_PER_USER) {
      return { ok: false, message: 'You have unpaid orders open. Finish or wait for them first.' };
    }
    for (let i = 0; i < 4; i++) {
      try {
        const ins = await db.query(
          `INSERT INTO lootbox_orders (user_id, memo, amount_nano, status, created_at)
           VALUES ($1, $2, $3, 'pending', $4) RETURNING *`,
          [userId, randomMemo(), amountNano.toString(), now]
        );
        return { ok: true, order: orderPayload(ins.rows[0]) };
      } catch (e) {
        if (e.code !== '23505') throw e; // memo collision → retry
      }
    }
    return { ok: false, message: 'Could not create order' };
  } catch (e) {
    console.error('createLootboxOrder:', e.message);
    return { ok: false, message: 'Could not create order' };
  }
}

async function broadcastLootboxState() {
  io.emit('settings_update', await getPublicSettings());
  io.emit('serial_status', await getSerialStatus());
}

async function fulfillLootboxOrder(orderId, txHash, payer) {
  const c = await db.connect();
  let delivered = null;
  let refundReason = '';
  let ownerId = null;
  try {
    await c.query('BEGIN');
    const ro = await c.query('SELECT * FROM lootbox_orders WHERE id = $1 FOR UPDATE', [orderId]);
    const order = ro.rows[0];
    if (!order || order.status !== 'pending') { await c.query('ROLLBACK'); return null; }
    ownerId = order.user_id;

    const ru = await c.query('SELECT unlocked_skins FROM users WHERE telegram_id = $1 FOR UPDATE', [order.user_id]);
    const skins = ru.rows.length ? normalizeSkins(ru.rows[0].unlocked_skins) : null;
    const owned = new Set((skins || []).map((s) => s.id));
    const locked = ALL_SKINS.filter((id) => id !== 'default' && !owned.has(id));
    const rs = await c.query(`SELECT value FROM admin_settings WHERE key = 'lootbox_remaining' FOR UPDATE`);
    const remaining = rs.rows.length ? parseInt(rs.rows[0].value, 10) : -1;

    let serial = null;
    if (!skins) refundReason = 'Account not found';
    else if (locked.length === 0) refundReason = 'All skins already owned';
    else if (remaining === 0) refundReason = 'Lootbox sold out';
    else {
      await c.query('SAVEPOINT serial_sp');
      try {
        const sr = await c.query(`SELECT nextval('lootbox_serial_seq') AS serial`);
        serial = parseInt(sr.rows[0].serial, 10);
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT serial_sp');
        refundReason = 'All 999 serials sold out';
      }
    }

    if (refundReason) {
      await c.query(
        `UPDATE lootbox_orders SET status = 'refund_pending', tx_hash = $2, payer = $3, paid_at = $4, error = $5 WHERE id = $1`,
        [orderId, txHash, payer, Date.now(), refundReason]
      );
      await c.query('COMMIT');
    } else {
      const pickedId = locked[crypto.randomInt(locked.length)];
      skins.push({ id: pickedId, serial, source: 'lootbox', acquiredAt: Date.now() });
      await c.query('UPDATE users SET unlocked_skins = $1 WHERE telegram_id = $2', [JSON.stringify(skins), order.user_id]);
      let newRemaining = remaining;
      if (remaining > 0) {
        const up = await c.query(
          `UPDATE admin_settings SET value = (CAST(value AS INTEGER) - 1)::TEXT
           WHERE key = 'lootbox_remaining' AND CAST(value AS INTEGER) > 0 RETURNING value`
        );
        if (up.rows.length) newRemaining = parseInt(up.rows[0].value, 10);
      }
      await c.query(
        `UPDATE lootbox_orders SET status = 'completed', tx_hash = $2, payer = $3, skin_id = $4, serial = $5,
         paid_at = $6, error = NULL WHERE id = $1`,
        [orderId, txHash, payer, pickedId, serial, Date.now()]
      );
      await c.query('COMMIT');
      delivered = { orderId, skinId: pickedId, serial, unlockedSkins: skins, lootboxRemaining: newRemaining };
    }
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    console.error('fulfillLootboxOrder #' + orderId + ':', e.message);
    return null; // order stays pending → the next scan retries it
  } finally {
    c.release();
  }

  if (delivered) {
    console.log('🎁 order #' + orderId + ' → ' + delivered.skinId + ' #' + delivered.serial + ' (' + ownerId + ')');
    notifyUser(ownerId, 'lootbox_result', Object.assign({ ok: true }, delivered));
    broadcastLootboxState().catch(() => {});
    return delivered;
  }
  console.warn('💸 order #' + orderId + ' paid but cannot be delivered: ' + refundReason + ' → refunding');
  refundOrder(orderId).catch((e) => console.error('refundOrder:', e.message));
  return null;
}

async function refundOrder(orderId, manual) {
  if (!dbReady) return { ok: false, message: 'DB error' };
  const allowed = manual ? ['refund_pending', 'refund_failed'] : ['refund_pending'];
  let order;
  try {
    const lock = await db.query(
      `UPDATE lootbox_orders SET status = 'refunding' WHERE id = $1 AND status = ANY($2) RETURNING *`,
      [orderId, allowed]
    );
    if (lock.rows.length === 0) return { ok: false, message: 'Not refundable' };
    order = lock.rows[0];
  } catch (e) { return { ok: false, message: 'DB error' }; }

  if (!order.payer) {
    await db.query(`UPDATE lootbox_orders SET status = 'refund_failed', error = 'No payer address recorded' WHERE id = $1`, [orderId]);
    return { ok: false, message: 'No payer address recorded' };
  }
  const result = await sendTonOnce(order.payer, BigInt(order.amount_nano), 'Planet.io refund #' + order.id);
  try {
    if (result.state === 'sent') {
      await dbRetry(() => db.query(
        `UPDATE lootbox_orders SET status = 'refunded', error = $2 WHERE id = $1`,
        [orderId, 'refund tx ' + result.txHash]
      ));
      notifyUser(order.user_id, 'lootbox_refund', { orderId, status: 'refunded' });
      return { ok: true, txHash: result.txHash };
    }
    await db.query(
      `UPDATE lootbox_orders SET status = 'refund_failed', error = $2 WHERE id = $1`,
      [orderId, (result.state === 'unknown' ? 'UNCONFIRMED: ' : '') + result.message]
    );
    return { ok: false, message: result.message };
  } catch (e) {
    console.error('refundOrder finalize:', e.message);
    return { ok: false, message: 'DB error while finalizing refund' };
  }
}

/* ---------- incoming payment watcher ---------- */
let scanBusy = false;
async function scanIncomingPayments() {
  if (scanBusy || !tonReady()) return;
  scanBusy = true;
  try {
    const pend = await db.query(
      `SELECT * FROM lootbox_orders WHERE status = 'pending' AND created_at > $1 ORDER BY id ASC`,
      [Date.now() - ORDER_MATCH_WINDOW_MS]
    );
    if (pend.rows.length === 0) return;
    const byMemo = new Map(pend.rows.map((o) => [o.memo, o]));
    const txs = await getTonClient().getTransactions(hotWallet.address, { limit: 50 });
    for (const tx of txs) {
      const m = tx.inMessage;
      if (!m || m.info.type !== 'internal' || m.info.bounced) continue;
      const memo = parseCommentFromBody(m.body);
      if (!memo) continue;
      const order = byMemo.get(memo);
      if (!order) continue;
      if (m.info.value.coins < BigInt(order.amount_nano)) continue; // underpaid → ignored
      byMemo.delete(memo);
      const hash = txHashHex(tx) || ('lt:' + tx.lt.toString());
      let payer = null;
      try { payer = m.info.src.toString({ bounceable: false, testOnly: false, urlSafe: true }); } catch (e) { /* ignore */ }
      await fulfillLootboxOrder(order.id, hash, payer);
    }
  } catch (e) {
    console.error('scanIncomingPayments:', e.message);
  } finally {
    scanBusy = false;
  }
}

async function expireOldOrders() {
  if (!dbReady) return;
  try {
    await db.query(`UPDATE lootbox_orders SET status = 'expired' WHERE status = 'pending' AND created_at < $1`,
      [Date.now() - ORDER_MATCH_WINDOW_MS]);
  } catch (e) { /* ignore */ }
}

async function sendOrderStatus(socket, userId, orderId) {
  try {
    const r = await db.query('SELECT * FROM lootbox_orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
    if (r.rows.length === 0) { socket.emit('lootbox_order_status', { orderId, status: 'missing' }); return; }
    const o = r.rows[0];
    socket.emit('lootbox_order_status', { orderId, status: o.status, error: o.error || '' });
    if (o.status === 'completed' && !o.seen) {
      const u = await db.query('SELECT unlocked_skins FROM users WHERE telegram_id = $1', [userId]);
      const settings = await getPublicSettings();
      socket.emit('lootbox_result', {
        ok: true, orderId, skinId: o.skin_id, serial: o.serial,
        unlockedSkins: normalizeSkins(u.rows[0] && u.rows[0].unlocked_skins),
        lootboxRemaining: parseInt(settings.lootbox_remaining, 10)
      });
    }
  } catch (e) { /* ignore */ }
}
/* ================= HTTP ROUTES ================= */
const PUBLIC_DIR = path.join(__dirname, 'public');
const TC_UI_FILE = path.join(__dirname, 'node_modules', '@tonconnect', 'ui', 'dist', 'tonconnect-ui.min.js');

function baseUrl(req) {
  if (APP_URL) return APP_URL;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return proto + '://' + req.get('host');
}

app.get('/tonconnect-manifest.json', (req, res) => {
  const base = baseUrl(req);
  let icon = ICON_URL;
  if (!icon) {
    icon = fs.existsSync(path.join(PUBLIC_DIR, 'icon.png'))
      ? base + '/icon.png'
      : 'https://ton.org/download/ton_symbol.png';
  }
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ url: base, name: 'Planet.io', iconUrl: icon });
});

// self-hosted TonConnect UI bundle (pinned by package.json, no third-party CDN needed)
app.get('/vendor/tonconnect-ui.min.js', (req, res) => {
  if (!fs.existsSync(TC_UI_FILE)) { res.status(404).end(); return; }
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('application/javascript');
  res.sendFile(TC_UI_FILE);
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, db: dbReady, ton: tonReady(), version: '4.0.0' });
});

app.use(express.static(PUBLIC_DIR));

/* ================= TELEGRAM AUTH ================= */
const INIT_DATA_MAX_AGE_SEC = 7 * 24 * 3600;

function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return { error: 'invalid' };
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { error: 'invalid' };
    params.delete('hash');
    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const validationHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const a = Buffer.from(validationHash, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: 'invalid' };
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || (Date.now() / 1000 - authDate) > INIT_DATA_MAX_AGE_SEC) return { error: 'expired' };
    const userJson = params.get('user');
    if (!userJson) return { error: 'invalid' };
    return { user: JSON.parse(userJson) };
  } catch (e) { return { error: 'invalid' }; }
}

/* ================= SOCKET.IO ================= */
io.on('connection', (socket) => {
  console.log('🟢 ' + socket.id);
  let currentUserId = null;
  let isAdminAuthed = false;

  function adminOk(data) {
    return isAdminAuthed && safeEqual(data && data.password, ADMIN_PASSWORD);
  }
  function registerSocket(userId) {
    if (currentUserId && currentUserId !== userId) unregisterSocket();
    currentUserId = userId;
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket);
  }
  function unregisterSocket() {
    if (!currentUserId) return;
    const set = userSockets.get(currentUserId);
    if (set) { set.delete(socket); if (set.size === 0) userSockets.delete(currentUserId); }
  }

  /* ---------- auth ---------- */
  socket.on('auth', async (data) => {
    data = data || {};
    let userData = null;
    if (data.initData && BOT_TOKEN) {
      const v = validateTelegramInitData(String(data.initData));
      if (v.error) {
        socket.emit('auth_error', {
          message: v.error === 'expired' ? 'Session expired — please reopen the app from Telegram' : 'Telegram authentication failed',
          fatal: true
        });
        return;
      }
      userData = { id: 'tg_' + v.user.id, username: v.user.username || '', firstName: v.user.first_name || 'Player' };
    }
    if (!userData && data.deviceId) {
      const dev = String(data.deviceId).slice(0, 64);
      if (/^[\w-]+$/.test(dev)) userData = { id: 'dev_' + dev, username: '', firstName: 'Guest' };
    }
    if (!userData) { socket.emit('auth_error', { message: 'Auth failed', fatal: false }); return; }

    const user = await getOrCreateUser(userData.id, userData.username, userData.firstName);
    if (!user) { socket.emit('auth_error', { message: 'DB error', fatal: false }); return; }
    registerSocket(userData.id);

    const [settings, prices, serialStatus] = await Promise.all([getPublicSettings(), getSkinPrices(), getSerialStatus()]);
    const skins = normalizeSkins(user.unlocked_skins);
    const currentSkin = skins.some((s) => s.id === user.current_skin) ? user.current_skin : 'default';

    let unseenLootbox = null;
    if (dbReady) {
      try {
        const r = await db.query(
          `SELECT id, skin_id, serial FROM lootbox_orders WHERE user_id = $1 AND status = 'completed' AND seen = FALSE ORDER BY id ASC LIMIT 1`,
          [userData.id]
        );
        if (r.rows.length) unseenLootbox = { orderId: r.rows[0].id, skinId: r.rows[0].skin_id, serial: r.rows[0].serial };
      } catch (e) { /* ignore */ }
    }

    socket.emit('auth_ok', {
      user: {
        id: user.telegram_id,
        name: user.first_name || 'Player',
        tokens: user.tokens || 0,
        speedLevel: user.speed_level || 0,
        massLevel: user.mass_level || 0,
        unlockedSkins: skins,
        currentSkin,
        totalKills: user.total_kills || 0,
        highScore: user.high_score || 0,
        walletAddress: user.wallet_address || ''
      },
      settings,
      skinPrices: prices,
      serialStatus,
      tonReady: tonReady(),
      tonWalletAddress: hotWallet ? walletAddressString(hotWallet) : '',
      config: { twaReturnUrl: TWA_RETURN_URL },
      unseenLootbox
    });
  });

  socket.on('save_progress', async (data) => {
    if (!currentUserId || rateLimited('sp:' + currentUserId, 400)) return;
    await saveProgress(currentUserId, data);
  });

  socket.on('save_wallet', async (data) => {
    if (!currentUserId || !data || !data.wallet) return;
    const normalized = normalizeUserAddress(data.wallet);
    if (!normalized) { socket.emit('wallet_saved', { ok: false, message: 'Invalid TON address (mainnet only)' }); return; }
    if (!dbReady) { socket.emit('wallet_saved', { ok: false, message: 'Database offline' }); return; }
    try {
      await db.query('UPDATE users SET wallet_address = $1 WHERE telegram_id = $2', [normalized, currentUserId]);
      socket.emit('wallet_saved', { ok: true, wallet: normalized, silent: !!data.silent });
    } catch (e) { socket.emit('wallet_saved', { ok: false, message: 'Save failed' }); }
  });

  /* ---------- lootbox purchase (TON Connect) ---------- */
  socket.on('lootbox_create_order', async () => {
    if (!currentUserId) return;
    if (rateLimited('lo:' + currentUserId, 1500)) {
      socket.emit('lootbox_order', { ok: false, message: 'Please wait a moment' }); return;
    }
    const res = await createLootboxOrder(currentUserId);
    socket.emit('lootbox_order', res);
  });

  socket.on('lootbox_check_order', async (data) => {
    if (!currentUserId || !data) return;
    const orderId = parseInt(data.orderId, 10);
    if (!orderId || rateLimited('lc:' + currentUserId, 1500)) return;
    await scanIncomingPayments();
    await sendOrderStatus(socket, currentUserId, orderId);
  });

  socket.on('lootbox_seen', async (data) => {
    if (!currentUserId || !dbReady || !data) return;
    const orderId = parseInt(data.orderId, 10);
    if (!orderId) return;
    try { await db.query('UPDATE lootbox_orders SET seen = TRUE WHERE id = $1 AND user_id = $2', [orderId, currentUserId]); } catch (e) { /* ignore */ }
  });

  /* ---------- selling skins (auto-pay) ---------- */
  socket.on('sell_skin', async (data) => {
    if (!currentUserId || !data) return;
    if (!dbReady) { socket.emit('sell_result', { ok: false, message: 'Database offline' }); return; }
    if (rateLimited('sell:' + currentUserId, 1500)) { socket.emit('sell_result', { ok: false, message: 'Please wait a moment' }); return; }
    const skinId = String(data.skinId || '');
    const skinSerial = (typeof data.skinSerial === 'number') ? data.skinSerial : null;
    if (!skinId || skinId === 'default' || skinId === 'fire' || !ALL_SKINS.includes(skinId)) {
      socket.emit('sell_result', { ok: false, message: 'This skin cannot be sold' }); return;
    }
    const wallet = normalizeUserAddress(data.walletAddress);
    if (!wallet) { socket.emit('sell_result', { ok: false, message: 'Invalid wallet address (mainnet only)' }); return; }

    const c = await db.connect();
    let created = null;
    try {
      await c.query('BEGIN');
      const pr = await c.query('SELECT sell_price, is_sellable FROM skin_prices WHERE skin_id = $1', [skinId]);
      const price = pr.rows.length ? parseFloat(pr.rows[0].sell_price) : 0;
      if (!pr.rows.length || !pr.rows[0].is_sellable || !(price > 0) || price > 100000) {
        await c.query('ROLLBACK'); socket.emit('sell_result', { ok: false, message: 'Not sellable right now' }); return;
      }
      const ur = await c.query('SELECT unlocked_skins, current_skin FROM users WHERE telegram_id = $1 FOR UPDATE', [currentUserId]);
      if (ur.rows.length === 0) { await c.query('ROLLBACK'); socket.emit('sell_result', { ok: false, message: 'User not found' }); return; }
      const skins = normalizeSkins(ur.rows[0].unlocked_skins);
      const idx = skins.findIndex((s) => s.id === skinId && s.serial === skinSerial);
      if (idx < 0) { await c.query('ROLLBACK'); socket.emit('sell_result', { ok: false, message: 'Skin not found' }); return; }
      skins.splice(idx, 1);
      let currentSkin = ur.rows[0].current_skin || 'default';
      if (!skins.some((s) => s.id === currentSkin)) currentSkin = 'default';
      const ins = await c.query(
        `INSERT INTO sell_requests (user_id, user_wallet, skin_id, skin_serial, price_ton, status, created_at, updated_at, attempts)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, NULL, 0) RETURNING id`,
        [currentUserId, wallet, skinId, skinSerial, price.toFixed(6), Date.now()]
      );
      await c.query('UPDATE users SET unlocked_skins = $1, wallet_address = $2, current_skin = $3 WHERE telegram_id = $4',
        [JSON.stringify(skins), wallet, currentSkin, currentUserId]);
      await c.query('COMMIT');
      created = { requestId: ins.rows[0].id, skins, currentSkin, price, wallet };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (e2) { /* ignore */ }
      console.error('sell_skin:', e.message);
      socket.emit('sell_result', { ok: false, message: 'Could not create sell request' });
      return;
    } finally {
      c.release();
    }
    socket.emit('sell_result', {
      ok: true, requestId: created.requestId, skinId, skinSerial,
      price: created.price, unlockedSkins: created.skins, currentSkin: created.currentSkin, wallet: created.wallet
    });
    notifyAdmins('admin_new_request', { requestId: created.requestId });
    kickPayoutWorker();
  });

  socket.on('get_my_sells', async () => {
    if (!currentUserId || !dbReady) return;
    try {
      const r = await db.query(
        `SELECT id, skin_id, skin_serial, price_ton, status, tx_hash, error, created_at, paid_at
         FROM sell_requests WHERE user_id = $1 ORDER BY id DESC LIMIT 15`,
        [currentUserId]
      );
      socket.emit('my_sells', r.rows.map((x) => ({
        id: x.id, skinId: x.skin_id, serial: x.skin_serial, price: parseFloat(x.price_ton),
        status: x.status, txHash: x.tx_hash, createdAt: Number(x.created_at), paidAt: x.paid_at ? Number(x.paid_at) : null
      })));
    } catch (e) { /* ignore */ }
  });

  /* ---------- ADMIN ---------- */
  socket.on('admin_login', (data) => {
    if (rateLimited('adm:' + socket.handshake.address, 1000)) { socket.emit('admin_login_result', { ok: false }); return; }
    const ok = safeEqual(data && data.password, ADMIN_PASSWORD);
    isAdminAuthed = ok;
    if (ok) socket.join('admins'); else socket.leave('admins');
    console.log('🔐 admin_login ' + socket.id + ' — ' + (ok ? 'OK' : 'FAIL'));
    socket.emit('admin_login_result', { ok });
  });

  socket.on('admin_get_wallet_info', async (data) => {
    if (!adminOk(data)) { socket.emit('admin_wallet_info', { ok: false }); return; }
    const balance = await getHotWalletBalance();
    socket.emit('admin_wallet_info', {
      ok: true,
      address: hotWallet ? walletAddressString(hotWallet) : null,
      balance, version: hotWalletVersion, fromEnv: hotWalletFromEnv
    });
  });

  socket.on('admin_preview_mnemonic', async (data) => {
    if (!adminOk(data)) { socket.emit('admin_preview_mnemonic_result', { ok: false, message: 'Auth failed' }); return; }
    if (hotWalletFromEnv) { socket.emit('admin_preview_mnemonic_result', { ok: false, message: 'Wallet is managed by the TON_MNEMONIC env var' }); return; }
    const words = parseMnemonicWords(data.mnemonic);
    if (!words) { socket.emit('admin_preview_mnemonic_result', { ok: false, message: 'Need 12 or 24 words' }); return; }
    try {
      const kp = await mnemonicToPrivateKey(words);
      socket.emit('admin_preview_mnemonic_result', { ok: true, versions: deriveAllWallets(kp.publicKey) });
    } catch (e) {
      socket.emit('admin_preview_mnemonic_result', { ok: false, message: e.message });
    }
  });

  socket.on('admin_commit_mnemonic', async (data) => {
    if (!adminOk(data)) { socket.emit('admin_commit_mnemonic_result', { ok: false, message: 'Auth failed' }); return; }
    if (hotWalletFromEnv) { socket.emit('admin_commit_mnemonic_result', { ok: false, message: 'Wallet is managed by the TON_MNEMONIC env var' }); return; }
    const words = parseMnemonicWords(data.mnemonic);
    const versionId = String(data.versionId || 'v5r1');
    if (!words) { socket.emit('admin_commit_mnemonic_result', { ok: false, message: 'Need 12 or 24 words' }); return; }
    try {
      const wallet = await activateWallet(words, versionId);
      if (dbReady) {
        await db.query(
          `INSERT INTO admin_settings (key, value) VALUES ('ton_mnemonic_enc', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [encryptMnemonic(words.join(' '), ADMIN_PASSWORD)]
        );
        await db.query(
          `INSERT INTO admin_settings (key, value) VALUES ('ton_wallet_version', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [versionId]
        );
      }
      const balance = await getHotWalletBalance();
      console.log('✅ Wallet committed: ' + versionId + ' @ ' + walletAddressString(wallet));
      socket.emit('admin_commit_mnemonic_result', { ok: true, address: walletAddressString(wallet), balance, version: versionId });
      broadcastLootboxState().catch(() => {});
    } catch (e) {
      console.error('commit:', e.message);
      socket.emit('admin_commit_mnemonic_result', { ok: false, message: e.message });
    }
  });

  socket.on('admin_clear_mnemonic', async (data) => {
    if (!adminOk(data)) return;
    if (hotWalletFromEnv) { socket.emit('admin_clear_mnemonic_result', { ok: false, message: 'Wallet is managed by the TON_MNEMONIC env var' }); return; }
    if (dbReady) {
      try {
        await db.query(`DELETE FROM admin_settings WHERE key IN ('ton_mnemonic_enc', 'ton_wallet_version')`);
      } catch (e) { /* ignore */ }
    }
    hotWallet = null; hotWalletKeyPair = null; hotWalletVersion = null;
    socket.emit('admin_clear_mnemonic_result', { ok: true });
  });

  socket.on('admin_add_tokens', async (data) => {
    if (!adminOk(data) || !currentUserId || !dbReady) return;
    try {
      const r = await db.query('UPDATE users SET tokens = LEAST(tokens + 1000, $2) WHERE telegram_id = $1 RETURNING tokens', [currentUserId, INT_MAX]);
      socket.emit('admin_add_tokens_result', { ok: true, tokens: r.rows.length ? r.rows[0].tokens : 0 });
    } catch (e) { socket.emit('admin_add_tokens_result', { ok: false }); }
  });

  socket.on('admin_unlock_all', async (data) => {
    if (!adminOk(data) || !currentUserId || !dbReady) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const u = await c.query('SELECT unlocked_skins FROM users WHERE telegram_id = $1 FOR UPDATE', [currentUserId]);
      if (u.rows.length === 0) { await c.query('ROLLBACK'); socket.emit('admin_unlock_all_result', { ok: false }); return; }
      const skins = normalizeSkins(u.rows[0].unlocked_skins);
      const owned = new Set(skins.map((s) => s.id));
      for (const sid of ALL_SKINS) {
        if (!owned.has(sid)) skins.push({ id: sid, serial: null, source: 'admin', acquiredAt: Date.now() });
      }
      await c.query('UPDATE users SET unlocked_skins = $1 WHERE telegram_id = $2', [JSON.stringify(skins), currentUserId]);
      await c.query('COMMIT');
      socket.emit('admin_unlock_all_result', { ok: true, unlockedSkins: skins });
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (e2) { /* ignore */ }
      socket.emit('admin_unlock_all_result', { ok: false });
    } finally { c.release(); }
  });

  socket.on('admin_wipe_all', async (data) => {
    if (!adminOk(data) || !currentUserId || !dbReady) return;
    try {
      const fresh = [{ id: 'default', serial: null, source: 'starter', acquiredAt: 0 }];
      await db.query(
        `UPDATE users SET tokens = 0, speed_level = 0, mass_level = 0,
         unlocked_skins = $1, current_skin = 'default', total_kills = 0, high_score = 0 WHERE telegram_id = $2`,
        [JSON.stringify(fresh), currentUserId]
      );
      socket.emit('admin_wipe_all_result', { ok: true, unlockedSkins: fresh });
    } catch (e) { socket.emit('admin_wipe_all_result', { ok: false }); }
  });

  socket.on('admin_set', async (data) => {
    if (!adminOk(data) || !data.key) return;
    const key = String(data.key);
    if (!PUBLIC_SETTING_KEYS.includes(key)) { socket.emit('admin_set_result', { ok: false, key }); return; }
    let value = data.value;
    if (key === 'lootbox_price') {
      const p = parseFloat(value);
      if (!Number.isFinite(p) || p < MIN_LOOTBOX_PRICE || p > 100000) { socket.emit('admin_set_result', { ok: false, key }); return; }
      value = p;
    } else if (key === 'lootbox_remaining') {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n) || n < -1) { socket.emit('admin_set_result', { ok: false, key }); return; }
      value = n;
    } else if (key === 'lootbox_tag') {
      value = String(value || '');
      if (!['', 'new', 'hot', 'sale'].includes(value)) { socket.emit('admin_set_result', { ok: false, key }); return; }
    } else if (key === 'autopay_enabled') {
      value = (String(value) === '1' || value === true) ? '1' : '0';
    }
    const ok = await setAdminSetting(key, value);
    if (ok) {
      io.emit('settings_update', await getPublicSettings());
      if (key === 'autopay_enabled' && value === '1') kickPayoutWorker();
    }
    socket.emit('admin_set_result', { ok, key });
  });

  socket.on('admin_get_requests', async (data) => {
    if (!adminOk(data) || !dbReady) { socket.emit('admin_requests', []); return; }
    try {
      const r = await db.query(
        `SELECT id, user_id, user_wallet, skin_id, skin_serial, price_ton, status, tx_hash, error, attempts, created_at, paid_at
         FROM sell_requests ORDER BY id DESC LIMIT 100`
      );
      socket.emit('admin_requests', r.rows);
    } catch (e) { socket.emit('admin_requests', []); }
  });

  socket.on('admin_pay_request', async (data) => {
    if (!adminOk(data)) return;
    const reqId = parseInt(data.requestId, 10);
    if (!reqId) return;
    const result = await processSellRequest(reqId, { force: !!data.force });
    socket.emit('admin_pay_result', Object.assign({ requestId: reqId }, result));
  });

  socket.on('admin_mark_paid', async (data) => {
    if (!adminOk(data) || !dbReady) return;
    const reqId = parseInt(data.requestId, 10);
    if (!reqId) return;
    try {
      const r = await db.query(
        `UPDATE sell_requests SET status = 'paid', tx_hash = COALESCE(NULLIF($2, ''), 'manual'), paid_at = $3, error = NULL, updated_at = $3
         WHERE id = $1 AND status IN ('check_needed', 'failed', 'pending') RETURNING *`,
        [reqId, String(data.txHash || '').slice(0, 128), Date.now()]
      );
      if (r.rows.length === 0) { socket.emit('admin_mark_paid_result', { ok: false, requestId: reqId }); return; }
      const q = r.rows[0];
      notifyUser(q.user_id, 'sell_update', { requestId: q.id, status: 'paid', txHash: q.tx_hash, skinId: q.skin_id, serial: q.skin_serial, price: parseFloat(q.price_ton) });
      socket.emit('admin_mark_paid_result', { ok: true, requestId: reqId });
    } catch (e) { socket.emit('admin_mark_paid_result', { ok: false, requestId: reqId }); }
  });

  socket.on('admin_reject_request', async (data) => {
    if (!adminOk(data) || !dbReady) return;
    const reqId = parseInt(data.requestId, 10);
    if (!reqId) return;
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      const lock = await c.query(
        `UPDATE sell_requests SET status = 'rejected', updated_at = $2
         WHERE id = $1 AND status IN ('pending', 'failed', 'check_needed') RETURNING *`,
        [reqId, Date.now()]
      );
      if (lock.rows.length === 0) { await c.query('ROLLBACK'); socket.emit('admin_reject_result', { ok: false, requestId: reqId }); return; }
      const req = lock.rows[0];
      const u = await c.query('SELECT unlocked_skins FROM users WHERE telegram_id = $1 FOR UPDATE', [req.user_id]);
      if (u.rows.length > 0) {
        const skins = normalizeSkins(u.rows[0].unlocked_skins);
        skins.push({ id: req.skin_id, serial: req.skin_serial, source: 'refund', acquiredAt: Date.now() });
        await c.query('UPDATE users SET unlocked_skins = $1 WHERE telegram_id = $2', [JSON.stringify(skins), req.user_id]);
        notifyUser(req.user_id, 'sell_update', { requestId: req.id, status: 'rejected', skinId: req.skin_id, serial: req.skin_serial, price: parseFloat(req.price_ton), unlockedSkins: skins });
      }
      await c.query('COMMIT');
      socket.emit('admin_reject_result', { ok: true, requestId: reqId });
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (e2) { /* ignore */ }
      socket.emit('admin_reject_result', { ok: false, requestId: reqId });
    } finally { c.release(); }
  });

  socket.on('admin_set_skin_price', async (data) => {
    if (!adminOk(data) || !dbReady || !data.skinId) return;
    const skinId = String(data.skinId);
    if (!ALL_SKINS.includes(skinId) || skinId === 'default') { socket.emit('admin_skin_price_result', { ok: false }); return; }
    const price = parseFloat(data.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) { socket.emit('admin_skin_price_result', { ok: false }); return; }
    try {
      await db.query(
        `INSERT INTO skin_prices (skin_id, sell_price, is_sellable) VALUES ($1, $2, $3)
         ON CONFLICT (skin_id) DO UPDATE SET sell_price = EXCLUDED.sell_price, is_sellable = EXCLUDED.is_sellable`,
        [skinId, price.toFixed(6), !!data.sellable]
      );
      io.emit('skin_prices_update', await getSkinPrices());
      socket.emit('admin_skin_price_result', { ok: true });
    } catch (e) { socket.emit('admin_skin_price_result', { ok: false }); }
  });

  socket.on('admin_get_wallet_balance', async (data) => {
    if (!adminOk(data)) { socket.emit('admin_wallet_balance', { ok: false, balance: null, address: null }); return; }
    const balance = await getHotWalletBalance();
    socket.emit('admin_wallet_balance', { ok: balance !== null, balance, address: hotWallet ? walletAddressString(hotWallet) : null });
  });

  socket.on('admin_get_orders', async (data) => {
    if (!adminOk(data) || !dbReady) { socket.emit('admin_orders', []); return; }
    try {
      const r = await db.query(
        `SELECT id, user_id, amount_nano, status, tx_hash, payer, skin_id, serial, error, created_at, paid_at
         FROM lootbox_orders WHERE status <> 'expired' ORDER BY id DESC LIMIT 40`
      );
      socket.emit('admin_orders', r.rows);
    } catch (e) { socket.emit('admin_orders', []); }
  });

  socket.on('admin_refund_order', async (data) => {
    if (!adminOk(data)) return;
    const orderId = parseInt(data.orderId, 10);
    if (!orderId) return;
    const res = await refundOrder(orderId, true);
    socket.emit('admin_order_result', Object.assign({ orderId }, res));
  });

  /* ---------- GAME ---------- */
  socket.on('join', (data) => {
    data = data || {};
    players.delete(socket.id);
    const name = String(data.name || 'Player').slice(0, 20);
    const color = /^#[0-9a-fA-F]{6}$/.test(String(data.color)) ? String(data.color) : '#4a9eff';
    const startMass = clamp(Number(data.startMass) || START_MASS, START_MASS, 150);
    const p = createPlayer(socket.id, name, color, startMass, false);
    players.set(socket.id, p);
    socket.emit('init', {
      worldRadius: WORLD_RADIUS, centerX: CX, centerY: CY,
      food: food.slice(0, 300), playerId: socket.id
    });
  });
  socket.on('input', (data) => {
    const p = players.get(socket.id);
    if (!p || !p.alive || !data) return;
    const tx = Number(data.targetX), ty = Number(data.targetY);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    p.targetX = clamp(tx, CX - WORLD_RADIUS * 2, CX + WORLD_RADIUS * 2);
    p.targetY = clamp(ty, CY - WORLD_RADIUS * 2, CY + WORLD_RADIUS * 2);
  });
  socket.on('split', () => { const p = players.get(socket.id); if (p && p.alive) doSplit(p); });
  socket.on('eject', () => { const p = players.get(socket.id); if (p && p.alive) doEject(p); });
  socket.on('disconnect_player', () => { players.delete(socket.id); });
  socket.on('disconnect', () => {
    players.delete(socket.id);
    unregisterSocket();
    console.log('🔴 ' + socket.id + ' left');
  });
});

/* ================= LOOPS ================= */
let lastTime = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  tick(dt);
}, 1000 / TICK_RATE);

let bc = 0;
setInterval(() => {
  bc++;
  if (bc % 3 !== 0) return;
  const snapshot = { players: [], food: food.slice(0, 250) };
  for (const [, p] of players) {
    if (!p.alive) continue;
    snapshot.players.push({
      id: p.id, name: p.name, color: p.color, isBot: false,
      cells: p.cells.map(c => ({ x: Math.round(c.x), y: Math.round(c.y), mass: Math.round(c.mass),
        mergeTimer: Math.max(0, Math.round(c.mergeTimer * 10) / 10) })),
      kills: p.kills, maxMass: Math.round(p.maxMass)
    });
  }
  for (const [, b] of botPlayers) {
    if (!b.alive) continue;
    snapshot.players.push({
      id: b.id, name: b.name, color: b.color, isBot: true,
      cells: b.cells.map(c => ({ x: Math.round(c.x), y: Math.round(c.y), mass: Math.round(c.mass),
        mergeTimer: Math.max(0, Math.round(c.mergeTimer * 10) / 10) })),
      kills: b.kills, maxMass: Math.round(b.maxMass)
    });
  }
  io.emit('state', snapshot);
}, 1000 / 60);

/* ================= START ================= */
(async () => {
  await initDatabase();   // must finish BEFORE the wallet loads (the old code raced these two)
  await initTonWallet();
  server.listen(PORT, () => {
    console.log('🪐 Planet.io v4.0.0 on ' + PORT);
    console.log('   BOT_TOKEN: ' + (BOT_TOKEN ? '✓' : '✗'));
    console.log('   DATABASE: ' + (dbReady ? '✓' : '✗'));
    console.log('   TON_WALLET: ' + (hotWallet ? '✓ ' + walletAddressString(hotWallet) : '✗'));
    console.log('   TON_API_KEY: ' + (TON_API_KEY ? '✓' : '✗ (toncenter free tier: 1 req/sec)'));
    console.log('   ADMIN_PASSWORD: ' + (process.env.ADMIN_PASSWORD ? 'from env' : 'DEFAULT (262626) — CHANGE IT'));
  });
  setInterval(() => { scanIncomingPayments().catch(() => {}); }, SCAN_INTERVAL_MS);
  setInterval(() => { runPayoutWorker().catch(() => {}); }, PAYOUT_WORKER_INTERVAL_MS);
  setInterval(() => { expireOldOrders().catch(() => {}); }, 10 * 60 * 1000);
})();
