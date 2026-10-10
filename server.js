// server.js - Planet.io Online v3.0
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000
});
app.use(express.static('public'));

/* ================= CONFIG ================= */
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

const WORLD_RADIUS = 1200;      // Smaller map so bots are visible
const CX = 1500, CY = 1500;
const FOOD_COUNT = 500;
const BOT_COUNT = 18;            // More bots
const TICK_RATE = 60;
const BROADCAST_RATE = 20;

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
const MAX_VELOCITY = 2200;

/* ================= DATABASE ================= */
let db = null;
let dbReady = false;

if (DATABASE_URL) {
  db = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5
  });
  initDatabase();
} else {
  console.warn('⚠️ DATABASE_URL not set — memory only');
}

async function initDatabase() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        tokens INTEGER DEFAULT 0,
        speed_level INTEGER DEFAULT 0,
        mass_level INTEGER DEFAULT 0,
        unlocked_skins TEXT DEFAULT '["default"]',
        current_skin TEXT DEFAULT 'default',
        total_kills INTEGER DEFAULT 0,
        high_score INTEGER DEFAULT 0,
        created_at BIGINT,
        last_seen BIGINT
      );
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    await db.query(`INSERT INTO admin_settings (key, value) VALUES ('lootbox_price', '0.01') ON CONFLICT (key) DO NOTHING;`);
    await db.query(`INSERT INTO admin_settings (key, value) VALUES ('lootbox_remaining', '-1') ON CONFLICT (key) DO NOTHING;`);
    await db.query(`INSERT INTO admin_settings (key, value) VALUES ('lootbox_tag', '') ON CONFLICT (key) DO NOTHING;`);
    dbReady = true;
    console.log('✅ Database ready');
  } catch (e) {
    console.error('❌ DB init error:', e.message);
    dbReady = false;
  }
}

