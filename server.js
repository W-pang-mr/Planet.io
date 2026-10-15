const express = require('express'), crypto = require('crypto'), path = require('path'), fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { TonClient, WalletContractV5R1, internal } = require('@ton/ton');
const { Address, SendMode } = require('@ton/core');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const E = process.env;
const BASE = E.BASE_URL || E.RENDER_EXTERNAL_URL || '';
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const app = express();
app.use(express.json({ limit: '50kb' }));
const PUB = ['Public', 'public'].map(d => path.join(__dirname, d)).find(d => fs.existsSync(d)) || __dirname;
app.use(express.static(PUB));

/* ---------- helpers ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cfgCache = { t: 0, v: {} };
async function settings() {
  if (Date.now() - cfgCache.t < 4000) return cfgCache.v;
  const { data } = await sb.from('app_settings').select('key,value');
  const v = {}; (data || []).forEach(r => v[r.key] = r.value);
  cfgCache = { t: Date.now(), v }; return v;
}
function verify(init) {
  if (!init) return null;
  const p = new URLSearchParams(init); const hash = p.get('hash'); p.delete('hash');
  const str = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(E.BOT_TOKEN).digest();
  const h = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (h !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}
async function adminIds() {
  const s = await settings();
  const env = (E.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  return [...env, ...(Array.isArray(s.admin_telegram_ids) ? s.admin_telegram_ids : []).map(String)];
}
const hits = new Map();
function limited(uid) {
  const now = Date.now(), a = (hits.get(uid) || []).filter(t => now - t < 10000);
  a.push(now); hits.set(uid, a); return a.length > 40;
}
const locks = new Map();
async function withLock(uid, fn) {
  while (locks.get(uid)) await sleep(30);
  locks.set(uid, true);
  try { return await fn(); } finally { locks.delete(uid); }
}
const wrap = (fn, admin) => async (req, res) => {
  try {
    const u = verify(req.get('X-Init'));
    if (!u) return res.status(401).json({ error: 'Open the game from Telegram' });
    if (limited(u.id)) return res.status(429).json({ error: 'Too many requests' });
    if (admin && !(await adminIds()).includes(String(u.id))) return res.status(403).json({ error: 'Admins only' });
    req.u = u; await fn(req, res);
  } catch (e) { console.error(e); res.status(400).json({ error: (e.message || 'error').slice(0, 160) }); }
};
const nano = t => Math.round(Number(t) * 1e9);

/* ---------- player api ---------- */
app.get('/api/me', wrap(async (req, res) => {
  const u = req.u;
  await sb.from('players').upsert({ telegram_id: u.id, username: u.username || null, first_name: u.first_name || null, last_seen: new Date().toISOString() }, { onConflict: 'telegram_id' });
  await sb.from('player_guns').upsert({ telegram_id: u.id, gun_id: 'colt' }, { onConflict: 'telegram_id,gun_id', ignoreDuplicates: true });
  await sb.from('player_skins').upsert({ telegram_id: u.id, skin_id: 'colt_0' }, { onConflict: 'telegram_id,skin_id', ignoreDuplicates: true });
  const [{ data: player }, { data: guns }, { data: skins }, { data: og }, { data: os }, { data: wd }] = await Promise.all([
    sb.from('players').select('*').eq('telegram_id', u.id).single(),
    sb.from('guns').select('id,name,price_nano,sort').eq('active', true).order('sort'),
    sb.from('skins').select('id,name,rarity,price_nano,sort,gun').eq('active', true).order('sort'),
    sb.from('player_guns').select('gun_id').eq('telegram_id', u.id),
    sb.from('player_skins').select('skin_id').eq('telegram_id', u.id),
    sb.from('withdrawals').select('id,amount_nano,fee_nano,status,address,created_at').eq('telegram_id', u.id).order('id', { ascending: false }).limit(8)
  ]);
  if (player.banned) throw new Error('Account banned');
  const s = await settings();
  res.json({
    player, guns, skins, ownedGuns: og.map(o => o.gun_id), ownedSkins: os.map(o => o.skin_id), withdrawals: wd,
    cfg: { reward: s.reward_per_kill_nano, min: s.min_withdraw_nano, fee: s.withdraw_fee_nano, cap: s.daily_withdraw_cap_nano },
    deposit: { address: walletAddr, comment: 'G' + u.id },
    isAdmin: (await adminIds()).includes(String(u.id))
  });
}));

