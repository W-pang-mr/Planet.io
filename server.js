<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>TON Wallet</title>
<style>
:root {
  --bg: #f0f4f8;
  --card: #ffffff;
  --primary: #2481cc;
  --primary2: #3390ec;
  --text: #1a1a1a;
  --muted: #6b7280;
  --green: #22c55e;
  --red: #ef4444;
  --grad: linear-gradient(135deg, #1e5cbe 0%, #3b9eff 100%);
  --shadow: 0 10px 40px rgba(30, 92, 190, 0.25);
  --radius: 24px;
}

* {
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
  margin: 0;
  padding: 0;
}

html, body {
  height: 100%;
  overflow-x: hidden;
}

body {
  background: var(--bg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--text);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

/* ========== LOADING SCREEN ========== */
#loading {
  position: fixed;
  inset: 0;
  background: linear-gradient(160deg, #1e5cbe, #3b9eff);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 9999;
  color: white;
  transition: opacity 0.5s ease, visibility 0.5s;
}

#loading.hide {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
}

.loader-diamond {
  font-size: 64px;
  animation: pulse 1.4s ease-in-out infinite;
  margin-bottom: 24px;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.7; }
}

.loader-text {
  font-size: 18px;
  font-weight: 500;
  opacity: 0.9;
}

.loader-bar {
  width: 180px;
  height: 4px;
  background: rgba(255,255,255,0.25);
  border-radius: 4px;
  margin-top: 28px;
  overflow: hidden;
}

.loader-bar-inner {
  height: 100%;
  width: 30%;
  background: white;
  border-radius: 4px;
  animation: loadingBar 1.2s ease-in-out infinite;
}

@keyframes loadingBar {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(400%); }
}

/* ========== APP CONTAINER ========== */
.app {
  max-width: 480px;
  margin: 0 auto;
  min-height: 100vh;
  padding: 0 16px 40px;
  position: relative;
}

/* ========== TOP BAR ========== */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
  padding-top: env(safe-area-inset-top);
}

.topbar h1 {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.5px;
}

.icon-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: transparent;
  font-size: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  transition: background 0.2s, transform 0.15s;
}

.icon-btn:active {
  background: rgba(0,0,0,0.06);
  transform: scale(0.92);
}