async function getOrCreateUser(id, username, firstName) {
  if (!dbReady) return {
    telegram_id: id, username, first_name: firstName,
    tokens: 0, speed_level: 0, mass_level: 0,
    unlocked_skins: '["default"]', current_skin: 'default',
    total_kills: 0, high_score: 0
  };
  try {
    const r = await db.query('SELECT * FROM users WHERE telegram_id = $1', [id]);
    if (r.rows.length === 0) {
      await db.query(
        `INSERT INTO users (telegram_id, username, first_name, created_at, last_seen)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, username, firstName, Date.now(), Date.now()]
      );
      const r2 = await db.query('SELECT * FROM users WHERE telegram_id = $1', [id]);
      return r2.rows[0];
    }
    await db.query('UPDATE users SET last_seen = $1, username = $2 WHERE telegram_id = $3',
      [Date.now(), username, id]);
    return r.rows[0];
  } catch (e) {
    console.error('getOrCreateUser:', e.message);
    return null;
  }
}

async function saveProgress(id, data) {
  if (!dbReady) return false;
  try {
    await db.query(
      `UPDATE users SET
        tokens = $1, speed_level = $2, mass_level = $3,
        unlocked_skins = $4, current_skin = $5,
        total_kills = $6, high_score = $7, last_seen = $8
       WHERE telegram_id = $9`,
      [
        Math.max(0, parseInt(data.tokens) || 0),
        Math.min(50, Math.max(0, parseInt(data.speedLevel) || 0)),
        Math.min(15, Math.max(0, parseInt(data.massLevel) || 0)),
        JSON.stringify(data.unlockedSkins || ['default']),
        data.currentSkin || 'default',
        Math.max(0, parseInt(data.totalKills) || 0),
        Math.max(0, parseInt(data.highScore) || 0),
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

async function getAdminSettings() {
  if (!dbReady) return { lootbox_price: '0.01', lootbox_remaining: '-1', lootbox_tag: '' };
  try {
    const r = await db.query('SELECT key, value FROM admin_settings');
    const out = {};
    for (const row of r.rows) out[row.key] = row.value;
    return out;
  } catch (e) {
    return { lootbox_price: '0.01', lootbox_remaining: '-1', lootbox_tag: '' };
  }
}

async function setAdminSetting(key, value) {
  if (!dbReady) return false;
  try {
    await db.query(
      'INSERT INTO admin_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, String(value)]
    );
    return true;
  } catch (e) {
    return false;
  }
}

/* ================= TELEGRAM ================= */
function validateTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const validationHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (validationHash !== hash) return null;
    const userJson = params.get('user');
    if (!userJson) return null;
    return JSON.parse(userJson);
  } catch (e) { return null; }
}

/* ================= GAME STATE ================= */
const players = new Map();
const botPlayers = new Map();
const food = [];

function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function massToRadius(m) { return Math.sqrt(m) * 4.5; }

// AGAR.IO SPEED FORMULA
function massToSpeed(m) {
  // speed decreases as mass increases
  return 22 * Math.pow(m, -0.32) * 4.5;
}

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
    cells: [{
      x: pos.x, y: pos.y,
      mass: startMass || START_MASS,
      vx: 0, vy: 0,
      mergeTimer: 0
    }],
    targetX: pos.x, targetY: pos.y,
    alive: true, kills: 0, maxMass: startMass || START_MASS,
    spawnTime: Date.now(),
    isBot: !!isBot,
    botTimer: 0,
    botTargetX: pos.x, botTargetY: pos.y
  };
}

// AGAR.IO-LIKE CELL MOVEMENT
function updateCell(cell, dt, tx, ty) {
  const dx = tx - cell.x, dy = ty - cell.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.5) return;

  const speed = massToSpeed(cell.mass) * 10;
  const dirX = dx / d, dirY = dy / d;

  // Agar.io style: full speed if far, slow down near target
  let moveSpeed = speed;
  if (d < 40) moveSpeed = speed * (d / 40);

  cell.x += dirX * moveSpeed * dt;
  cell.y += dirY * moveSpeed * dt;

  // Circle bounds
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
  // Update all players
  const allPlayers = [...players.values(), ...botPlayers.values()];

  // Bot AI
  for (const bot of botPlayers.values()) {
    if (!bot.alive) continue;
    bot.botTimer -= dt;
    if (bot.botTimer > 0) continue;
    bot.botTimer = 0.15 + Math.random() * 0.15;

    const bc = getCenter(bot);
    const bm = getTotalMass(bot);

    // Find best food
    let bestFood = null, bestFoodD = Infinity;
    for (let i = 0; i < food.length; i += 2) {
      const f = food[i];
      const d2 = (f.x - bc.x) ** 2 + (f.y - bc.y) ** 2;
      if (d2 < bestFoodD && d2 < 500 * 500) { bestFoodD = d2; bestFood = f; }
    }

    // Find threat & prey
    let threat = null, threatD = Infinity;
    let prey = null, preyD = Infinity;
    for (const other of allPlayers) {
      if (other === bot || !other.alive) continue;
      const oc = getCenter(other);
      const om = getTotalMass(other);
      const d2 = (oc.x - bc.x) ** 2 + (oc.y - bc.y) ** 2;
      if (d2 > 500 * 500) continue;
      if (om > bm * 1.15) {
        if (d2 < threatD) { threatD = d2; threat = oc; }
      } else if (bm > om * 1.3) {
        if (d2 < preyD) { preyD = d2; prey = oc; }
      }
    }

    let tx = bc.x, ty = bc.y;
    // Priority: flee > chase > eat food
    if (threat && threatD < 300 * 300) {
      tx = bc.x + (bc.x - threat.x);
      ty = bc.y + (bc.y - threat.y);
    } else if (prey && preyD < 400 * 400 && Math.random() < 0.7) {
      tx = prey.x;
      ty = prey.y;
    } else if (bestFood) {
      tx = bestFood.x;
      ty = bestFood.y;
    } else {
      tx = bc.x + rand(-200, 200);
      ty = bc.y + rand(-200, 200);
    }

    // Keep inside bounds
    const tdx = tx - CX, tdy = ty - CY;
    const td = Math.sqrt(tdx * tdx + tdy * tdy);
    const maxTD = WORLD_RADIUS - 150;
    if (td > maxTD) { tx = CX + (tdx / td) * maxTD; ty = CY + (tdy / td) * maxTD; }

    bot.targetX = tx;
    bot.targetY = ty;
  }

  // Update all cells
  for (const p of allPlayers) {
    if (!p.alive) continue;
    for (const cell of p.cells) updateCell(cell, dt, p.targetX, p.targetY);

    // Merge cells of same player
    for (let a = 0; a < p.cells.length; a++) {
      for (let b = a + 1; b < p.cells.length; b++) {
        if (a >= p.cells.length || b >= p.cells.length) break;
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
            b = a; break;
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

  // Food eating
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

  // Player vs Player
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
              cellA.mass += cellB.mass;
              B.cells.splice(cb, 1);
              A.kills++;
              if (B.cells.length === 0) B.alive = false;
              continue;
            }
          }
          if (cellB.mass > cellA.mass * EAT_MASS_RATIO) {
            const eatDist = rb - ra * EAT_OVERLAP;
            if (d2 < eatDist * eatDist) {
              cellB.mass += cellA.mass;
              A.cells.splice(ca, 1);
              B.kills++;
              if (A.cells.length === 0) A.alive = false;
              break;
            }
          }
        }
      }
    }
  }

  // Respawn bots
  for (const [, bot] of botPlayers) {
    if (!bot.alive) {
      const pos = randomWorldPos(300);
      bot.cells = [{ x: pos.x, y: pos.y, mass: START_MASS, vx: 0, vy: 0, mergeTimer: 0 }];
      bot.targetX = pos.x; bot.targetY = pos.y;
      bot.alive = true;
      bot.kills = 0;
      bot.maxMass = START_MASS;
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
    cell.mass = half;
    cell.mergeTimer = MERGE_TIME;
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
    food.push({
      x: ejX, y: ejY,
      r: 255, g: 200, b: 100,
      vx: dx * 1000, vy: dy * 1000,
      isEjected: true, life: 6
    });
  }
}

/* ================= INIT BOTS ================= */
function initBots() {
  const names = ['Nova','Orion','Luna','Vega','Atlas','Cosmo','Nebula','Astro','Stella','Pulsar','Comet','Quasar','Galaxy','Titan','Phoenix','Zephyr','Hydra','Draco'];
  const colors = ['#ff4d6b', '#33e066', '#4a9eff', '#ffcc00', '#a55cff', '#ff8800', '#00ffaa', '#ff6bd6'];
  for (let i = 0; i < BOT_COUNT; i++) {
    const bot = createPlayer('bot_' + i, names[i % names.length], colors[i % colors.length], START_MASS, true);
    botPlayers.set('bot_' + i, bot);
  }
}
initBots();

/* ================= SOCKET.IO ================= */
io.on('connection', (socket) => {
  console.log('🟢 ' + socket.id);
  let currentUserId = null;

  socket.on('auth', async (data) => {
    let userData = null;
    if (data.initData && BOT_TOKEN) {
      const tgUser = validateTelegramInitData(data.initData);
      if (tgUser) {
        userData = { id: 'tg_' + tgUser.id, username: tgUser.username || '', firstName: tgUser.first_name || 'Player' };
      }
    }
    if (!userData && data.deviceId) {
      userData = { id: 'dev_' + data.deviceId, username: '', firstName: 'Guest' };
    }
    if (!userData) {
      socket.emit('auth_error', { message: 'Auth failed' });
      return;
    }
    currentUserId = userData.id;
    const user = await getOrCreateUser(userData.id, userData.username, userData.firstName);
    const settings = await getAdminSettings();

    socket.emit('auth_ok', {
      user: {
        id: user.telegram_id,
        name: user.first_name || 'Player',
        tokens: user.tokens || 0,
        speedLevel: user.speed_level || 0,
        massLevel: user.mass_level || 0,
        unlockedSkins: JSON.parse(user.unlocked_skins || '["default"]'),
        currentSkin: user.current_skin || 'default',
        totalKills: user.total_kills || 0,
        highScore: user.high_score || 0
      },
      settings: settings
    });
  });

  socket.on('save_progress', async (data) => {
    if (!currentUserId) return;
    await saveProgress(currentUserId, data);
  });

  socket.on('admin_set', async (data) => {
    if (!data || !data.key) return;
    const ok = await setAdminSetting(data.key, data.value);
    if (ok) io.emit('settings_update', await getAdminSettings());
  });

  socket.on('join', (data) => {
    // Remove existing
    players.delete(socket.id);
    const p = createPlayer(socket.id, data.name, data.color, data.startMass, false);
    players.set(socket.id, p);
    console.log('🎮 ' + p.name + ' joined. Players: ' + players.size);

    socket.emit('init', {
      worldRadius: WORLD_RADIUS,
      centerX: CX,
      centerY: CY,
      food: food.slice(0, 300),
      playerId: socket.id
    });
  });

  socket.on('input', (data) => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    p.targetX = data.targetX;
    p.targetY = data.targetY;
  });

  socket.on('split', () => {
    const p = players.get(socket.id);
    if (p && p.alive) doSplit(p);
  });

  socket.on('eject', () => {
    const p = players.get(socket.id);
    if (p && p.alive) doEject(p);
  });

  socket.on('ate_food', (data) => {
    if (!data) return;
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    let bestIdx = -1, bestD2 = 500;
    for (let i = 0; i < food.length; i++) {
      const f = food[i];
      const dx = f.x - data.x, dy = f.y - data.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestIdx >= 0) food.splice(bestIdx, 1);
  });

  socket.on('disconnect_player', () => {
    players.delete(socket.id);
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    console.log('🔴 ' + socket.id + ' left. Players: ' + players.size);
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

  // Add all real players
  for (const [, p] of players) {
    if (!p.alive) continue;
    snapshot.players.push({
      id: p.id, name: p.name, color: p.color, isBot: false,
      cells: p.cells.map(c => ({
        x: Math.round(c.x), y: Math.round(c.y),
        mass: Math.round(c.mass),
        mergeTimer: Math.max(0, Math.round(c.mergeTimer * 10) / 10)
      })),
      kills: p.kills, maxMass: Math.round(p.maxMass)
    });
  }

  // Add all bots
  for (const [, b] of botPlayers) {
    if (!b.alive) continue;
    snapshot.players.push({
      id: b.id, name: b.name, color: b.color, isBot: true,
      cells: b.cells.map(c => ({
        x: Math.round(c.x), y: Math.round(c.y),
        mass: Math.round(c.mass),
        mergeTimer: Math.max(0, Math.round(c.mergeTimer * 10) / 10)
      })),
      kills: b.kills, maxMass: Math.round(b.maxMass)
    });
  }

  io.emit('state', snapshot);
}, 1000 / 60);

server.listen(PORT, () => {
  console.log('🪐 Planet.io v3 on ' + PORT);
  console.log('   BOT_TOKEN: ' + (BOT_TOKEN ? '✓' : '✗'));
  console.log('   DATABASE: ' + (DATABASE_URL ? '✓' : '✗'));
});