app.post('/api/session/start', wrap(async (req, res) => {
  await sb.from('game_sessions').update({ status: 'finished', ended_at: new Date().toISOString() }).eq('telegram_id', req.u.id).eq('status', 'active');
  const { data, error } = await sb.from('game_sessions').insert({ telegram_id: req.u.id }).select('id').single();
  if (error) throw error; res.json({ sid: data.id });
}));

app.post('/api/session/kills', wrap(async (req, res) => {
  const uid = req.u.id;
  await withLock(uid, async () => {
    const { sid, kills } = req.body; const k = Math.floor(Number(kills));
    if (!sid || !(k > 0)) throw new Error('bad request');
    const { data: s } = await sb.from('game_sessions').select('*').eq('id', sid).eq('telegram_id', uid).single();
    if (!s || s.status !== 'active') throw new Error('session closed');
    const cfg = await settings();
    const el = (Date.now() - new Date(s.started_at)) / 60000;
    const allowed = Math.max(0, Math.floor(el * Number(cfg.max_kills_per_minute || 40)) + 3 - s.kills_paid);
    const n = Math.min(k, allowed, 60);
    await sb.from('game_sessions').update({ kills_claimed: s.kills_claimed + k }).eq('id', sid);
    if (n > 0) {
      const { error } = await sb.rpc('award_kills', { p_tid: uid, p_session: sid, p_kills: n });
      if (error) throw error;
      // skin multiplier bonus on top of base award_kills
      const mult = await playerRewardMult(uid);
      if (mult > 1.001) {
        const bonus = Math.round((mult - 1) * n * Number(cfg.reward_per_kill_nano || 0));
        if (bonus > 0) {
          const { data: p0 } = await sb.from('players').select('balance_nano').eq('telegram_id', uid).single();
          await sb.from('players').update({ balance_nano: Number(p0.balance_nano) + bonus }).eq('telegram_id', uid);
          try { await sb.from('ledger').insert({ telegram_id: uid, type: 'skin_bonus', amount_nano: bonus, ref: String(sid) }); } catch (_) {}
        }
      }
    }
    const { data: p } = await sb.from('players').select('balance_nano,total_kills').eq('telegram_id', uid).single();
    res.json({ paid: n, balance: p.balance_nano, total: p.total_kills });
  });
}));

app.post('/api/session/end', wrap(async (req, res) => {
  await sb.from('game_sessions').update({ status: 'finished', ended_at: new Date().toISOString() }).eq('id', req.body.sid).eq('telegram_id', req.u.id);
  const { data: p } = await sb.from('players').select('balance_nano,total_kills').eq('telegram_id', req.u.id).single();
  res.json({ balance: p.balance_nano, total: p.total_kills });
}));

app.post('/api/skin/buy', wrap(async (req, res) => {
  await withLock(req.u.id, async () => {
    const { error } = await sb.rpc('buy_skin', { p_tid: req.u.id, p_skin: String(req.body.id) });
    if (error) throw new Error(error.message.includes('check') ? 'Not enough balance' : error.message);
    const { data: p } = await sb.from('players').select('balance_nano').eq('telegram_id', req.u.id).single();
    res.json({ balance: p.balance_nano });
  });
}));

