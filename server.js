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
    if (n > 0) { const { error } = await sb.rpc('award_kills', { p_tid: uid, p_session: sid, p_kills: n }); if (error) throw error; }
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
const KEYS = ['reward_per_kill_nano', 'min_withdraw_nano', 'withdraw_fee_nano', 'daily_withdraw_cap_nano', 'max_kills_per_minute'];
app.get('/api/admin/overview', wrap(async (req, res) => {
  const [{ data: skins }, { data: wd }, { count }, { data: weapons }] = await Promise.all([
    sb.from('skins').select('*').order('weapon').order('sort'),
    sb.from('withdrawals').select('*').order('id', { ascending: false }).limit(40),
    sb.from('players').select('*', { count: 'exact', head: true }),
    sb.from('weapons').select('*').order('sort')
  ]);
  const s = await settings(); const cfg = {}; KEYS.forEach(k => cfg[k] = s[k]);
  let hot = null; try { if (client) hot = String(await client.getBalance(wallet.address)); } catch { }
  res.json({ cfg, skins, weapons, withdrawals: wd, players: count, hot, address: walletAddr });
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
  setInterval(pollDeposits, 20000); setInterval(processWithdrawals, 15000);
}
let depBusy = false;
async function pollDeposits() {
  if (depBusy) return; depBusy = true;
  try {
    const txs = await client.getTransactions(wallet.address, { limit: 40 });
    for (const tx of txs.reverse()) {
      const m = tx.inMessage; if (!m || m.info.type !== 'internal' || !m.info.src) continue;
      let c = ''; try { const s = m.body.beginParse(); if (s.remainingBits >= 32 && s.loadUint(32) === 0) c = s.loadStringTail(); } catch { }
      const mt = /^G(\d{3,15})$/.exec(c.trim()); if (!mt) continue;
      await sb.rpc('credit_deposit', { p_tid: Number(mt[1]), p_amount: Number(m.info.value.coins), p_hash: tx.hash().toString('hex'), p_comment: c.trim() });
    }
  } catch (e) { console.error('deposit poll', e.message); } finally { depBusy = false; }
}
let wdBusy = false;
async function processWithdrawals() {
  if (wdBusy) return; wdBusy = true;
  try {
    const { data } = await sb.from('withdrawals').select('*').eq('status', 'pending').order('id').limit(5);
    for (const w of data || []) {
      const { data: c } = await sb.from('withdrawals').update({ status: 'processing' }).eq('id', w.id).eq('status', 'pending').select();
      if (!c || !c.length) continue;
      let broadcast = false;
      try {
        const send = BigInt(w.amount_nano - w.fee_nano); if (send <= 0n) throw new Error('amount <= fee');
        if ((await client.getBalance(wallet.address)) < send + 60000000n) throw new Error('hot wallet low');
        const seqno = await contract.getSeqno(); broadcast = true;
        await contract.sendTransfer({ secretKey: key.secretKey, seqno, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
          messages: [internal({ to: Address.parse(w.address), value: send, bounce: false, body: 'Game withdrawal #' + w.id })] });
        let ok = false;
        for (let i = 0; i < 14 && !ok; i++) { await sleep(5000); ok = (await contract.getSeqno()) > seqno; }
        if (!ok) throw new Error('not confirmed, check wallet manually');
        await sb.from('withdrawals').update({ status: 'sent', processed_at: new Date().toISOString() }).eq('id', w.id);
      } catch (e) {
        console.error('withdraw', w.id, e.message);
        if (!broadcast) { await sb.from('withdrawals').update({ status: 'pending', error: e.message }).eq('id', w.id); break; }
        await sb.from('withdrawals').update({ status: 'failed', error: e.message, processed_at: new Date().toISOString() }).eq('id', w.id);
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