/* ========== WALLET CARD ========== */
.wallet-card {
  position: relative;
  height: 210px;
  border-radius: 28px;
  background: var(--grad);
  color: white;
  padding: 28px 24px;
  overflow: hidden;
  box-shadow: var(--shadow);
  margin-bottom: 20px;
  animation: cardEnter 0.6s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes cardEnter {
  from {
    opacity: 0;
    transform: translateY(30px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.wallet-card::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 15% 20%, rgba(255,255,255,0.4), transparent 50%),
    repeating-radial-gradient(circle at 80% 70%, rgba(255,255,255,0.08) 0 3px, transparent 3px 12px);
  pointer-events: none;
}

.wallet-card::after {
  content: "";
  position: absolute;
  top: -60%;
  left: -80%;
  width: 50%;
  height: 220%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
  transform: rotate(25deg);
  animation: shine 6s ease-in-out infinite;
}

@keyframes shine {
  0%, 70% { left: -80%; }
  100% { left: 140%; }
}

.balance-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
  position: relative;
  z-index: 2;
}

.balance-row svg {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
}

.balance-amount {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1;
}

.balance-unit {
  font-size: 28px;
  font-weight: 600;
  opacity: 0.85;
  margin-left: 6px;
}

.usd-value {
  margin-top: 8px;
  font-size: 20px;
  font-weight: 500;
  opacity: 0.9;
  position: relative;
  z-index: 2;
}

.wallet-handle {
  position: absolute;
  bottom: 22px;
  left: 24px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 14px;
  font-weight: 600;
  opacity: 0.9;
  z-index: 2;
}

.address-vertical {
  position: absolute;
  right: 12px;
  top: 18px;
  bottom: 18px;
  writing-mode: vertical-rl;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  opacity: 0.7;
  letter-spacing: 0.5px;
  z-index: 2;
  word-break: break-all;
  line-height: 1.3;
}

.qr-btn {
  position: absolute;
  right: 52px;
  top: 50%;
  transform: translateY(-50%);
  width: 58px;
  height: 52px;
  border-radius: 16px;
  background: rgba(255,255,255,0.9);
  border: none;
  font-size: 24px;
  color: #1e5cbe;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3;
  transition: transform 0.2s, background 0.2s;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.qr-btn:active {
  transform: translateY(-50%) scale(0.9);
}

/* ========== ACTION BUTTONS ========== */
.actions {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}

.action-btn {
  flex: 1;
  height: 56px;
  border-radius: 28px;
  border: none;
  background: var(--grad);
  color: white;
  font-size: 17px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-shadow: 0 8px 20px rgba(36, 129, 204, 0.35);
  transition: transform 0.15s, box-shadow 0.2s;
  animation: btnEnter 0.5s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.action-btn:nth-child(1) { animation-delay: 0.1s; }
.action-btn:nth-child(2) { animation-delay: 0.18s; }

@keyframes btnEnter {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.action-btn:active {
  transform: scale(0.96);
  box-shadow: 0 4px 12px rgba(36, 129, 204, 0.3);
}

.action-btn.ghost {
  background: #e8f1fb;
  color: var(--primary);
  box-shadow: none;
}

/* ========== TRANSACTIONS ========== */
.tx-section {
  background: var(--card);
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0,0,0,0.04);
  animation: fadeUp 0.5s 0.25s both;
}

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.tx-header {
  padding: 18px 20px 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--muted);
}

.tx-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 20px;
  border-bottom: 1px solid #f1f5f9;
  transition: background 0.15s;
  animation: txSlide 0.4s both;
}

.tx-item:last-child {
  border-bottom: none;
}

.tx-item:active {
  background: #f8fafc;
}

@keyframes txSlide {
  from {
    opacity: 0;
    transform: translateX(-16px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.tx-avatar {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--grad);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
}

.tx-avatar.in {
  background: linear-gradient(135deg, #22c55e, #4ade80);
}

.tx-info {
  flex: 1;
  min-width: 0;
}

.tx-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 2px;
}

.tx-subtitle {
  font-size: 13px;
  color: var(--muted);
}

.tx-amount {
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
}

.tx-amount.in {
  color: var(--green);
}

.empty-state {
  padding: 48px 24px;
  text-align: center;
  color: var(--muted);
  font-size: 15px;
}

/* ========== BOTTOM SHEETS ========== */
.sheet-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  z-index: 100;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.3s, visibility 0.3s;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.sheet-overlay.show {
  opacity: 1;
  visibility: visible;
}

.sheet {
  background: white;
  width: 100%;
  max-width: 480px;
  border-radius: 28px 28px 0 0;
  padding: 24px 20px calc(28px + env(safe-area-inset-bottom));
  transform: translateY(100%);
  transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}

.sheet-overlay.show .sheet {
  transform: translateY(0);
}

.sheet h2 {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 8px;
}

.sheet p {
  color: var(--muted);
  font-size: 15px;
  margin-bottom: 16px;
}

.address-box {
  background: #f1f5f9;
  border-radius: 16px;
  padding: 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 14px;
  word-break: break-all;
  text-align: center;
  margin-bottom: 16px;
  line-height: 1.5;
}

.full-btn {
  width: 100%;
  height: 54px;
  border-radius: 27px;
  border: none;
  background: var(--grad);
  color: white;
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 10px;
  transition: transform 0.15s;
}

.full-btn:active {
  transform: scale(0.97);
}

.full-btn.ghost {
  background: #e8f1fb;
  color: var(--primary);
}

/* ========== MENU ========== */
.menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: none;
}

.menu-overlay.show {
  display: block;
}

.menu {
  position: absolute;
  top: 70px;
  right: 16px;
  width: 260px;
  background: white;
  border-radius: 20px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.15);
  overflow: hidden;
  opacity: 0;
  transform: scale(0.9);
  transform-origin: top right;
  transition: opacity 0.2s, transform 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}

.menu-overlay.show .menu {
  opacity: 1;
  transform: scale(1);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  font-size: 16px;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
  color: var(--text);
  transition: background 0.15s;
}

.menu-item:active {
  background: #f1f5f9;
}

.menu-item small {
  display: block;
  font-size: 12px;
  color: var(--green);
  margin-top: 2px;
}

/* ========== SEND PAGE ========== */
.send-page {
  position: fixed;
  inset: 0;
  background: var(--bg);
  z-index: 80;
  transform: translateX(100%);
  transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
  overflow-y: auto;
  padding-bottom: 120px;
}

.send-page.show {
  transform: translateX(0);
}

.send-header {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 60px;
  padding: 0 16px;
  font-size: 20px;
  font-weight: 700;
  background: white;
  position: sticky;
  top: 0;
  z-index: 10;
  border-bottom: 1px solid #f1f5f9;
}

.recipient-card {
  background: white;
  border-radius: 20px;
  padding: 16px;
  margin: 16px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.04);
}

.recipient-info {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.recipient-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--grad);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 16px;
}

.recipient-name {
  font-weight: 600;
  font-size: 16px;
}