app.post('/api/gun/buy', wrap(async (req, res) => {
  await withLock(req.u.id, async () => {
    const { error } = await sb.rpc('buy_gun', { p_tid: req.u.id, p_gun: String(req.body.id) });
    if (error) throw new Error(error.message.includes('check') ? 'Not enough balance' : error.message);
    const { data: p } = await sb.from('players').select('balance_nano').eq('telegram_id', req.u.id).single();
    res.json({ balance: p.balance_nano });
  });
}));

app.post('/api/skin/equip', wrap(async (req, res) => {
  const id = String(req.body.id);
  const { data: o } = await sb.from('player_skins').select('skin_id').eq('telegram_id', req.u.id).eq('skin_id', id);
  if (!o || !o.length) throw new Error('Skin not owned');
  const { data: sk } = await sb.from('skins').select('gun').eq('id', id).single();
  const { data: p } = await sb.from('players').select('equipped_skins').eq('telegram_id', req.u.id).single();
  const eq = { ...(p.equipped_skins || {}), [sk.gun]: id };
  await sb.from('players').update({ equipped_skins: eq }).eq('telegram_id', req.u.id);
  res.json({ equipped: eq });
}));

// Character skins stored inside equipped_skins JSON: { character, _chars:[] }
const CHAR_PRICES = { char_0: 5e7, char_1: 12e7, char_2: 25e7, char_3: 5e8, char_4: 12e8 };
const CHAR_MULT = { char_0: 1.5, char_1: 2, char_2: 2.5, char_3: 3.5, char_4: 5 };
const GUN_SKIN_MULT = { 0: 1, 1: 1.5, 2: 2 };
app.post('/api/char/buy', wrap(async (req, res) => {
  await withLock(req.u.id, async () => {
    const id = String(req.body.id || '');
    if (!CHAR_PRICES[id]) throw new Error('Unknown character skin');
    const price = CHAR_PRICES[id];
    const { data: p } = await sb.from('players').select('balance_nano,equipped_skins').eq('telegram_id', req.u.id).single();
    const eq = { ...(p.equipped_skins || {}) };
    const owned = Array.isArray(eq._chars) ? eq._chars.slice() : [];
    if (owned.includes(id)) {
      eq.character = id;
      await sb.from('players').update({ equipped_skins: eq }).eq('telegram_id', req.u.id);
      return res.json({ balance: p.balance_nano, character_skin: id, owned_chars: owned });
    }
    if (Number(p.balance_nano) < price) throw new Error('Not enough balance');
    owned.push(id);
    eq._chars = owned;
    eq.character = id;
    const { data: up, error } = await sb.from('players').update({
      balance_nano: Number(p.balance_nano) - price,
      equipped_skins: eq
    }).eq('telegram_id', req.u.id).select('balance_nano').single();
    if (error) throw error;
    try { await sb.from('ledger').insert({ telegram_id: req.u.id, type: 'char_purchase', amount_nano: -price, ref: id }); } catch (_) {}
    res.json({ balance: up.balance_nano, character_skin: id, owned_chars: owned });
  });
}));
app.post('/api/char/equip', wrap(async (req, res) => {
  const id = String(req.body.id || '');
  const { data: p } = await sb.from('players').select('equipped_skins').eq('telegram_id', req.u.id).single();
  const eq = { ...(p.equipped_skins || {}) };
  const owned = Array.isArray(eq._chars) ? eq._chars : [];
  if (!owned.includes(id)) throw new Error('Character skin not owned');
  eq.character = id;
  await sb.from('players').update({ equipped_skins: eq }).eq('telegram_id', req.u.id);
  res.json({ character_skin: id });
}));
async function playerRewardMult(uid) {
  try {
    const { data: p } = await sb.from('players').select('equipped_skins').eq('telegram_id', uid).single();
    const eq = p.equipped_skins || {};
    let maxG = 1;
    for (const k of Object.keys(eq)) {
      if (k === 'character' || k === '_chars') continue;
      const idx = +String(eq[k]).split('_')[1] || 0;
      maxG = Math.max(maxG, GUN_SKIN_MULT[idx] || 1);
    }
    const cm = CHAR_MULT[eq.character] || 1;
    return Math.min(maxG * cm, 12);
  } catch { return 1; }
}

