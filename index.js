export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 鉴权逻辑
      if (path !== '/login' && !path.startsWith('/api/auth')) {
        const isAuthenticated = await checkAuthentication(request, env);
        if (!isAuthenticated) {
          return new Response(getLoginPageHTML(), {
            status: 302,
            headers: { 'Content-Type': 'text/html', ...corsHeaders },
          });
        }
      }

      if (path === '/') {
        return new Response(getHTML(), {
          headers: { 'Content-Type': 'text/html', ...corsHeaders },
        });
      }

      // API 路由逻辑
      if (path.startsWith('/api/')) {
        const response = await handleAPIRequest(request, env, path, method);
        Object.entries(corsHeaders).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        return response;
      }
      
      // PWA Manifest
      if (path === '/manifest.json') {
        return new Response(getManifest(), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
      
      // Service Worker
      if (path === '/sw.js') {
        return new Response(getServiceWorker(), {
          headers: {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
          },
        });
      }

      if (path === '/login') {
        return new Response(getLoginPageHTML(), {
          headers: { 'Content-Type': 'text/html', ...corsHeaders },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};

// --- 核心逻辑 ---
async function checkAuthentication(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
    const [name, value] = cookie.trim().split('=');
    acc[name] = value;
    return acc;
  }, {});
  if (cookies.auth_token) {
    const storedSession = await env.ACCOUNTING_KV.get(`session_${cookies.auth_token}`);
    return storedSession !== null;
  }
  return false;
}

async function handleAPIRequest(request, env, path, method) {
  const kv = env.ACCOUNTING_KV;
  const userId = 'default_user'; 

  if (path === '/api/auth/login' && method === 'POST') {
    const { password } = await request.json();
    const correctPassword = await kv.get('app_password') || 'admin123'; 
    
    if (password === correctPassword) {
      const token = generateToken();
      const expiresAt = Date.now() + (24 * 60 * 60 * 1000);
      await kv.put(`session_${token}`, JSON.stringify({ userId, expiresAt }), { expirationTtl: 86400 });
      return new Response(JSON.stringify({ success: true, token }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
        },
      });
    } else {
      return new Response(JSON.stringify({ error: '密码错误' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const cookieHeader = request.headers.get('Cookie') || '';
    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
      const [name, value] = cookie.trim().split('=');
      acc[name] = value;
      return acc;
    }, {});
    if (cookies.auth_token) await kv.delete(`session_${cookies.auth_token}`);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' },
    });
  }

  if (path === '/api/transactions') {
    if (method === 'GET') {
      const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
      return new Response(JSON.stringify(transactions), { headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'POST') {
      const transaction = await request.json();
      transaction.id = generateToken();
      transaction.timestamp = new Date().toISOString();
      const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
      transactions.push(transaction);
      await kv.put(`transactions_${userId}`, JSON.stringify(transactions));
      return new Response(JSON.stringify(transaction), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (path.startsWith('/api/transactions/') && method === 'DELETE') {
    const transactionId = path.split('/').pop();
    const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
    const filteredTransactions = transactions.filter(t => t.id !== transactionId);
    await kv.put(`transactions_${userId}`, JSON.stringify(filteredTransactions));
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/summary') {
    const url = new URL(request.url);
    const period = url.searchParams.get('period') || 'daily';
    const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
    const summary = calculateSummary(transactions, period);
    return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Not Found', { status: 404 });
}

function getServiceWorker() {
  return `
const CACHE_NAME = 'accounting-app-v7'; 
const urlsToCache = ['/', '/manifest.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urlsToCache))));
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(names => Promise.all(names.map(n => n !== CACHE_NAME ? caches.delete(n) : null))));
});`;
}

function getManifest() {
  const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcng9IjEyOCIgZmlsbD0iIzBmMTcyYSIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0yNTYgMTI4bC0zMiA4MEgxMjhsODAgMzItODAgMzJoOTZsMzIgODBMMjU2IDQwMEwyODggMjU2aDk2bDMyLTgwaC05NnpNMjU2IDE5MmwzMiA4MGg5NmwzMi04MGgtOTZ6Ii8+PC9zdmc+";
  return `{
    "name": "极光记账",
    "short_name": "记账",
    "description": "极简高效的个人记账应用",
    "start_url": "/",
    "display": "standalone",
    "background_color": "#0f172a",
    "theme_color": "#0f172a",
    "icons": [
      { "src": "\${iconBase64}", "sizes": "192x192", "type": "image/svg+xml" },
      { "src": "\${iconBase64}", "sizes": "512x512", "type": "image/svg+xml" }
    ]
  }`;
}

function generateToken() { return Math.random().toString(36).substring(2) + Date.now().toString(36); }

function calculateSummary(transactions, period = 'daily') {
  let income = 0, expense = 0;
  const now = new Date();
  const BJT_OFFSET = 8 * 60 * 60 * 1000;
  const utcNowMs = now.getTime();
  const BJT_Ms = utcNowMs + BJT_OFFSET;
  const BJT_Date = new Date(BJT_Ms);
  const BJT_Midnight = new Date(BJT_Date.getUTCFullYear(), BJT_Date.getUTCMonth(), BJT_Date.getUTCDate());
  const today = new Date(BJT_Midnight.getTime() - BJT_OFFSET);
  
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const thisWeek = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate());
  
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisYear = new Date(now.getFullYear(), 0, 1);
  
  const filtered = transactions.filter(t => {
    const d = new Date(t.timestamp);
    if (period === 'daily') return d.getTime() >= today.getTime(); 
    if (period === 'weekly') return d.getTime() >= thisWeek.getTime();
    if (period === 'monthly') return d.getTime() >= thisMonth.getTime();
    if (period === 'yearly') return d.getTime() >= thisYear.getTime();
    return true;
  });
  
  filtered.forEach(t => t.type === 'income' ? income += parseFloat(t.amount) : expense += parseFloat(t.amount));
  return { totalIncome: income, totalExpense: expense, balance: income - expense, transactionCount: filtered.length, period };
}

function getLoginPageHTML() {
  const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcng9IjEyOCIgZmlsbD0iIzBmMTcyYSIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0yNTYgMTI4bC0zMiA4MEgxMjhsODAgMzItODAgMzJoOTZsMzIgODBMMjU2IDQwMEwyODggMjU2aDk2bDMyLTgwaC05NnpNMjU2IDE5MmwzMiA4MGg5NmwzMi04MGgtOTZ6Ii8+PC9zdmc+";
  
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>登录 - 极光记账</title>
    <meta name="theme-color" content="#0f172a">
    <link rel="manifest" href="/manifest.json">
    <link rel="apple-touch-icon" href="${iconBase64}">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap');
        body {
            margin: 0; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; min-height: 100vh;
            display: flex; align-items: center; justify-content: center; background-color: #000;
            background-image: radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%), radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%);
            color: white; overflow: hidden;
        }
        .aurora { position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: conic-gradient(from 0deg at 50% 50%, #1a2a6c 0deg, #b21f1f 120deg, #fdbb2d 240deg, #1a2a6c 360deg); filter: blur(80px); opacity: 0.3; animation: spin 20s linear infinite; z-index: -1; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
        .card { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(24px); border: 1px solid rgba(255, 255, 255, 0.1); padding: 40px; border-radius: 32px; width: 90%; max-width: 360px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4); animation: float 6s ease-in-out infinite; }
        @keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
        .icon { font-size: 48px; margin-bottom: 20px; display: inline-block; filter: drop-shadow(0 0 15px rgba(255,255,255,0.3)); }
        h1 { margin: 0 0 8px 0; font-size: 28px; letter-spacing: -1px; background: linear-gradient(to right, #fff, #bbb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        p { margin: 0 0 32px 0; color: #888; font-size: 14px; }
        input { width: 100%; padding: 16px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: white; font-size: 16px; margin-bottom: 20px; outline: none; text-align: center; transition: 0.3s; box-sizing: border-box; }
        input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); background: rgba(0,0,0,0.5); }
        button { width: 100%; padding: 16px; border-radius: 16px; border: none; background: white; color: black; font-size: 16px; font-weight: 700; cursor: pointer; transition: 0.2s; }
        button:active { transform: scale(0.96); opacity: 0.9; }
        .error { color: #ff6b6b; font-size: 13px; margin-bottom: 15px; display: none; }
    </style>
</head>
<body>
    <div class="aurora"></div>
    <div class="card">
        <div class="icon">✨</div>
        <h1>极光记账</h1>
        <p>Aurora Accounting</p>
        <div id="error" class="error"></div>
        <form id="form">
            <input type="password" id="pwd" placeholder="输入访问密码" required>
            <button type="submit" id="btn">解锁进入</button>
        </form>
    </div>
    <script>
        document.getElementById('form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btn');
            const err = document.getElementById('error');
            btn.innerText = '验证中...';
            btn.disabled = true;
            try {
                const res = await fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('pwd').value }) });
                if (res.ok) window.location.href = '/'; else throw new Error('密码错误');
            } catch (e) { err.innerText = e.message; err.style.display = 'block'; btn.innerText = '解锁进入'; btn.disabled = false; }
        }
    </script>
</body>
</html>`;
}

// --- 极致美化版 主页面 ---
function getHTML() {
  const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcng9IjEyOCIgZmlsbD0iIzBmMTcyYSIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0yNTYgMTI4bC0zMiA4MEgxMjhsODAgMzItODAgMzJoOTZsMzIgODBMMjU2IDQwMEwyODggMjU2aDk2bDMyLTgwaC05NnpNMjU2IDE5MmwzMiA4MGg5NmwzMi04MGgtOTZ6Ii8+PC9zdmc+";
  
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>极光记账</title>
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#0f172a">
    <link rel="manifest" href="/manifest.json">
    <link rel="apple-touch-icon" href="${iconBase64}">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
    
    <style>
        :root {
            --primary: #6366f1;
            --primary-glow: rgba(99, 102, 241, 0.5);
            --success: #10b981;
            --danger: #f43f5e;
            --bg: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --glass-border: rgba(255, 255, 255, 0.08);
            --text: #f8fafc;
            --text-muted: #94a3b8;
        }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body {
            margin: 0; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; background-color: var(--bg); color: var(--text); min-height: 100vh; padding-bottom: 40px;
            background-image: radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%), radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%);
            background-attachment: fixed;
        }
        .glow-spot { position: fixed; width: 300px; height: 300px; background: var(--primary); filter: blur(100px); opacity: 0.15; border-radius: 50%; z-index: -1; pointer-events: none; animation: moveSpot 10s infinite alternate; }
        @keyframes moveSpot { from { transform: translate(0,0); } to { transform: translate(50px, 50px); } }

        .container { max-width: 600px; margin: 0 auto; padding: 20px 20px 80px 20px; }
        header { display: flex; justify-content: space-between; align-items: center; padding: 20px 0; margin-bottom: 20px; }
        .brand { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
        .logout-btn { background: rgba(255,255,255,0.1); border: 1px solid var(--glass-border); color: var(--text-muted); padding: 8px 16px; border-radius: 20px; font-size: 12px; cursor: pointer; transition: 0.3s; }
        .logout-btn:hover { background: rgba(255,255,255,0.2); color: white; }

        .summary-card { background: linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(168,85,247,0.1) 100%); backdrop-filter: blur(20px); border-radius: 28px; padding: 30px; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 20px 40px -10px rgba(0,0,0,0.3); margin-bottom: 30px; position: relative; overflow: hidden; }
        .summary-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent); }
        .balance-label { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
        .balance-amount { font-family: 'JetBrains Mono', monospace; font-size: 32px; font-weight: 700; margin-bottom: 24px; letter-spacing: -1px; }
        .progress-bar { height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin-bottom: 20px; display: flex; }
        .bar-income { height: 100%; background: var(--success); transition: width 0.5s ease; }
        .bar-expense { height: 100%; background: var(--danger); transition: width 0.5s ease; }
        .stats-row { display: flex; justify-content: space-between; }
        .stat-item { flex: 1; }
        .stat-item:last-child { text-align: right; }
        .stat-label { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; display: flex; align-items: center; gap: 4px; }
        .stat-val { font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 600; }
        .income-val { color: var(--success); }
        .expense-val { color: var(--danger); }

        /* Input Area */
        .input-area { position: fixed; bottom: -100%; left: 0; right: 0; max-width: 600px; margin: 0 auto; border-top-left-radius: 32px; border-top-right-radius: 32px; padding: 24px; background: var(--card-bg); backdrop-filter: blur(20px); border: 1px solid var(--glass-border); border-bottom: none; box-shadow: 0 -10px 30px rgba(0,0,0,0.5); z-index: 1000; transition: bottom 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .input-area.active { bottom: 0; }
        .input-header { font-size: 18px; font-weight: 700; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        .input-header button { background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; transition: 0.3s; }
        .type-switch { display: flex; gap: 10px; margin-bottom: 20px; }
        .type-btn { flex: 1; padding: 12px; border-radius: 14px; border: 1px solid var(--glass-border); background: rgba(255,255,255,0.03); color: var(--text-muted); font-weight: 600; cursor: pointer; transition: 0.3s; display: flex; align-items: center; justify-content: center; gap: 6px; }
        .type-btn.active.income { background: rgba(16, 185, 129, 0.2); border-color: var(--success); color: var(--success); }
        .type-btn.active.expense { background: rgba(244, 63, 94, 0.2); border-color: var(--danger); color: var(--danger); }
        .form-group { position: relative; margin-bottom: 16px; }
        .form-input { width: 100%; padding: 16px; background: rgba(0,0,0,0.2); border: 1px solid var(--glass-border); border-radius: 14px; color: white; font-size: 16px; outline: none; transition: 0.3s; box-sizing: border-box; text-align: center; }
        .form-input:focus { border-color: var(--primary); background: rgba(0,0,0,0.4); }
        input[type="number"] { -moz-appearance: textfield; }
        input[type="number"]::-webkit-inner-spin-button, input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        .submit-btn { width: 100%; padding: 16px; background: white; color: black; border: none; border-radius: 16px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 8px; transition: transform 0.2s; }
        .submit-btn:active { transform: scale(0.98); }

        /* Custom Alert Modal */
        .modal-overlay {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.6); backdrop-filter: blur(5px);
            z-index: 2000;
            display: flex; align-items: center; justify-content: center;
            opacity: 0; pointer-events: none; transition: opacity 0.3s ease;
        }
        .modal-overlay.active { opacity: 1; pointer-events: auto; }
        .modal-card {
            background: var(--card-bg);
            border: 1px solid var(--glass-border);
            border-radius: 24px;
            padding: 30px;
            width: 85%; max-width: 320px;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0,0,0,0.4);
            transform: scale(0.9); transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        .modal-overlay.active .modal-card { transform: scale(1); }
        .modal-icon { font-size: 40px; margin-bottom: 16px; }
        .modal-title { font-size: 18px; font-weight: 700; margin-bottom: 8px; color: white; }
        .modal-desc { font-size: 14px; color: var(--text-muted); margin-bottom: 24px; line-height: 1.5; }
        .modal-btns { display: flex; gap: 12px; }
        .modal-btn { flex: 1; padding: 12px; border-radius: 14px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; transition: 0.2s; }
        .modal-btn.cancel { background: rgba(255,255,255,0.1); color: var(--text); }
        .modal-btn.delete { background: var(--danger); color: white; }
        .modal-btn:active { transform: scale(0.95); opacity: 0.9; }

        .bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; max-width: 600px; margin: 0 auto; height: 70px; background: rgba(30, 41, 59, 0.9); backdrop-filter: blur(25px); border-top: 1px solid var(--glass-border); display: flex; justify-content: space-around; align-items: center; padding: 0 10px; z-index: 10; user-select: none; }
        .nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; padding: 0 10px; color: var(--text-muted); font-size: 11px; font-weight: 500; cursor: pointer; transition: color 0.3s; }
        .nav-item.active { color: white; font-weight: 700; }
        .nav-item.active .nav-icon { color: var(--primary); }
        .nav-icon { font-size: 20px; margin-bottom: 2px; transition: color 0.3s; }
        .nav-item.add-btn { width: 50px; height: 50px; background: linear-gradient(135deg, var(--primary), #a855f7); border-radius: 50%; color: white; box-shadow: 0 4px 15px var(--primary-glow); transform: translateY(-15px); transition: transform 0.2s, box-shadow 0.2s; font-size: 30px; font-weight: 300; }
        .nav-item.add-btn:active { transform: translateY(-15px) scale(0.95); }

        .list-header { font-size: 10px; color: var(--text-muted); margin-bottom: 12px; margin-left: 4px; } 
        .transaction-list { display: flex; flex-direction: column; gap: 12px; padding-bottom: 40px; }
        .list-group { margin-top: 16px; }
        .list-date-header { font-size: 14px; color: var(--text-muted); margin-bottom: 8px; font-weight: 700; padding-left: 4px; position: sticky; top: 0; background: var(--bg); z-index: 5; padding-top: 6px; padding-bottom: 6px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
        .collapse-icon { transition: transform 0.3s ease; font-size: 14px; margin-right: 8px; color: #94a3b8; }
        .list-group.collapsed .collapse-icon { transform: rotate(-90deg); }
        .group-content { max-height: 1000px; transition: max-height 0.4s ease-out, opacity 0.4s ease; overflow: hidden; opacity: 1; display: flex; flex-direction: column; gap: 10px; }
        .list-group.collapsed .group-content { max-height: 0; opacity: 0; }
        .group-content > .t-item { margin-bottom: 0; }
        
        .loading-indicator { position: fixed; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, transparent, var(--primary), transparent); transform: scaleX(0); transform-origin: left; transition: transform 0.3s ease-out; z-index: 10000; }
        .loading-indicator.active { transform: scaleX(1); }
        
        .t-item { position: relative; background: var(--danger); border: 1px solid var(--glass-border); border-radius: 18px; display: flex; align-items: center; overflow: hidden; animation: slideIn 0.4s ease-out forwards; opacity: 0; transform: translateY(10px); touch-action: pan-y; min-height: 46px; }
        .t-content { flex: 1; display: flex; align-items: center; padding: 8px 20px; transition: transform 0.3s ease; background: var(--card-bg); width: 100%; }
        @keyframes slideIn { to { opacity: 1; transform: translateY(0); } }
        .t-icon { width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; font-size: 16px; margin-right: 10px; flex-shrink: 0; }
        .t-details { flex: 1; min-width: 0; }
        .t-title { font-weight: 600; margin-bottom: 0px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } 
        .t-meta { font-size: 10px; color: var(--text-muted); } 
        .t-amount { font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 12px; text-align: right; margin-left: 4px; flex-shrink: 0; }
        .empty-state { text-align: center; padding: 40px; color: var(--text-muted); }

        @media (max-width: 480px) {
            .container { padding: 16px 16px 80px 16px; }
            .balance-amount { font-size: 32px; }
            .summary-card { padding: 24px; }
        }
    </style>
</head>
<body>
    <div class="glow-spot" style="top: 10%; left: 0;"></div>
    <div class="glow-spot" style="bottom: 10%; right: 0; background: var(--danger);"></div>
    <div id="loadingIndicator" class="loading-indicator"></div>

    <div class="container">
        <header>
            <div class="brand">✨ 极光记账</div>
            <button class="logout-btn" onclick="logout()">退出登录</button>
        </header>

        <div class="summary-card">
            <div class="balance-label">当前结余 (Balance)</div>
            <div class="balance-amount" id="balanceDisplay">¥0.00</div>
            <div class="progress-bar">
                <div class="bar-income" id="barIncome" style="width: 50%"></div>
                <div class="bar-expense" id="barExpense" style="width: 50%"></div>
            </div>
            <div class="stats-row">
                <div class="stat-item">
                    <div class="stat-label"><span style="color:var(--success)">↓</span> 收入</div>
                    <div class="stat-val income-val" id="incomeDisplay">0.00</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label" style="justify-content: flex-end">支出 <span style="color:var(--danger)">↑</span></div>
                    <div class="stat-val expense-val" id="expenseDisplay">0.00</div>
                </div>
            </div>
        </div>

        <div class="list-header">近期明细 · RECENT</div>
        <div id="list" class="transaction-list">
            <div class="empty-state">加载中...</div>
        </div>
    </div>

    <div id="addModal" class="input-area">
        <div class="input-header">记一笔 <button onclick="closeAddModal()">✕</button></div>
        <form id="addForm">
            <div class="type-switch">
                <div class="type-btn active income" id="btnIncome" onclick="setType('income')">↓ 收入</div>
                <div class="type-btn" id="btnExpense" onclick="setType('expense')">↑ 支出</div>
            </div>
            <div style="display:flex; gap:12px; margin-bottom:12px;">
                <div style="flex:1"><input type="number" inputmode="decimal" id="amount" class="form-input" placeholder="金额 0.00" step="0.01" required style="font-family:'JetBrains Mono'"></div>
                <div style="flex:1"><select id="category" class="form-input" required style="-webkit-appearance:none;"><option value="默认">分类</option></select></div>
            </div>
            <div class="form-group"><input type="text" id="desc" class="form-input" placeholder="备注 (选填)"></div>
            <button type="submit" class="submit-btn">确认添加</button>
        </form>
    </div>

    <div id="deleteModal" class="modal-overlay">
        <div class="modal-card">
            <div class="modal-icon">🗑️</div>
            <div class="modal-title">确认删除？</div>
            <div class="modal-desc">这条记录将被永久移除，无法恢复。</div>
            <div class="modal-btns">
                <button class="modal-btn cancel" onclick="cancelDelete()">取消</button>
                <button class="modal-btn delete" onclick="confirmDelete()">删除</button>
            </div>
        </div>
    </div>

    <div class="bottom-nav">
        <div class="nav-item active" id="nav-daily" onclick="setPeriod('daily', this)"><div class="nav-icon">📅</div>今日</div>
        <div class="nav-item" id="nav-weekly" onclick="setPeriod('weekly', this)"><div class="nav-icon">🗓️</div>本周</div>
        <div class="nav-item add-btn" onclick="openAddModal()"><div class="nav-icon">+</div></div>
        <div class="nav-item" id="nav-monthly" onclick="setPeriod('monthly', this)"><div class="nav-icon">📊</div>本月</div>
        <div class="nav-item" id="nav-yearly" onclick="setPeriod('yearly', this)"><div class="nav-icon">⭐</div>今年</div>
    </div>

    <script>
        let state = {
            type: 'income', period: 'daily',
            categories: {
                expense: ['餐饮 🍔', '购物 🛍️', '交通 🚗', '住房 🏠', '娱乐 🎮', '医疗 💊', '其他 📝'],
                income: ['工资 💰', '奖金 💎', '理财 📈', '兼职 💼', '红包 🧧', '其他 📝']
            }
        };
        let pendingDelete = null; // 存储待删除项信息

        function toggleGroup(groupId) {
            const group = document.getElementById(groupId);
            if (group) { group.classList.toggle('collapsed'); hapticFeedback(); }
        }
        window.toggleGroup = toggleGroup;

        function init() {
            updateCategoryOptions(); loadData();
            if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW fail', err)); });
            }
        }

        function hapticFeedback() { if (window.navigator.vibrate) window.navigator.vibrate(50); }

        function openAddModal() { document.getElementById('addModal').classList.add('active'); hapticFeedback(); }
        function closeAddModal() { document.getElementById('addModal').classList.remove('active'); }

        // --- 删除确认 Modal 逻辑 ---
        function openDeleteModal(id, element, content) {
            pendingDelete = { id, element, content };
            document.getElementById('deleteModal').classList.add('active');
            hapticFeedback();
        }

        function cancelDelete() {
            document.getElementById('deleteModal').classList.remove('active');
            // 回弹复位
            if (pendingDelete && pendingDelete.content) {
                pendingDelete.content.style.transform = 'translateX(0)';
            }
            pendingDelete = null;
        }

        async function confirmDelete() {
            document.getElementById('deleteModal').classList.remove('active');
            if (!pendingDelete) return;

            const { id, element, content } = pendingDelete;
            
            // 执行视觉删除动画
            content.style.transition = 'transform 0.4s ease-out';
            content.style.transform = 'translateX(-100%)';
            hapticFeedback();

            await deleteItem(id);
            
            // 列表项塌缩动画
            element.style.transition = 'opacity 0.3s ease 0.1s, margin 0.3s ease 0.1s, height 0.3s ease 0.1s, padding 0.3s ease 0.1s';
            element.style.opacity = '0';
            element.style.height = '0';
            element.style.margin = '0';
            element.style.padding = '0';

            await loadSummaryOnly();
            setTimeout(() => element.remove(), 400);
            
            pendingDelete = null;
        }
        window.cancelDelete = cancelDelete;
        window.confirmDelete = confirmDelete;
        // ---------------------------

        function setType(type) {
            state.type = type;
            document.getElementById('btnIncome').className = \`type-btn \${type === 'income' ? 'active income' : ''}\`;
            document.getElementById('btnExpense').className = \`type-btn \${type === 'expense' ? 'active expense' : ''}\`;
            updateCategoryOptions(); hapticFeedback();
        }

        function updateCategoryOptions() {
            const select = document.getElementById('category'); select.innerHTML = '';
            state.categories[state.type].forEach(c => {
                const opt = document.createElement('option'); opt.value = c.split(' ')[0]; opt.textContent = c; select.appendChild(opt);
            });
        }

        function setPeriod(period, el) {
            state.period = period;
            document.querySelectorAll('.nav-item').forEach(t => { if (!t.classList.contains('add-btn')) t.classList.remove('active'); });
            el.classList.add('active'); loadData(); hapticFeedback();
        }

        async function loadData() {
            const indicator = document.getElementById('loadingIndicator'); indicator.classList.add('active'); 
            try {
                const [txRes, sumRes] = await Promise.all([ fetch('/api/transactions'), fetch('/api/summary?period=' + state.period) ]);
                const transactions = await txRes.json(); const summary = await sumRes.json();
                renderSummary(summary); renderList(transactions);
            } catch (e) { document.getElementById('list').innerHTML = '<div class="empty-state" style="color: var(--danger)">⚠️ 数据加载失败</div>'; } 
            finally { setTimeout(() => indicator.classList.remove('active'), 300); }
        }
        
        async function loadSummaryOnly() {
            try { const sumRes = await fetch('/api/summary?period=' + state.period); const summary = await sumRes.json(); renderSummary(summary); } catch (e) {}
        }
        window.loadSummaryOnly = loadSummaryOnly;

        function renderSummary(data) {
            const balEl = document.getElementById('balanceDisplay');
            animateValue(balEl, parseFloat(balEl.innerText.replace('¥','')) || 0, data.balance);
            document.getElementById('incomeDisplay').innerText = '+' + data.totalIncome.toFixed(2);
            document.getElementById('expenseDisplay').innerText = '-' + data.totalExpense.toFixed(2);
            const total = data.totalIncome + data.totalExpense;
            if (total === 0) { document.getElementById('barIncome').style.width = '0%'; document.getElementById('barExpense').style.width = '0%'; }
            else { document.getElementById('barIncome').style.width = (data.totalIncome/total*100)+'%'; document.getElementById('barExpense').style.width = (data.totalExpense/total*100)+'%'; }
        }

        function animateValue(obj, start, end) {
            let startTimestamp = null; const duration = 500;
            const step = (timestamp) => {
                if (!startTimestamp) startTimestamp = timestamp;
                const progress = Math.min((timestamp - startTimestamp) / duration, 1);
                obj.innerHTML = '¥' + (start + progress * (end - start)).toFixed(2);
                if (progress < 1) window.requestAnimationFrame(step);
            }; window.requestAnimationFrame(step);
        }

        function renderList(list) {
            const container = document.getElementById('list');
            if (list.length === 0) { container.innerHTML = '<div class="empty-state">🍃 暂无数据，开始记账吧</div>'; return; }
            const getIcon = (cat) => { const map = {'餐饮':'🍔','购物':'🛍️','交通':'🚗','住房':'🏠','娱乐':'🎮','医疗':'💊','工资':'💰','奖金':'💎','理财':'📈','兼职':'💼','红包':'🧧','其他':'📝','默认':'📝'}; return map[cat] || '📝'; };
            const getFormattedDate = (isoDate) => {
                const d = new Date(isoDate); const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
                if (date.getTime() === today.getTime()) return '今天';
                if (date.getTime() === yesterday.getTime()) return '昨天';
                return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
            };
            const sortedList = list.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
            const groupedList = sortedList.reduce((groups, item) => { const dateKey = item.timestamp.substring(0, 10); if (!groups[dateKey]) groups[dateKey] = []; groups[dateKey].push(item); return groups; }, {});

            let html = ''; let indexCounter = 0;
            for (const dateKey in groupedList) {
                const items = groupedList[dateKey]; const groupId = \`group-\${dateKey}\`;
                const isCollapsed = (new Date(new Date().toDateString()).getTime() - new Date(dateKey).getTime()) / 86400000 > 3;
                html += \`<div class="list-group \${isCollapsed ? 'collapsed' : ''}" id="\${groupId}">
                            <div class="list-date-header" onclick="toggleGroup('\${groupId}')"><span>\${getFormattedDate(dateKey)}</span><span class="collapse-icon">▼</span></div>
                            <div class="group-content">\${items.map(t => { indexCounter++; return \`<div class="t-item" data-id="\${t.id}" style="animation-delay: \${indexCounter * 0.05}s"><div class="t-content"><div class="t-icon">\${getIcon(t.category)}</div><div class="t-details"><div class="t-title">\${t.description || t.category}</div><div class="t-meta">\${new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · \${t.category}</div></div><div class="t-amount" style="color: \${t.type === 'income' ? 'var(--success)' : 'var(--danger)'}">\${t.type === 'income' ? '+' : '-'} \${parseFloat(t.amount).toFixed(2)}</div></div></div>\`; }).join('')}</div></div>\`;
            }
            container.innerHTML = html;

            container.querySelectorAll('.t-item').forEach(item => {
                const content = item.querySelector('.t-content');
                let startX = 0; let isDragging = false; let itemMoved = false;
                item.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; isDragging = false; content.style.transition = 'none'; container.querySelectorAll('.t-content').forEach(c => { if (c !== content) c.style.transform = 'translateX(0)'; }); }, { passive: true });
                item.addEventListener('touchmove', (e) => {
                    const diff = e.touches[0].clientX - startX;
                    if (Math.abs(diff) > 5) isDragging = true;
                    if (diff < 0) { content.style.transform = \`translateX(\${diff}px)\`; itemMoved = true; } 
                    else if ((parseInt(content.style.transform.replace('translateX(', '')) || 0) < 0) { content.style.transform = \`translateX(\${diff}px)\`; itemMoved = true; }
                    if(isDragging) e.preventDefault();
                }, { passive: false });
                item.addEventListener('touchend', async (e) => {
                    content.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
                    const deleteThreshold = -item.offsetWidth * 0.4;
                    const currentOffset = parseInt(content.style.transform.replace('translateX(', '')) || 0;
                    if (currentOffset < deleteThreshold) {
                        // 触发自定义删除弹窗
                        openDeleteModal(item.dataset.id, item, content);
                    } else { content.style.transform = 'translateX(0)'; }
                    if (itemMoved) e.stopPropagation(); itemMoved = false;
                });
            });
        }

        document.getElementById('addForm').onsubmit = async (e) => {
            e.preventDefault(); const btn = e.target.querySelector('button'); btn.disabled = true; btn.innerText = '保存中...'; hapticFeedback();
            try { await fetch('/api/transactions', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ type: state.type, amount: document.getElementById('amount').value, category: document.getElementById('category').value, description: document.getElementById('desc').value }) }); document.getElementById('amount').value = ''; document.getElementById('desc').value = ''; closeAddModal(); await loadData(); } 
            catch(e) { alert('保存失败'); } finally { btn.disabled = false; btn.innerText = '确认添加'; }
        };

        async function deleteItem(id) { await fetch('/api/transactions/' + id, { method: 'DELETE' }); }
        function logout() { fetch('/api/auth/logout', {method:'POST'}).then(() => window.location.href = '/login'); }
        init();
    </script>
</body>
</html>`;
}