.recipient-addr {
  font-size: 13px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.input-field {
  width: 100%;
  border: 1.5px solid #e2e8f0;
  border-radius: 14px;
  padding: 14px 16px;
  font-size: 16px;
  background: #f8fafc;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  font-family: inherit;
}

.input-field:focus {
  border-color: var(--primary2);
  box-shadow: 0 0 0 3px rgba(51, 144, 236, 0.15);
}

.amount-display {
  text-align: center;
  margin: 32px 0 8px;
  font-size: 52px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.amount-display small {
  font-size: 24px;
  color: var(--muted);
  font-weight: 600;
}

.usd-convert {
  text-align: center;
  color: var(--muted);
  font-size: 17px;
  margin-bottom: 8px;
}

.balance-hint {
  text-align: center;
  color: var(--muted);
  font-size: 14px;
  margin: 6px 0;
}

.warn-text {
  text-align: center;
  color: var(--red);
  font-size: 14px;
  font-weight: 600;
  height: 0;
  overflow: hidden;
  opacity: 0;
  transition: all 0.25s;
}

.warn-text.show {
  height: 22px;
  opacity: 1;
  margin: 6px 0;
}

/* ========== KEYPAD ========== */
.keypad {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background: white;
  border-radius: 24px 24px 0 0;
  padding: 14px 16px calc(16px + env(safe-area-inset-bottom));
  transform: translateY(110%);
  transition: transform 0.32s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 85;
  box-shadow: 0 -8px 30px rgba(0,0,0,0.08);
}

.keypad.show {
  transform: translateY(0);
}

.keys-grid {
  max-width: 480px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.key {
  height: 56px;
  border-radius: 16px;
  border: none;
  background: #f1f5f9;
  font-size: 26px;
  font-weight: 600;
  color: var(--text);
  transition: transform 0.12s, background 0.12s;
}

.key:active {
  background: #dbeafe;
  transform: scale(0.93);
}

.key.done {
  grid-column: 1 / -1;
  height: 52px;
  font-size: 17px;
  background: var(--grad);
  color: white;
}

/* ========== SETUP / UNLOCK ========== */
.auth-screen {
  max-width: 480px;
  margin: 0 auto;
  padding: 60px 24px 40px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  animation: fadeIn 0.4s ease;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
}

.auth-screen h1 {
  text-align: center;
  font-size: 32px;
  margin-bottom: 8px;
}

.auth-screen p {
  text-align: center;
  color: var(--muted);
  margin-bottom: 32px;
  font-size: 16px;
}

.form-label {
  display: block;
  font-size: 14px;
  color: var(--muted);
  margin-bottom: 8px;
  font-weight: 500;
}

.form-textarea {
  width: 100%;
  min-height: 110px;
  border: 1.5px solid #e2e8f0;
  border-radius: 16px;
  padding: 14px;
  font-size: 16px;
  background: #f8fafc;
  outline: none;
  resize: none;
  font-family: inherit;
  margin-bottom: 16px;
  transition: border-color 0.2s;
}

.form-textarea:focus {
  border-color: var(--primary2);
}

.form-input {
  width: 100%;
  border: 1.5px solid #e2e8f0;
  border-radius: 14px;
  padding: 14px 16px;
  font-size: 16px;
  background: #f8fafc;
  outline: none;
  margin-bottom: 12px;
  transition: border-color 0.2s;
  font-family: inherit;
}

.form-input:focus {
  border-color: var(--primary2);
}

.msg {
  text-align: center;
  font-size: 15px;
  min-height: 22px;
  margin-top: 12px;
}

.msg.err { color: var(--red); }
.msg.ok { color: var(--green); }

.link-btn {
  background: none;
  border: none;
  color: var(--red);
  font-size: 15px;
  margin-top: 24px;
  width: 100%;
  padding: 12px;
}

/* ========== TOAST ========== */
#toast {
  position: fixed;
  left: 50%;
  bottom: 100px;
  transform: translate(-50%, 30px);
  background: rgba(30, 30, 30, 0.92);
  color: white;
  padding: 14px 24px;
  border-radius: 30px;
  font-size: 15px;
  opacity: 0;
  transition: all 0.3s cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 200;
  pointer-events: none;
  max-width: 90%;
  text-align: center;
  box-shadow: 0 8px 24px rgba(0,0,0,0.2);
}

#toast.show {
  opacity: 1;
  transform: translate(-50%, 0);
}

/* ========== UTILS ========== */
.hidden { display: none !important; }

.spin {
  width: 22px;
  height: 22px;
  border: 3px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  display: inline-block;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.pop {
  animation: pop 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes pop {
  from { transform: scale(0.88); opacity: 0.6; }
  to { transform: scale(1); opacity: 1; }
}

.shake {
  animation: shake 0.4s ease;
}

@keyframes shake {
  20%, 60% { transform: translateX(-7px); }
  40%, 80% { transform: translateX(7px); }
}
</style>
</head>
<body>

<!-- LOADING -->
<div id="loading">
  <div class="loader-diamond">💎</div>
  <div class="loader-text">Loading Wallet…</div>
  <div class="loader-bar"><div class="loader-bar-inner"></div></div>
</div>

<!-- TOAST -->
<div id="toast"></div>

<!-- SETUP -->
<div id="setup" class="auth-screen hidden">
  <h1>💎 Import Wallet</h1>
  <p>Enter your 12 or 24 secret recovery words</p>
  <label class="form-label">Secret words</label>
  <textarea id="words" class="form-textarea" placeholder="word1 word2 word3 ..." autocapitalize="none" autocomplete="off" spellcheck="false"></textarea>
  <label class="form-label">Passcode (encrypts the words on this device)</label>
  <input id="pass1" type="password" class="form-input" placeholder="Passcode (min 4 characters)">
  <input id="pass2" type="password" class="form-input" placeholder="Repeat passcode">
  <button class="full-btn" id="importBtn" style="margin-top:12px">Import Wallet</button>
  <div id="setupMsg" class="msg"></div>
</div>

<!-- UNLOCK -->
<div id="unlock" class="auth-screen hidden">
  <h1>💎 Wallet</h1>
  <p>Enter your passcode to unlock</p>
  <input id="unlockPass" type="password" class="form-input" placeholder="Passcode">
  <button class="full-btn" id="unlockBtn" style="margin-top:8px">Unlock</button>
  <div id="unlockMsg" class="msg"></div>
  <button class="link-btn" id="forgetBtn">Remove wallet from this device</button>
</div>

<!-- MAIN APP -->
<div id="main" class="app hidden">
  <div class="topbar">
    <h1>Wallet</h1>
    <div style="display:flex;gap:4px">
      <button class="icon-btn" id="refreshBtn">⟳</button>
      <button class="icon-btn" id="menuBtn">⋮</button>
    </div>
  </div>

  <div class="wallet-card">
    <div class="balance-row">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M6 3h12l4 6-10 12L2 9z" fill="#bfe3ff"/>
        <path d="M2 9h20M9 3l3 6 3-6M12 21 9 9m3 12 3-12" stroke="#fff" stroke-width="1.2"/>
      </svg>
      <div>
        <span class="balance-amount" id="balN">0</span>
        <span class="balance-unit">TON</span>
      </div>
    </div>
    <div class="usd-value" id="usd">$0.00</div>
    <div class="wallet-handle">@GIFTSDouble</div>
    <button class="qr-btn" id="qrBtn">▣</button>
    <div class="address-vertical" id="cardAddr"></div>
  </div>

  <div class="actions">
    <button class="action-btn" id="addBtn">⊕ Add Funds</button>
    <button class="action-btn" id="sendBtn">➤ Send</button>
  </div>

  <div class="tx-section">
    <div class="tx-header">Recent Activity</div>
    <div id="txList">
      <div class="empty-state">Loading transactions…</div>
    </div>
  </div>
</div>

<!-- MENU -->
<div class="menu-overlay" id="menuBg">
  <div class="menu">
    <button class="menu-item" data-m="cur">💲 Currency</button>
    <button class="menu-item" data-m="lock">🔒 Passcode Lock</button>
    <button class="menu-item" data-m="keys">🔑 Keys & Backup</button>
    <button class="menu-item" data-m="apps">
      <span>🔗 Connected Apps<small>● STON.fi</small></span>
    </button>
    <button class="menu-item" data-m="what">❓ What is Wallet?</button>
  </div>
</div>

<!-- RECEIVE SHEET -->
<div class="sheet-overlay" id="recvBg">
  <div class="sheet">
    <h2>Add Funds</h2>
    <p>Send TON to this address</p>
    <div class="address-box" id="recvAddr"></div>
    <button class="full-btn" id="copyBtn">Copy Address</button>
    <button class="full-btn ghost" id="recvClose">Close</button>
  </div>
</div>

<!-- SEND PAGE -->
<div class="send-page" id="sendPage">
  <div class="send-header">
    <button class="icon-btn" id="backBtn">←</button>
    Send TON
  </div>

  <div class="recipient-card">
    <div class="recipient-info">
      <div class="recipient-avatar" id="rAva">?</div>
      <div>
        <div class="recipient-name" id="rName">Recipient</div>
        <div class="recipient-addr" id="rAddr">Enter address below</div>
      </div>
    </div>
    <input id="toAddr" class="input-field" placeholder="Wallet address (UQ… / EQ…)" autocomplete="off" autocapitalize="none">
    <input id="memo" class="input-field" placeholder="Memo (optional)" style="margin-top:10px">
  </div>

  <div class="amount-display" id="amtBox">
    <svg width="40" height="40" viewBox="0 0 24 24">
      <path d="M6 3h12l4 6-10 12L2 9z" fill="#3390ec"/>
      <path d="M2 9h20M9 3l3 6 3-6" stroke="#fff" stroke-width="1"/>
    </svg>
    <span id="amtV">0</span>
    <small>TON</small>
  </div>

  <div class="usd-convert" id="conv">= $0.00</div>
  <div class="warn-text" id="warn">Insufficient funds</div>
  <div class="balance-hint" id="balInfo">Balance: 0 TON</div>
  <div class="balance-hint">Network fee ≈ 0.005 TON</div>

  <div style="padding: 0 16px; margin-top: 24px;">
    <button class="full-btn" id="goBtn" disabled>Continue</button>
  </div>
</div>

<!-- KEYPAD -->
<div class="keypad" id="kp">
  <div class="keys-grid" id="keys"></div>
</div>

<script>
(function () {
  "use strict";

  // ===================== CONFIG =====================
  const API = "https://toncenter.com/api/v2";
  const API_KEY = "e08b96c939bcca03c136cbc8e48e0f49d4b622013cf97b7fa00f8ad553ff9910";
  const KEY = "ton_wallet_enc_v1";
  const CHOICE = "ton_wallet_choice_v1";
  const FEE = "0.01";

  // ===================== STATE =====================
  let words = null;
  let wallet = null;
  let kp0 = null;
  let address = "";
  let balNano = 0n;
  let client = null;
  let TON = null;
  let CR = null;
  let price = 0;
  let amt = "0";
  let wasBad = false;

  // ===================== HELPERS =====================
  const $ = (id) => document.getElementById(id);

  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function shortAddr(a) {
    if (!a || a.length < 12) return a || "";
    return a.slice(0, 4) + "…" + a.slice(-4);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function buzz() {
    try { navigator.vibrate && navigator.vibrate(10); } catch (e) {}
  }

  // ===================== LIBRARY LOADER =====================
  const TON_URLS = [
    "https://esm.sh/@ton/ton@15",
    "https://esm.sh/@ton/ton@15.2.0",
    "https://cdn.jsdelivr.net/npm/@ton/ton@15/+esm",
    "https://fastly.jsdelivr.net/npm/@ton/ton@15/+esm"
  ];

  const CRYPTO_URLS = [
    "https://esm.sh/@ton/crypto@3",
    "https://esm.sh/@ton/crypto@3.3.0",
    "https://cdn.jsdelivr.net/npm/@ton/crypto@3/+esm",
    "https://fastly.jsdelivr.net/npm/@ton/crypto@3/+esm"
  ];

  async function tryImport(urls, check) {
    for (const url of urls) {
      try {
        const mod = await import(url);
        if (check(mod)) return mod;
      } catch (e) {}
    }
    return null;
  }

  async function loadLibraries() {
    try {
      if (!window.Buffer) {
        const buf = await import("https://esm.sh/buffer@6.0.3");
        window.Buffer = buf.Buffer || (buf.default && buf.default.Buffer);
      }
    } catch (e) {}

    TON = await tryImport(TON_URLS, m => m.WalletContractV5R1 && m.WalletContractV4 && m.TonClient);
    if (!TON) throw new Error("Could not load TON library. Check your connection / VPN.");

    CR = await tryImport(CRYPTO_URLS, m => m.mnemonicToPrivateKey && m.keyPairFromSeed);
    if (!CR) throw new Error("Could not load crypto library.");

    client = new TON.TonClient({
      endpoint: API + "/jsonRPC",
      apiKey: API_KEY
    });
  }

  // ===================== ENCRYPTION =====================
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toB64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }

  function fromB64(s) {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  async function deriveKey(pass, salt) {
    const material = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encrypt(text, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text)));
    return JSON.stringify({ s: toB64(salt), i: toB64(iv), c: toB64(cipher) });
  }

  async function decrypt(blob, pass) {
    const obj = JSON.parse(blob);
    const key = await deriveKey(pass, fromB64(obj.s));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(obj.i) }, key, fromB64(obj.c));
    return dec.decode(plain);
  }

  // ===================== KEY DERIVATION =====================
  function toBuf(u8) {
    return window.Buffer ? window.Buffer.from(u8) : u8;
  }

  async function hmac(key, data) {
    const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
  }

  async function bip39KeyPair(wordsArr) {
    const material = await crypto.subtle.importKey(
      "raw",
      enc.encode(wordsArr.join(" ").normalize("NFKD")),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const seed = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: enc.encode("mnemonic"), iterations: 2048, hash: "SHA-512" },
      material,
      512
    ));
    let I = await hmac(enc.encode("ed25519 seed"), seed);
    let k = I.slice(0, 32);
    let c = I.slice(32);
    const path = [44, 607, 0];
    for (let i = 0; i < 3; i++) {
      const idx = (path[i] | 0x80000000) >>> 0;
      const data = new Uint8Array(37);
      data.set(k, 1);
      data[33] = (idx >>> 24) & 255;
      data[34] = (idx >>> 16) & 255;
      data[35] = (idx >>> 8) & 255;
      data[36] = idx & 255;
      I = await hmac(c, data);
      k = I.slice(0, 32);
      c = I.slice(32);
    }
    return CR.keyPairFromSeed(toBuf(k));
  }

  const CANDIDATES = [
    { id: "ton-v5", d: "ton", v: "V5R1" },
    { id: "bip-v5", d: "bip", v: "V5R1" },
    { id: "ton-v4", d: "ton", v: "V4R2" },
    { id: "bip-v4", d: "bip", v: "V4R2" }
  ];

  async function buildWallet(cand, wordsArr) {
    const kp = cand.d === "ton"
      ? await CR.mnemonicToPrivateKey(wordsArr)
      : await bip39KeyPair(wordsArr);

    const w = cand.v === "V5R1"
      ? TON.WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey })
      : TON.WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });

    return {
      id: cand.id,
      kp,
      wallet: w,
      addr: w.address.toString({ bounceable: false, urlSafe: true }),
      label: cand.v + " / " + (cand.d === "ton" ? "TON-standard" : "BIP39")
    };
  }

  // ===================== API =====================
  async function api(path) {
    const url = API + path + (path.includes("?") ? "&" : "?") + "api_key=" + API_KEY;
    const res = await fetch(url);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error("HTTP " + res.status);
    }
    if (!json.ok) throw new Error(json.error || "API error");
    return json.result;
  }

  // ===================== WALLET LOAD =====================
  async function loadWallet(wordsArr) {
    words = wordsArr;
    let chosen = null;
    const saved = localStorage.getItem(CHOICE);

    if (saved) {
      const found = CANDIDATES.find(c => c.id === saved);
      if (found) chosen = await buildWallet(found, words);
    }

    if (!chosen) {
      for (const cand of CANDIDATES) {
        const built = await buildWallet(cand, words);
        try {
          const info = await api("/getAddressInformation?address=" + built.addr);
          const bal = BigInt(info.balance || "0");
          if (info.state !== "uninitialized" || bal > 0n) {
            chosen = built;
            localStorage.setItem(CHOICE, built.id);
            break;
          }
        } catch (e) {}
        await sleep(250);
      }
      if (!chosen) {
        // fallback to first candidate (no red error shown)
        chosen = await buildWallet(CANDIDATES[0], words);
      }
    }

    kp0 = chosen.kp;
    wallet = chosen.wallet;
    address = chosen.addr;

    $("cardAddr").textContent = address;
    $("recvAddr").textContent = address;

    showScreen("main");
    refresh();
  }

  // ===================== REFRESH =====================
  async function refresh() {
    const btn = $("refreshBtn");
    btn.style.opacity = "0.4";

    try {
      balNano = BigInt(await api("/getAddressBalance?address=" + address));
      const ton = TON.fromNano(balNano);
      $("balN").textContent = parseFloat(ton).toString();

      // price
      fetch("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd")
        .then(r => r.json())
        .then(p => {
          price = p["the-open-network"]?.usd || 0;
          \( ("usd").textContent = " \)" + (parseFloat(ton) * price).toFixed(2);
          updateAmountUI();
        })
        .catch(() => {});
    } catch (e) {}

    await sleep(300);

    try {
      const txs = await api("/getTransactions?address=" + address + "&limit=25");
      renderTransactions(txs);
    } catch (e) {
      $("txList").innerHTML = '<div class="empty-state">Could not load transactions</div>';
    }

    btn.style.opacity = "1";
  }

  function formatTime(utime) {
    return new Date(utime * 1000).toLocaleString("en", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function renderTransactions(list) {
    const items = [];
    list.forEach(tx => {
      if (tx.in_msg && tx.in_msg.source) {
        items.push({
          dir: "in",
          addr: tx.in_msg.source,
          value: tx.in_msg.value,
          memo: tx.in_msg.message,
          time: tx.utime
        });
      }
      (tx.out_msgs || []).forEach(o => {
        if (o.destination) {
          items.push({
            dir: "out",
            addr: o.destination,
            value: o.value,
            memo: o.message,
            time: tx.utime
          });
        }
      });
    });

    if (!items.length) {
      $("txList").innerHTML = '<div class="empty-state">No transactions yet</div>';
      return;
    }

    $("txList").innerHTML = items.map((x, i) => {
      const isIn = x.dir === "in";
      return `
        <div class="tx-item" style="animation-delay:${i * 0.04}s">
          <div class="tx-avatar \( {isIn ? "in" : ""}"> \){isIn ? "↓" : "↑"}</div>
          <div class="tx-info">
            <div class="tx-title">${esc(shortAddr(x.addr))}</div>
            <div class="tx-subtitle">${isIn ? "Incoming" : "Outgoing"} · \( {formatTime(x.time)} \){x.memo ? " · " + esc(x.memo) : ""}</div>
          </div>
          <div class="tx-amount \( {isIn ? "in" : ""}"> \){isIn ? "+" : "−"}${parseFloat(TON.fromNano(BigInt(x.value)))} 💎</div>
        </div>`;
    }).join("");
  }

  // ===================== UI SCREENS =====================
  function showScreen(name) {
    ["setup", "unlock", "main"].forEach(id => {
      $(id).classList.toggle("hidden", id !== name);
    });
  }

  function setMsg(id, text, ok) {
    const el = $(id);
    el.textContent = text;
    el.className = "msg " + (ok ? "ok" : "err");
  }

  // ===================== MENU =====================
  $("menuBtn").onclick = () => $("menuBg").classList.add("show");
  $("menuBg").onclick = (e) => {
    if (e.target.id === "menuBg") $("menuBg").classList.remove("show");
  };

  document.querySelectorAll("[data-m]").forEach(btn => {
    btn.onclick = () => {
      $("menuBg").classList.remove("show");
      const m = btn.dataset.m;
      if (m === "lock") {
        words = null; wallet = null; kp0 = null;
        showScreen("unlock");
      } else if (m === "keys") {
        toast("Your words are stored encrypted on this device only");
      } else if (m === "cur") {
        toast("Currency: USD");
      } else if (m === "apps") {
        toast("STON.fi is connected");
      } else {
        toast("Non-custodial TON wallet — only you hold the keys");
      }
    };
  });

  // ===================== RECEIVE =====================
  $("addBtn").onclick = $("qrBtn").onclick = () => $("recvBg").classList.add("show");
  $("recvClose").onclick = () => $("recvBg").classList.remove("show");
  $("recvBg").onclick = (e) => {
    if (e.target.id === "recvBg") $("recvBg").classList.remove("show");
  };

  $("copyBtn").onclick = async () => {
    try {
      await navigator.clipboard.writeText(address);
      toast("Address copied");
    } catch (e) {
      prompt("Copy this address:", address);
    }
  };

  $("refreshBtn").onclick = refresh;

  // ===================== SEND FLOW =====================
  const keyLabels = ["1","2","3","4","5","6","7","8","9",".","0","⌫"];
  $("keys").innerHTML = keyLabels.map(k =>
    `<button class="key" data-k="\( {k}"> \){k}</button>`
  ).join("") + `<button class="key done" id="doneBtn">Done</button>`;

  function showKeypad(show) {
    $("kp").classList.toggle("show", show);
  }

  function openSend() {
    amt = "0";
    wasBad = false;
    $("toAddr").value = "";
    $("memo").value = "";
    updateRecipient();
    updateAmountUI();
    $("balInfo").textContent = "Balance: " + parseFloat(TON.fromNano(balNano)) + " TON";
    $("sendPage").classList.add("show");
    setTimeout(() => showKeypad(true), 280);
  }

  function closeSend() {
    showKeypad(false);
    $("sendPage").classList.remove("show");
  }

  $("sendBtn").onclick = openSend;
  $("backBtn").onclick = closeSend;
  $("doneBtn").onclick = () => showKeypad(false);
  $("amtBox").onclick = () => showKeypad(true);
  $("toAddr").onfocus = () => showKeypad(false);
  $("memo").onfocus = () => showKeypad(false);

  function updateRecipient() {
    const a = $("toAddr").value.trim();
    let ok = false;
    try {
      TON.Address.parseFriendly(a);
      ok = true;
    } catch (e) {
      try {
        TON.Address.parse(a);
        ok = true;
      } catch (e2) {}
    }
    $("rAva").textContent = ok ? a.slice(0, 2).toUpperCase() : "?";
    $("rName").textContent = ok ? "Recipient" : "Recipient";
    $("rAddr").textContent = ok ? shortAddr(a) : "Enter address below";
    return ok;
  }

  $("toAddr").oninput = () => {
    updateRecipient();
    updateAmountUI();
  };

  function amtNano() {
    try {
      return TON.toNano(amt.replace(/\.$/, "") || "0");
    } catch (e) {
      return 0n;
    }
  }

  function updateAmountUI() {
    const v = $("amtV");
    v.textContent = amt;
    v.classList.remove("pop");
    void v.offsetWidth;
    v.classList.add("pop");

    const n = parseFloat(amt) || 0;
    $("conv").textContent = "= $" + (n * price).toFixed(2);

    const nano = amtNano();
    const bad = nano > 0n && nano + TON.toNano(FEE) > balNano;
    $("warn").classList.toggle("show", bad);

    if (bad && !wasBad) {
      const box = $("amtBox");
      box.classList.remove("shake");
      void box.offsetWidth;
      box.classList.add("shake");
      buzz();
    }
    wasBad = bad;

    const go = $("goBtn");
    const ok = nano > 0n && !bad && updateRecipient();
    go.disabled = !ok;
    go.textContent = n > 0 ? "Send " + amt.replace(/\.$/, "") + " TON" : "Continue";
  }

  $("keys").onclick = (e) => {
    const btn = e.target.closest(".key");
    if (!btn || btn.id === "doneBtn") return;
    buzz();
    const k = btn.dataset.k;
    if (k === "⌫") {
      amt = amt.length > 1 ? amt.slice(0, -1) : "0";
    } else if (k === ".") {
      if (!amt.includes(".")) amt += ".";
    } else {
      if (amt === "0") amt = k;
      else if (amt.length < 14 && !(amt.includes(".") && amt.split(".")[1].length >= 9)) {
        amt += k;
      }
    }
    updateAmountUI();
  };

  $("goBtn").onclick = async () => {
    const go = $("goBtn");
    const to = $("toAddr").value.trim();
    const memo = $("memo").value.trim();
    let dest, bounce = false;

    try {
      try {
        const p = TON.Address.parseFriendly(to);
        dest = p.address;
        bounce = p.isBounceable;
      } catch (e) {
        dest = TON.Address.parse(to);
      }
    } catch (e) {
      return toast("Invalid address");
    }

    go.disabled = true;
    go.innerHTML = '<span class="spin"></span>';
    showKeypad(false);

    try {
      const opened = client.open(wallet);
      const seqno = await opened.getSeqno();
      await opened.sendTransfer({
        seqno,
        secretKey: kp0.secretKey,
        sendMode: TON.SendMode.PAY_GAS_SEPARATELY + TON.SendMode.IGNORE_ERRORS,
        messages: [
          TON.internal({
            to: dest,
            value: amtNano(),
            bounce,
            body: memo || undefined
          })
        ]
      });
      toast("✅ Sent! It will appear in a few seconds");
      closeSend();
      setTimeout(refresh, 3000);
      setTimeout(refresh, 10000);
    } catch (e) {
      toast("Error: " + (e.message || e));
      go.disabled = false;
      updateAmountUI();
    }
  };

  // ===================== IMPORT / UNLOCK =====================
  $("importBtn").onclick = async () => {
    const w = $("words").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const p1 = $("pass1").value;
    const p2 = $("pass2").value;

    if (w.length !== 12 && w.length !== 24) {
      return setMsg("setupMsg", "Enter exactly 12 or 24 words", false);
    }
    if (p1.length < 4) {
      return setMsg("setupMsg", "Passcode must be at least 4 characters", false);
    }
    if (p1 !== p2) {
      return setMsg("setupMsg", "Passcodes don't match", false);
    }

    setMsg("setupMsg", "Please wait…", true);
    try {
      await loadLibraries();
      localStorage.removeItem(CHOICE);
      localStorage.setItem(KEY, await encrypt(w.join(" "), p1));
      $("words").value = "";
      $("pass1").value = "";
      $("pass2").value = "";
      await loadWallet(w);
    } catch (e) {
      setMsg("setupMsg", "Error: " + (e.message || e), false);
    }
  };

  $("unlockBtn").onclick = async () => {
    setMsg("unlockMsg", "Please wait…", true);
    try {
      const plain = await decrypt(localStorage.getItem(KEY), $("unlockPass").value);
      $("unlockPass").value = "";
      $("unlockMsg").textContent = "";
      await loadLibraries();
      await loadWallet(plain.split(" "));
    } catch (e) {
      setMsg("unlockMsg", "Wrong passcode", false);
    }
  };

  $("unlockPass").addEventListener("keydown", e => {
    if (e.key === "Enter") $("unlockBtn").click();
  });

  $("forgetBtn").onclick = () => {
    if (confirm("Remove this wallet from this device?\nMake sure you have saved your secret words!")) {
      localStorage.removeItem(KEY);
      localStorage.removeItem(CHOICE);
      location.reload();
    }
  };

  // ===================== START =====================
  async function boot() {
    try {
      await loadLibraries();
      $("loading").classList.add("hide");

      if (localStorage.getItem(KEY)) {
        showScreen("unlock");
      } else {
        showScreen("setup");
      }
    } catch (e) {
      $("loading").innerHTML = `
        <div style="text-align:center;padding:40px;color:white">
          <div style="font-size:48px;margin-bottom:16px">⚠️</div>
          <div style="font-size:18px;margin-bottom:12px">Failed to load libraries</div>
          <div style="opacity:0.8;font-size:14px;max-width:280px;margin:0 auto 24px">${esc(e.message)}</div>
          <button onclick="location.reload()" style="background:white;color:#1e5cbe;border:none;padding:12px 28px;border-radius:30px;font-size:16px;font-weight:600">Retry</button>
        </div>`;
    }
  }

  boot();
})();
</script>
</body>
</html>