app.get('/api/wallet', wrap(async (req, res) => {
  const uid = req.u.id, since = new Date(Date.now() - 864e5).toISOString();
  const [{ data: h }, { data: k }, { data: wd }] = await Promise.all([
    sb.from('ledger').select('type,amount_nano,ref,created_at').eq('telegram_id', uid).neq('type', 'kill_reward').order('id', { ascending: false }).limit(30),
    sb.from('ledger').select('amount_nano').eq('telegram_id', uid).eq('type', 'kill_reward').gte('created_at', since).limit(5000),
    sb.from('withdrawals').select('id,status').eq('telegram_id', uid).order('id', { ascending: false }).limit(40)
  ]);
  res.json({ history: h || [], today: (k || []).reduce((a, r) => a + Number(r.amount_nano), 0), wd: wd || [] });
}));

app.post('/api/withdraw', wrap(async (req, res) => {
  await withLock(req.u.id, async () => {
    let addr; try { addr = Address.parse(String(req.body.address).trim()).toString({ bounceable: false }); } catch { throw new Error('Invalid TON address'); }
    const amt = nano(req.body.amount);
    if (!(amt > 0)) throw new Error('Invalid amount');
    const { data, error } = await sb.rpc('request_withdrawal', { p_tid: req.u.id, p_amount: amt, p_address: addr });
    if (error) throw new Error(error.message.includes('check') ? 'Not enough balance' : error.message);
    await sb.from('players').update({ wallet_address: addr }).eq('telegram_id', req.u.id);
    const { data: p } = await sb.from('players').select('balance_nano').eq('telegram_id', req.u.id).single();
    res.json({ id: data, balance: p.balance_nano });
  });
}));

/* ---------- admin api ---------- */
const KEYS = ['reward_per_kill_nano', 'min_withdraw_nano', 'withdraw_fee_nano', 'daily_withdraw_cap_nano', 'max_kills_per_minute', 'min_deposit_nano'];
app.get('/api/admin/overview', wrap(async (req, res) => {
  const [{ data: skins }, { data: wd }, { count }, { data: weapons }, { data: guns }] = await Promise.all([
    sb.from('skins').select('*').order('sort'),
    sb.from('withdrawals').select('*').order('id', { ascending: false }).limit(50),
    sb.from('players').select('*', { count: 'exact', head: true }),
    sb.from('weapons').select('*').order('sort'),
    sb.from('guns').select('*').order('sort')
  ]);
  const s = await settings(); const cfg = {}; KEYS.forEach(k => cfg[k] = s[k]);
  let hot = null; try { if (client) hot = String(await client.getBalance(wallet.address)); } catch { }
  res.json({
    cfg,
    skins: skins || [],
    weapons: weapons || [],
    guns: guns || [],
    withdrawals: wd || [],
    players: count || 0,
    hot,
    address: walletAddr
  });
}, true));
app.post('/api/admin/settings', wrap(async (req, res) => {
  const { key, value } = req.body; if (!KEYS.includes(key)) throw new Error('bad key');
  const v = Number(value); if (!(v >= 0)) throw new Error('bad value');
  await sb.from('app_settings').upsert({ key, value: Math.round(v), updated_at: new Date().toISOString() });
  cfgCache.t = 0; res.json({ ok: 1 });
}, true));
app.post('/api/admin/skin', wrap(async (req, res) => {
  const { id, price_nano, active } = req.body;
  await sb.from('skins').update({ price_nano: Math.max(0, Math.round(Number(price_nano))), active: !!active }).eq('id', String(id)); res.json({ ok: 1 });
}, true));
app.post('/api/admin/weapon', wrap(async (req, res) => {
  const { id, price_nano, active } = req.body;
  await sb.from('weapons').update({ price_nano: Math.max(0, Math.round(Number(price_nano))), active: !!active }).eq('id', String(id)); res.json({ ok: 1 });
}, true));
app.post('/api/admin/gun', wrap(async (req, res) => {
  const { id, price_nano, active } = req.body;
  await sb.from('guns').update({ price_nano: Math.max(0, Math.round(Number(price_nano))), active: !!active }).eq('id', String(id)); res.json({ ok: 1 });
}, true));
app.post('/api/admin/refund', wrap(async (req, res) => {
  const { data, error } = await sb.rpc('refund_withdrawal', { p_wid: Number(req.body.id) });
  if (error) throw error; res.json({ ok: data });
}, true));
app.post('/api/admin/ban', wrap(async (req, res) => {
  await sb.from('players').update({ banned: !!req.body.banned }).eq('telegram_id', Number(req.body.telegram_id)); res.json({ ok: 1 });
}, true));

