const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static('public'));

/* ============ CONFIG ============ */
const WORLD_RADIUS = 1400;
const CX = 1500, CY = 1500;
const FOOD_COUNT = 400;
const TICK_RATE = 60;
const BROADCAST_RATE = 20; // ← کاهش از ۳۰ به ۲۰

const START_MASS = 22;
const MAX_CELLS = 16;
const MERGE_TIME = 20;
const MIN_SPLIT_MASS = 36;
const EAT_MASS_RATIO = 1.15;
const EAT_OVERLAP = 0.4;
const SPLIT_LAUNCH_SPEED = 1300;
const DRAG = 0.85;
const BASE_SPEED_MULTIPLIER = 32;
const MAX_VELOCITY = 1800;
const MASS_DECAY_RATE = 0.002;
const MASS_DECAY_MIN = 40;

/* ============ STATE ============ */
const players = new Map();
const food = [];

/* ============ HELPERS ============ */
function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function massToRadius(m) { return Math.sqrt(m) * 4.5; }
function massToSpeed(m) {
  const r = massToRadius(m);
  return 16 * 1.6 / Math.pow(r, 0.32) * BASE_SPEED_MULTIPLIER;
}
function randomWorldPos(margin) {
  margin = margin || 30;
  const maxR = Math.max(50, WORLD_RADIUS - margin);
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * maxR;
  return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r };
}

/* ============ FOOD ============ */
function spawnFood() {
  const pos = randomWorldPos(30);
  return {
    x: pos.x, y: pos.y,
    r: randInt(80, 255),
    g: randInt(80, 255),
    b: randInt(80, 255)
  };
}
for (let i = 0; i < FOOD_COUNT; i++) food.push(spawnFood());

/* ============ PLAYER ============ */
function createPlayer(id, name, color) {
  const pos = randomWorldPos(200);
  return {
    id, name: name || 'Player',
    color: color || '#4a9eff',
    cells: [{
      x: pos.x, y: pos.y,
      mass: START_MASS,
      vx: 0, vy: 0,
      mergeTimer: 0
    }],
    targetX: pos.x,
    targetY: pos.y,
    alive: true,
    kills: 0,
    maxMass: START_MASS,
    spawnTime: Date.now()
  };
}
function getTotalMass(p) {
  let s = 0;
  for (const c of p.cells) s += c.mass;
  return s;
}
function getCenter(p) {
  let tot = 0, sx = 0, sy = 0;
  for (const c of p.cells) {
    tot += c.mass;
    sx += c.x * c.mass;
    sy += c.y * c.mass;
  }
  return tot > 0 ? { x: sx / tot, y: sy / tot } : { x: 0, y: 0 };
}

/* ============ PHYSICS ============ */
function updateCell(cell, dt, tx, ty) {
  const dx = tx - cell.x, dy = ty - cell.y;
  let d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.01) d = 0.01;
  const baseSpeed = massToSpeed(cell.mass);
  const factor = Math.min(1, d / 60);
  const accel = 8;
  cell.vx += (dx / d) * baseSpeed * factor * dt * accel;
  cell.vy += (dy / d) * baseSpeed * factor * dt * accel;
  const dragFactor = Math.pow(DRAG, dt * 60);
  cell.vx *= dragFactor;
  cell.vy *= dragFactor;
  const vmag = Math.sqrt(cell.vx * cell.vx + cell.vy * cell.vy);
  if (vmag > MAX_VELOCITY) {
    cell.vx = (cell.vx / vmag) * MAX_VELOCITY;
    cell.vy = (cell.vy / vmag) * MAX_VELOCITY;
  }
  cell.x += cell.vx * dt;
  cell.y += cell.vy * dt;

  const r = massToRadius(cell.mass);
  const dxC = cell.x - CX, dyC = cell.y - CY;
  const distC = Math.sqrt(dxC * dxC + dyC * dyC);
  const maxDist = WORLD_RADIUS - r;
  if (distC > maxDist) {
    const nx = dxC / distC, ny = dyC / distC;
    cell.x = CX + nx * maxDist;
    cell.y = CY + ny * maxDist;
    const dot = cell.vx * nx + cell.vy * ny;
    if (dot > 0) {
      cell.vx -= 2 * dot * nx;
      cell.vy -= 2 * dot * ny;
    }
    cell.vx *= 0.4;
    cell.vy *= 0.4;
  }
  if (cell.mass > MASS_DECAY_MIN) cell.mass -= cell.mass * MASS_DECAY_RATE * dt;
  if (cell.mergeTimer > 0) cell.mergeTimer -= dt;
}