app.post('/api/admin/reset-user', wrap(async (req, res) => {
  const tid = Number(req.body.telegram_id); if (!tid) throw new Error('bad id');
  const { data } = await sb.from('players').update({ balance_nano: 0 }).eq('telegram_id', tid).select('telegram_id');
  res.json({ ok: 1, count: (data || []).length });
}, true));
// DANGER: zeroes every player's balance. Requires the literal confirm word.
app.post('/api/admin/reset-balances', wrap(async (req, res) => {
  if (req.body.confirm !== 'RESET') throw new Error('confirmation missing');
  const { data, error } = await sb.from('players').update({ balance_nano: 0 }).gt('balance_nano', 0).select('telegram_id');
  if (error) throw error;
  console.warn('ADMIN RESET ALL BALANCES by', req.u.id, 'players:', (data || []).length);
  res.json({ ok: 1, count: (data || []).length });
}, true));

/* ---------- Telegram bot (webhook) ---------- */
const tgSecret = crypto.createHash('sha256').update(String(E.BOT_TOKEN)).digest('hex').slice(0, 24);
const tg = (m, b) => fetch(`https://api.telegram.org/bot${E.BOT_TOKEN}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
app.post('/tg/' + tgSecret, async (req, res) => {
  res.sendStatus(200);
  try {
    const m = req.body.message; if (!m || !m.text) return;
    if (m.text.startsWith('/admin') && (await adminIds()).includes(String(m.from.id)))
      return tg('sendMessage', { chat_id: m.chat.id, text: 'Admin panel', reply_markup: { inline_keyboard: [[{ text: 'Open admin', web_app: { url: BASE + '/admin.html' } }]] } });
    if (m.text.startsWith('/start'))
      tg('sendMessage', { chat_id: m.chat.id, text: 'Welcome, soldier! Kill bots, earn TON.', reply_markup: { inline_keyboard: [[{ text: 'Play now', web_app: { url: BASE } }]] } });
  } catch (e) { console.error(e); }
});

/* ---------- TON wallet: deposits + withdrawals ---------- */
let client, wallet, contract, key, walletAddr = '';

/* ===== Deposit engine v2 =====
   - cursor based scan (never misses txs after downtime, paginates past 50)
   - strict comment parsing (text comments only, op = 0)
   - ignores bounces, failed txs, self-transfers, dust below minimum
   - idempotent crediting by tx hash (credit_deposit_v2, falls back to legacy RPC)
   - unmatched / below-min transfers are recorded for admin follow-up
   - fast polling while a user is watching the deposit screen */
const DEP_MIN_DEFAULT = 10000000; // 0.01 TON
let depLastLt = 0n, depWatchUntil = 0, depLastRun = 0, depBusy = false, v2Missing = false;
const depSeen = new Set(); // tx hashes handled in this process (avoid repeat DB work / repeat notifications)

function extractComment(body) {
  if (!body) return '';
  try {
    const s = body.beginParse();
    if (s.remainingBits < 32) return '';
    if (s.loadUint(32) !== 0) return ''; // only plain text comments (op 0)
    return (s.loadStringTail() || '').trim().slice(0, 120);
  } catch { return ''; }
}
function matchDepositComment(c) {
  if (!c) return null;
  const m = /^\s*[Gg]\s*[-:#]?\s*(\d{3,15})\s*$/.exec(String(c));
  return m ? Number(m[1]) : null;
}
async function depMin() {
  const s = await settings();
  const v = Number(s.min_deposit_nano ?? E.MIN_DEPOSIT_NANO ?? DEP_MIN_DEFAULT);
  return v > 0 ? v : DEP_MIN_DEFAULT;
}
async function depFetchNew() {
  const fresh = []; let cursor = null;
  for (let page = 0; page < 8; page++) {
    const opts = { limit: 50, archival: true };
    if (cursor) { opts.lt = cursor.lt; opts.hash = cursor.hash; }
    if (depLastLt > 0n) opts.to_lt = depLastLt.toString();
    const batch = await client.getTransactions(wallet.address, opts);
    const list = cursor ? batch.filter(t => String(t.lt) !== cursor.lt) : batch;
    if (!list.length) break;
    for (const t of list) if (BigInt(t.lt) > depLastLt) fresh.push(t);
    const oldest = list[list.length - 1];
    cursor = { lt: String(oldest.lt), hash: oldest.hash().toString('base64') };
    if (batch.length < 50) break;
  }
  return fresh.sort((a, b) => (BigInt(a.lt) < BigInt(b.lt) ? -1 : 1)); // oldest first
}
async function depRecord(row) { // best effort log for non-credited transfers
  try { await sb.from('deposits').upsert(row, { onConflict: 'tx_hash', ignoreDuplicates: true }); } catch (_) {}
}
async function depCredit(tid, coins, hash, comment, sender) {
  if (!v2Missing) {
    const { data, error } = await sb.rpc('credit_deposit_v2', { p_tid: tid, p_amount: coins, p_hash: hash, p_comment: comment, p_sender: sender });
    if (!error) return data === true; // true = newly credited, false = already credited
    if (/PGRST202|could not find|does not exist/i.test(error.code + ' ' + error.message)) {
      v2Missing = true; console.warn('credit_deposit_v2 missing — using legacy credit_deposit. Run deposit_v2.sql for full protection.');
    } else throw new Error(error.message);
  }
  const { error } = await sb.rpc('credit_deposit', { p_tid: tid, p_amount: coins, p_hash: hash, p_comment: comment });
  if (error) { if (/duplicate|unique|already/i.test(error.message || '')) return false; throw new Error(error.message); }
  return true;
}
async function pollDeposits() {
  if (depBusy || !client) return; depBusy = true; depLastRun = Date.now();
  try {
    const min = await depMin(), self = wallet.address.toRawString();
    const txs = await depFetchNew();
    let maxLt = depLastLt, allOk = true;
    for (const tx of txs) {
      const lt = BigInt(tx.lt), hash = tx.hash().toString('hex');
      if (depSeen.has(hash)) { if (lt > maxLt) maxLt = lt; continue; }
      const m = tx.inMessage;
      const aborted = tx.description && tx.description.type === 'generic' && tx.description.aborted;
      if (!m || m.info.type !== 'internal' || !m.info.src || m.info.bounced || aborted) { depSeen.add(hash); if (lt > maxLt) maxLt = lt; continue; }
      const sender = m.info.src.toString({ bounceable: false });
      if (m.info.src.toRawString() === self) { depSeen.add(hash); if (lt > maxLt) maxLt = lt; continue; }
      const coins = Number(m.info.value.coins);
      if (!(coins > 0)) { depSeen.add(hash); if (lt > maxLt) maxLt = lt; continue; }
      const comment = extractComment(m.body), tid = matchDepositComment(comment);
      try {
        if (!tid) {
          await depRecord({ tx_hash: hash, telegram_id: null, amount_nano: coins, comment, sender, status: 'unmatched' });
        } else if (coins < min) {
          await depRecord({ tx_hash: hash, telegram_id: tid, amount_nano: coins, comment, sender, status: 'below_min' });
        } else {
          const { data: pl } = await sb.from('players').select('telegram_id').eq('telegram_id', tid).maybeSingle();
          if (!pl) {
            await depRecord({ tx_hash: hash, telegram_id: tid, amount_nano: coins, comment, sender, status: 'unknown_user' });
          } else if (await depCredit(tid, coins, hash, comment || ('G' + tid), sender)) {
            const ton = (coins / 1e9).toFixed(4);
            console.log('deposit credited', tid, ton, 'TON', hash.slice(0, 12));
            tg('sendMessage', {
              chat_id: tid,
              text: `💎 Deposit received!\n\n+${ton} TON was added to your balance.\n🧾 Tx: ${hash.slice(0, 10)}…`,
              reply_markup: { inline_keyboard: [[{ text: 'Open game', web_app: { url: BASE || '' } }]] }
            }).catch(ne => console.error('deposit notify', tid, ne.message));
          }
        }
        depSeen.add(hash); if (lt > maxLt) maxLt = lt;
      } catch (e) { allOk = false; console.error('deposit', hash.slice(0, 12), e.message); break; } // stop here, retry next round
    }
    if (allOk && maxLt > depLastLt) depLastLt = maxLt;
    if (depSeen.size > 5000) { let i = 0; for (const h of depSeen) { depSeen.delete(h); if (++i > 2500) break; } }
  } catch (e) { console.error('deposit poll', e.message); } finally { depBusy = false; }
}
async function depLoop() {
  await pollDeposits();
  setTimeout(depLoop, Date.now() < depWatchUntil ? 4000 : 15000);
}

/* player-facing deposit endpoint: info + recent deposits + live balance */
app.get('/api/deposit', wrap(async (req, res) => {
  const uid = req.u.id;
  if (req.query.watch) { // user is staring at the deposit screen → poll fast, and kick a poll now
    depWatchUntil = Date.now() + 3 * 60 * 1000;
    if (Date.now() - depLastRun > 3500) pollDeposits();
  }
  let recent = [];
  const r1 = await sb.from('deposits').select('id,amount_nano,status,created_at,tx_hash').eq('telegram_id', uid).order('id', { ascending: false }).limit(6);
  if (!r1.error) recent = r1.data || [];
  else {
    const r2 = await sb.from('ledger').select('id,amount_nano,created_at,ref').eq('telegram_id', uid).eq('type', 'deposit').order('id', { ascending: false }).limit(6);
    recent = (r2.data || []).map(x => ({ id: x.id, amount_nano: x.amount_nano, status: 'credited', created_at: x.created_at, tx_hash: x.ref }));
  }
  const { data: p } = await sb.from('players').select('balance_nano').eq('telegram_id', uid).single();
  res.json({
    address: walletAddr, comment: 'G' + uid, min_nano: await depMin(),
    balance: p ? p.balance_nano : 0, recent, ready: !!walletAddr
  });
}));

async function initWallet() {
  if (!E.WALLET_MNEMONIC) return console.warn('WALLET_MNEMONIC missing: payments disabled');
  key = await mnemonicToPrivateKey(E.WALLET_MNEMONIC.trim().split(/\s+/));
  wallet = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey });
  client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC', apiKey: E.TON_API_KEY });
  contract = client.open(wallet);
  walletAddr = wallet.address.toString({ bounceable: false });
  console.log('Payment wallet:', walletAddr);
  if (E.PAY_ADDRESS && Address.parse(E.PAY_ADDRESS).toRawString() !== wallet.address.toRawString())
    console.warn('WARNING: PAY_ADDRESS does not match the wallet derived from the mnemonic!');
  setTimeout(depLoop, 3000);
  setInterval(processWithdrawals, 12000);
  setTimeout(processWithdrawals, 5000);
}
let wdBusy = false;
async function processWithdrawals() {
  if (wdBusy || !client) return; wdBusy = true;
  try {
    const { data } = await sb.from('withdrawals').select('*').eq('status', 'pending').order('id').limit(5);
    for (const w of data || []) {
      const { data: c } = await sb.from('withdrawals').update({ status: 'processing' }).eq('id', w.id).eq('status', 'pending').select();
      if (!c || !c.length) continue;
      let broadcast = false;
      try {
        const send = BigInt(w.amount_nano - w.fee_nano);
        if (send <= 0n) throw new Error('amount <= fee');
        // minimal gas reserve so small hot-wallet balances can still pay
        const gasReserve = 1000000n; // 0.001 TON
        const bal = await client.getBalance(wallet.address);
        if (bal < send + gasReserve) {
          throw new Error('hot wallet low (' + (Number(bal) / 1e9).toFixed(4) + ' TON)');
        }
        const seqno = await contract.getSeqno();
        broadcast = true;
        await contract.sendTransfer({
          secretKey: key.secretKey,
          seqno,
          sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
          messages: [internal({
            to: Address.parse(w.address),
            value: send,
            bounce: false,
            body: 'Game withdrawal #' + w.id
          })]
        });
        let ok = false;
        for (let i = 0; i < 16 && !ok; i++) {
          await sleep(4000);
          ok = (await contract.getSeqno()) > seqno;
        }
        if (!ok) throw new Error('not confirmed, check wallet manually');
        await sb.from('withdrawals').update({ status: 'sent', processed_at: new Date().toISOString(), error: null }).eq('id', w.id);
        const amountTon = (Number(w.amount_nano - w.fee_nano) / 1e9).toFixed(4);
        const feeTon = (Number(w.fee_nano) / 1e9).toFixed(4);
        try {
          await tg('sendMessage', {
            chat_id: w.telegram_id,
            text: `✅ Withdrawal successful!\n\n💰 Amount: ${amountTon} TON\n🧾 Fee: ${feeTon} TON\n📬 To: \`${w.address}\`\n🆔 ID: #${w.id}`,
            parse_mode: 'Markdown'
          });
        } catch (notifyErr) { console.error('notify success', w.id, notifyErr.message); }
      } catch (e) {
        console.error('withdraw', w.id, e.message);
        if (!broadcast) {
          // not sent yet — put back to pending so it retries (e.g. hot wallet low)
          await sb.from('withdrawals').update({ status: 'pending', error: e.message }).eq('id', w.id);
          // if hot wallet low, stop queue so we don't burn through all pending
          if (/hot wallet low/i.test(e.message)) break;
          continue;
        }
        await sb.from('withdrawals').update({ status: 'failed', error: e.message, processed_at: new Date().toISOString() }).eq('id', w.id);
        try {
          await tg('sendMessage', {
            chat_id: w.telegram_id,
            text: `❌ Withdrawal failed\n\n🆔 ID: #${w.id}\nReason: ${e.message}\n\nYour balance has been restored. Please try again later or contact support.`
          });
        } catch (notifyErr) { console.error('notify fail', w.id, notifyErr.message); }
      }
    }
  } catch (e) { console.error('wd loop', e.message); } finally { wdBusy = false; }
}

const PORT = E.PORT || 3000;
app.listen(PORT, async () => {
  console.log('Listening on', PORT);
  await initWallet().catch(e => console.error('wallet init', e));
  if (BASE) console.log('webhook', (await tg('setWebhook', { url: BASE + '/tg/' + tgSecret })).description);
});