/* ============ TICK ============ */
function tick(dt) {
  for (const [, p] of players) {
    if (!p.alive) continue;
    for (const cell of p.cells) updateCell(cell, dt, p.targetX, p.targetY);

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
            b = a;
            break;
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

  for (const [, p] of players) {
    if (!p.alive) continue;
    for (const cell of p.cells) {
      const cr = massToRadius(cell.mass);
      const cr2 = cr * cr;
      for (let i = food.length - 1; i >= 0; i--) {
        const f = food[i];
        const dx = f.x - cell.x, dy = f.y - cell.y;
        if (dx * dx + dy * dy < cr2) {
          cell.mass += 1;
          food.splice(i, 1);
        }
      }
    }
  }
  while (food.length < FOOD_COUNT) food.push(spawnFood());

  const list = [...players.values()].filter(p => p.alive);
  for (let i = 0; i < list.length; i++) {
    const A = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const B = list[j];
      for (let ca = A.cells.length - 1; ca >= 0; ca--) {
        if (ca >= A.cells.length) continue;
        const cellA = A.cells[ca];
        if (!cellA) continue;
        for (let cb = B.cells.length - 1; cb >= 0; cb--) {
          if (cb >= B.cells.length) continue;
          const cellB = B.cells[cb];
          if (!cellB) continue;
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
}

/* ============ SPLIT / EJECT ============ */
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
    ncs.push({
      x: nX, y: nY, mass: half,
      vx: dx * ls, vy: dy * ls,
      mergeTimer: MERGE_TIME
    });
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
    if (cell.mass < 34) continue;
    cell.mass -= 18;
    const ejX = cell.x + dx * massToRadius(cell.mass);
    const ejY = cell.y + dy * massToRadius(cell.mass);
    food.push({
      x: ejX, y: ejY,
      r: 255, g: 200, b: 100,
      vx: dx * 1200, vy: dy * 1200,
      isEjected: true, life: 6
    });
  }
}

/* ============ SOCKET.IO ============ */
io.on('connection', (socket) => {
  console.log('🟢 Connected: ' + socket.id);

  socket.on('join', (data) => {
    const p = createPlayer(socket.id, data.name, data.color);
    players.set(socket.id, p);
    console.log('👤 ' + p.name + ' joined. Total: ' + players.size);

    socket.emit('init', {
      worldRadius: WORLD_RADIUS,
      centerX: CX,
      centerY: CY,
      food: food,
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

  socket.on('disconnect', () => {
    players.delete(socket.id);
    console.log('🔴 Disconnected: ' + socket.id + '. Total: ' + players.size);
  });
});

/* ============ LOOPS ============ */
let lastTime = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  tick(dt);
}, 1000 / TICK_RATE);

// Broadcast at 20 FPS (every 3rd tick)
let broadcastCounter = 0;
setInterval(() => {
  broadcastCounter++;
  if (broadcastCounter % 3 !== 0) return;

  const snapshot = {
    players: [],
    food: food.slice(0, 250) // ← کاهش از ۶۰۰ به ۲۵۰
  };
  for (const [, p] of players) {
    if (!p.alive) continue;
    snapshot.players.push({
      id: p.id,
      name: p.name,
      color: p.color,
      cells: p.cells.map(c => ({
        x: Math.round(c.x),
        y: Math.round(c.y),
        mass: Math.round(c.mass),
        mergeTimer: Math.max(0, Math.round(c.mergeTimer * 10) / 10)
      })),
      kills: p.kills,
      maxMass: Math.round(p.maxMass)
    });
  }
  io.emit('state', snapshot);
}, 1000 / 60); // 60Hz timer for %3 filter → 20 Hz broadcast

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🪐 Planet.io Online running on port ' + PORT);
});
