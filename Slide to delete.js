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
            'Cache-Control': 'no-cache, no-store, must-revalidate',
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
    const correctPassword = await kv.get('app_password') || 'Lili900508@@'; 
    
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
      return new Response(JSON.stringify(transactions), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (path.startsWith('/api/transactions/') && method === 'DELETE') {
    const transactionId = path.split('/').pop();
    const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
    const filteredTransactions = transactions.filter(t => t.id !== transactionId);
    await kv.put(`transactions_${userId}`, JSON.stringify(filteredTransactions));
    return new Response(JSON.stringify(filteredTransactions), { headers: { 'Content-Type': 'application/json' } });
  }

  if (path === '/api/daily_balance') {
      const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
      const url = new URL(request.url);
      const targetYear = parseInt(url.searchParams.get('year') || new Date().getFullYear());
      const targetMonth = parseInt(url.searchParams.get('month') || new Date().getMonth() + 1);
      const dailyBalances = calculateDailyBalances(transactions, targetYear, targetMonth);
      return new Response(JSON.stringify(dailyBalances), { headers: { 'Content-Type': 'application/json' } });
  }
  
  if (path === '/api/monthly_balance') {
    const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
    const url = new URL(request.url);
    const targetYear = parseInt(url.searchParams.get('year') || new Date().getFullYear());
    const monthlyBalances = calculateMonthlyNetFlow(transactions, targetYear);
    return new Response(JSON.stringify(monthlyBalances), { headers: { 'Content-Type': 'application/json' } });
  }
  
  if (path === '/api/weekly_balance') {
    const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
    const weeklyBalances = calculateWeeklyNetFlow(transactions);
    return new Response(JSON.stringify(weeklyBalances), { headers: { 'Content-Type': 'application/json' } });
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

// --- 逻辑函数 ---
function calculateDailyBalances(transactions, targetYear, targetMonth) {
    const monthlyTransactions = transactions.filter(t => {
        const d = new Date(t.timestamp);
        return d.getFullYear() === targetYear && d.getMonth() === targetMonth - 1; 
    }).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const now = new Date();
    const BJT_OFFSET = 8 * 60 * 60 * 1000;
    const utcNowMs = now.getTime();
    const BJT_Date = new Date(utcNowMs + BJT_OFFSET);
    
    if (targetYear > BJT_Date.getUTCFullYear() || (targetYear === BJT_Date.getUTCFullYear() && targetMonth > BJT_Date.getUTCMonth() + 1)) {
        return [];
    }

    const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
    const dailyData = [];
    const maxDay = daysInMonth; 

    const dailyNetFlows = {};
    monthlyTransactions.forEach(t => {
        const d = new Date(t.timestamp);
        const day = d.getDate();
        const amount = parseFloat(t.amount);
        const netAmount = t.type === 'income' ? amount : -amount;
        
        dailyNetFlows[day] = (dailyNetFlows[day] || 0) + netAmount;
    });

    for (let day = 1; day <= maxDay; day++) {
        const dateKey = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        let dailyAmount = dailyNetFlows[day] || 0;
        if (targetYear === BJT_Date.getUTCFullYear() && targetMonth === BJT_Date.getUTCMonth() + 1) {
            if (day > BJT_Date.getUTCDate()) { dailyAmount = 0; }
        }
        dailyData.push({ day: day, date: dateKey, balance: dailyAmount });
    }
    return dailyData;
}

function calculateMonthlyNetFlow(transactions, targetYear) {
    const now = new Date();
    const BJT_OFFSET = 8 * 60 * 60 * 1000;
    const utcNowMs = now.getTime();
    const BJT_Date = new Date(utcNowMs + BJT_OFFSET);

    const currentYear = BJT_Date.getUTCFullYear();
    const currentMonth = BJT_Date.getUTCMonth() + 1;

    if (targetYear > currentYear) return [];

    const monthlyNetFlows = {};
    transactions.forEach(t => {
        const d = new Date(t.timestamp);
        const year = d.getFullYear();
        const month = d.getMonth() + 1;
        
        if (year === targetYear) {
            const amount = parseFloat(t.amount);
            const netAmount = t.type === 'income' ? amount : -amount;
            monthlyNetFlows[month] = (monthlyNetFlows[month] || 0) + netAmount;
        }
    });

    const monthlyData = [];
    for (let month = 1; month <= 12; month++) {
        let monthlyAmount = monthlyNetFlows[month] || 0;
        if (targetYear === currentYear) {
            if (month > currentMonth) { monthlyAmount = 0; }
        }
        monthlyData.push({ month: month, balance: monthlyAmount });
    }
    return monthlyData;
}

function calculateWeeklyNetFlow(transactions) {
    const now = new Date();
    const BJT_OFFSET = 8 * 60 * 60 * 1000;
    const utcNowMs = now.getTime();
    const BJT_Date = new Date(utcNowMs + BJT_OFFSET);

    let dayOfWeek = BJT_Date.getUTCDay(); 
    let mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; 
    const startOfWeek = new Date(Date.UTC(BJT_Date.getUTCFullYear(), BJT_Date.getUTCMonth(), BJT_Date.getUTCDate() + mondayOffset));
    
    const formatDate = (d) => d.toISOString().substring(0, 10);
    const todayKey = formatDate(BJT_Date);
    
    const dayLabels = ['一', '二', '三', '四', '五', '六', '日'];
    const dataPoints = [];

    for (let i = 0; i < 7; i++) {
        const date = new Date(startOfWeek);
        date.setUTCDate(startOfWeek.getUTCDate() + i);
        dataPoints.push({ day: dayLabels[i], date: date, balance: 0, dateKey: formatDate(date) });
    }

    const dailyNetFlows = {};
    const weekStartKey = dataPoints[0].dateKey;
    const weekEndKey = dataPoints[6].dateKey;

    transactions.forEach(t => {
        const d = new Date(t.timestamp);
        const transactionDateKey = formatDate(d);
        if (transactionDateKey >= weekStartKey && transactionDateKey <= weekEndKey) {
            const amount = parseFloat(t.amount);
            const netAmount = t.type === 'income' ? amount : -amount;
            dailyNetFlows[transactionDateKey] = (dailyNetFlows[transactionDateKey] || 0) + netAmount;
        }
    });

    return dataPoints.map(dataPoint => {
        let dailyAmount = dailyNetFlows[dataPoint.dateKey] || 0;
        if (dataPoint.dateKey > todayKey) { dailyAmount = 0; }
        return { day: dataPoint.day, balance: dailyAmount };
    });
}

function getServiceWorker() {
  return `
const CACHE_NAME = 'accounting-app-v21'; // 版本号升级
const urlsToCache = [
  '/', 
  '/manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(urlsToCache).catch(err => console.error("Cache addAll failed:", err)))
  );
  self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isApi = url.pathname.startsWith('/api/');
  
  if (urlsToCache.includes(url.pathname) || (url.origin === self.location.origin && urlsToCache.includes(url.pathname))) {
      e.respondWith(caches.match(e.request).then(response => response || fetch(e.request)));
      return;
  }
  
  if (isApi) {
      if (e.request.method !== 'GET') {
           e.respondWith(fetch(e.request));
           return;
      }
      e.respondWith(
          fetch(e.request)
              .then(response => {
                  if (response.ok) {
                      const responseClone = response.clone();
                      caches.open(CACHE_NAME).then(cache => cache.put(e.request, responseClone));
                  }
                  return response;
              })
              .catch(() => {
                  return caches.match(e.request).then(cachedResponse => {
                      if (cachedResponse) return cachedResponse;
                      return new Response(JSON.stringify({ error: 'Offline' }), { 
                          status: 503, headers: { 'Content-Type': 'application/json' } 
                      });
                  });
              })
      );
      return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names => Promise.all(
      names.map(n => n !== CACHE_NAME ? caches.delete(n) : null)
    )).then(() => self.clients.claim())
  );
});`;
}

function getManifest() {
  const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjUxMiIgeTI9IjUxMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzYzNjZmMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2E4NTVmNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiBmaWxsPSJ1cmwoI2EpIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI1NiAxMjhsLTMyIDgwSDEyOGw4MCAzMi04MCAzMmg5NmwzMiA4MEwyNTYgNDAwTDI4OCAyNTZoOTZsMzItODBoLTk2ek0yNTYgMTkybDMyIDgwaDk2bDMyLTgwaC05NnoiLz48L3N2Zz4=";
  
  return `{
    "id": "aurora-accounting-app",
    "name": "极光记账",
    "short_name": "记账",
    "description": "极简高效的个人记账应用",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "display_override": ["window-controls-overlay", "standalone"],
    "background_color": "#020617",
    "theme_color": "#020617",
    "orientation": "portrait",
    "icons": [
      { 
          "src": "${iconBase64}", 
          "sizes": "192x192", 
          "type": "image/svg+xml",
          "purpose": "any maskable" 
      },
      { 
          "src": "${iconBase64}", 
          "sizes": "512x512", 
          "type": "image/svg+xml",
          "purpose": "any maskable"
      }
    ],
    "categories": ["finance", "productivity"],
    "shortcuts": [
        {
            "name": "记一笔",
            "short_name": "记账",
            "description": "快速添加一笔新的收支记录",
            "url": "/?add=true", 
            "icons": [{ "src": "${iconBase64}", "sizes": "96x96", "purpose": "any maskable" }]
        }
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
    const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjUxMiIgeTI9IjUxMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzYzNjZmMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2E4NTVmNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiBmaWxsPSJ1cmwoI2EpIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI1NiAxMjhsLTMyIDgwSDEyOGw4MCAzMi04MCAzMmg5NmwzMiA4MEwyNTYgNDAwTDI4OCAyNTZoOTZsMzItODBoLTk2ek0yNTYgMTkybDMyIDgwaDk2bDMyLTgwaC05NnoiLz48L3N2Zz4=";
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>登录 - 极光记账</title>
    <meta name="theme-color" content="#020617">
    <link rel="manifest" href="/manifest.json">
    <link rel="apple-touch-icon" href="${iconBase64}">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
    <style>
        :root { --primary: #6366f1; --bg: #020617; --card-bg: rgba(30, 41, 59, 0.4); --glass-border: rgba(255, 255, 255, 0.08); --text: #f8fafc; }
        body { margin: 0; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background-color: var(--bg); color: var(--text); overflow: hidden; position: relative; }
        .aurora-bg { position: absolute; width: 100%; height: 100%; top: 0; left: 0; z-index: -1; background: radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), radial-gradient(at 100% 0%, hsla(260,100%,70%,0.15) 0, transparent 50%), radial-gradient(at 0% 100%, hsla(220,100%,70%,0.15) 0, transparent 50%); animation: breathe 10s infinite alternate; }
        @keyframes breathe { 0% { opacity: 0.8; transform: scale(1); } 100% { opacity: 1; transform: scale(1.05); } }
        .card { background: var(--card-bg); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid var(--glass-border); padding: 48px 40px; border-radius: 32px; width: 90%; max-width: 360px; text-align: center; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); animation: floatIn 0.8s cubic-bezier(0.2, 0.8, 0.2, 1); }
        @keyframes floatIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .logo-img { width: 80px; height: 80px; margin-bottom: 24px; filter: drop-shadow(0 0 20px rgba(99,102,241,0.5)); border-radius: 20px; }
        h1 { margin: 0 0 8px 0; font-size: 28px; font-weight: 800; color: white; letter-spacing: -0.5px; }
        p { margin: 0 0 40px 0; color: #94a3b8; font-size: 15px; }
        input { width: 100%; padding: 18px 24px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); background: rgba(0,0,0,0.3); color: white; font-size: 24px; letter-spacing: 4px; margin-bottom: 24px; outline: none; text-align: center; transition: 0.3s; box-sizing: border-box; font-family: monospace; }
        input::placeholder { font-size: 16px; letter-spacing: normal; opacity: 0.5; font-family: 'Plus Jakarta Sans', sans-serif; }
        input:focus { border-color: var(--primary); background: rgba(0,0,0,0.5); box-shadow: 0 0 0 4px rgba(99,102,241,0.2); }
        button { width: 100%; padding: 18px; border-radius: 20px; border: none; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; font-size: 16px; font-weight: 700; cursor: pointer; transition: 0.3s; box-shadow: 0 10px 20px -10px rgba(99, 102, 241, 0.5); position: relative; overflow: hidden; }
        button:hover { transform: translateY(-2px); box-shadow: 0 15px 30px -10px rgba(99, 102, 241, 0.6); }
        button:active { transform: scale(0.98); }
        .error { color: #f43f5e; font-size: 14px; margin-bottom: 20px; display: none; background: rgba(244,63,94,0.1); padding: 10px; border-radius: 12px; }
    </style>
</head>
<body>
    <div class="aurora-bg"></div>
    <div class="card">
        <img src="${iconBase64}" class="logo-img" alt="Logo">
        <h1>Welcome Back</h1>
        <p>输入密码以访问您的账本</p>
        <div id="error" class="error"></div>
        <form id="form">
            <input type="password" id="pwd" placeholder="Password" required>
            <button type="submit" id="btn">解锁进入</button>
        </form>
    </div>
    <script>
        document.getElementById('form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btn');
            const err = document.getElementById('error');
            err.style.display = 'none';
            btn.innerText = 'Verifying...';
            btn.disabled = true;
            try {
                const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pwd').value }) });
                if (res.ok) { window.location.href = '/'; } 
                else { const data = await res.json(); throw new Error(data.error || '登录失败'); }
            } catch (e) { 
                err.innerText = e.message; err.style.display = 'block'; 
                btn.innerText = '解锁进入'; btn.disabled = false; 
                document.getElementById('pwd').value = '';
                document.getElementById('pwd').focus();
            }
        }
    </script>
</body>
</html>`;
}

function getHTML() {
  const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjUxMiIgeTI9IjUxMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzYzNjZmMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2E4NTVmNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiBmaWxsPSJ1cmwoI2EpIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI1NiAxMjhsLTMyIDgwSDEyOGw4MCAzMi04MCAzMmg5NmwzMiA4MEwyNTYgNDAwTDI4OCAyNTZoOTZsMzItODBoLTk2ek0yNTYgMTkybDMyIDgwaDk2bDMyLTgwaC05NnoiLz48L3N2Zz4=";
  
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>极光记账</title>
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#020617">
    <link rel="manifest" href="/manifest.json">
    <link rel="apple-touch-icon" href="${iconBase64}">
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
    <style>
        :root { --primary: #8b5cf6; --primary-glow: rgba(139, 92, 246, 0.4); --success: #34d399; --danger: #fb7185; --bg: #020617; --card-bg: rgba(30, 41, 59, 0.6); --glass-border: rgba(255, 255, 255, 0.08); --text: #f8fafc; --text-muted: #94a3b8; --safe-bottom: env(safe-area-inset-bottom, 20px); }
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        body { margin: 0; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif; background-color: var(--bg); color: var(--text); min-height: 100vh; padding-bottom: calc(80px + var(--safe-bottom)); background-image: radial-gradient(circle at 15% 10%, rgba(99, 102, 241, 0.15), transparent 40%), radial-gradient(circle at 85% 30%, rgba(236, 72, 153, 0.1), transparent 40%); background-attachment: fixed; }
        header { display: flex; justify-content: space-between; align-items: center; padding: 20px 4px; margin-bottom: 10px; }
        .brand { font-size: 22px; font-weight: 800; display: flex; align-items: center; gap: 10px; background: linear-gradient(to right, #fff, #cbd5e1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .brand img { width: 28px; height: 28px; border-radius: 8px; box-shadow: 0 4px 12px rgba(99,102,241,0.4); }
        .logout-btn { background: rgba(255,255,255,0.05); border: 1px solid var(--glass-border); color: var(--text-muted); padding: 8px 16px; border-radius: 99px; font-size: 13px; font-weight: 600; cursor: pointer; transition: 0.3s; }
        .logout-btn:hover { background: rgba(255,255,255,0.1); color: white; border-color: rgba(255,255,255,0.2); }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .summary-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border-radius: 32px; padding: 32px 24px; border: 1px solid var(--glass-border); box-shadow: 0 20px 40px -10px rgba(0,0,0,0.5); margin-bottom: 32px; position: relative; overflow: hidden; }
        .summary-card::after { content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%; background: radial-gradient(circle, rgba(255,255,255,0.03) 0%, transparent 60%); pointer-events: none; }
        .balance-label { font-size: 13px; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; opacity: 0.8; }
        .balance-amount { font-family: 'JetBrains Mono', monospace; font-size: 42px; font-weight: 700; margin-bottom: 32px; letter-spacing: -1.5px; background: linear-gradient(180deg, #fff 20%, #94a3b8 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 10px; }
        .stat-box { background: rgba(0,0,0,0.2); border-radius: 20px; padding: 16px; display: flex; flex-direction: column; position: relative; border: 1px solid rgba(255,255,255,0.03); }
        .stat-icon-bg { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 14px; margin-bottom: 12px; }
        .income .stat-icon-bg { background: rgba(52, 211, 153, 0.15); color: var(--success); }
        .expense .stat-icon-bg { background: rgba(251, 113, 133, 0.15); color: var(--danger); }
        .stat-title { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; font-weight: 500; }
        .stat-val { font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 600; color: white; letter-spacing: -0.5px; }
        .progress-wrapper { height: 6px; background: rgba(255,255,255,0.05); border-radius: 99px; overflow: hidden; margin-top: 24px; display: flex; }
        .p-bar { height: 100%; transition: width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
        .p-inc { background: var(--success); box-shadow: 0 0 10px rgba(52, 211, 153, 0.4); }
        .p-exp { background: var(--danger); box-shadow: 0 0 10px rgba(251, 113, 133, 0.4); }
        #dailyChartContainer { margin-bottom: 24px; height: 180px; width: 100%; }
        .list-header-row { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; padding: 0 8px; }
        .list-title { font-size: 18px; font-weight: 700; color: white; }
        .list-subtitle { font-size: 12px; color: var(--text-muted); }
        
        .list-group { margin-bottom: 16px; }
        
        /* 修复折叠功能 CSS - 移除箭头，增加整行点击态 */
        .list-date-header { 
            font-size: 13px; color: var(--text-muted); font-weight: 600; 
            padding: 8px 12px; border-radius: 12px; 
            margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;
            background: rgba(255,255,255,0.02); backdrop-filter: blur(10px);
            position: sticky; top: 10px; z-index: 5;
            cursor: pointer; 
            transition: background 0.2s ease;
            user-select: none;
        }
        /* 点击时的反馈效果 */
        .list-date-header:active { background: rgba(255,255,255,0.08); transform: scale(0.99); }
        
        .group-items { transition: max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease; max-height: 2000px; opacity: 1; overflow: hidden; }
        .list-group.collapsed .group-items { max-height: 0; opacity: 0; margin: 0; }
        
        /* 紧凑型记录列表样式 */
        .t-item { margin-bottom: 8px; border-radius: 20px; background: var(--danger); overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); position: relative; }
        .t-content { 
            position: relative; z-index: 2; width: 100%; 
            background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(12px); 
            border: 1px solid var(--glass-border); border-radius: 20px; 
            padding: 10px 14px; /* 减小内边距 */
            display: flex; align-items: center; 
            transition: transform 0.2s ease, background 0.2s; 
        }
        .t-content:active { background: rgba(40, 50, 70, 0.9); }
        
        .t-icon { 
            width: 36px; height: 36px; /* 缩小图标 */
            border-radius: 14px; 
            background: linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02)); 
            border: 1px solid rgba(255,255,255,0.05); 
            display: flex; align-items: center; justify-content: center; 
            font-size: 18px; /* 缩小字号 */
            margin-right: 12px; flex-shrink: 0; 
        }
        
        .t-info { flex: 1; overflow: hidden; }
        .t-name { 
            font-weight: 600; font-size: 14px; /* 微调标题字号 */
            margin-bottom: 1px; color: #fff; 
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; 
        }
        .t-meta { font-size: 11px; color: var(--text-muted); }
        
        .t-amt { 
            font-family: 'JetBrains Mono', monospace; 
            font-weight: 700; font-size: 14px; /* 微调金额字号 */
        }
        .amt-in { color: var(--success); text-shadow: 0 0 15px rgba(52, 211, 153, 0.3); }
        .amt-out { color: var(--danger); text-shadow: 0 0 15px rgba(251, 113, 133, 0.3); }
        
        .dock-container { position: fixed; bottom: 20px; left: 0; right: 0; display: flex; justify-content: center; z-index: 100; padding-bottom: var(--safe-bottom); pointer-events: none; }
        .dock { pointer-events: auto; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(20px) saturate(180%); border: 1px solid rgba(255,255,255,0.1); border-radius: 28px; padding: 8px 24px; display: flex; align-items: center; gap: 24px; box-shadow: 0 20px 40px -5px rgba(0,0,0,0.5); }
        .nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-muted); font-size: 10px; font-weight: 600; cursor: pointer; transition: 0.3s; width: 44px; }
        .nav-icon { font-size: 20px; margin-bottom: 4px; transition: 0.3s; opacity: 0.6; filter: grayscale(1); }
        .nav-item.active { color: white; }
        .nav-item.active .nav-icon { opacity: 1; transform: scale(1.1); filter: grayscale(0); }
        .add-btn { width: 56px; height: 56px; background: linear-gradient(135deg, var(--primary), #a855f7); border-radius: 20px; display: flex; align-items: center; justify-content: center; color: white; font-size: 28px; font-weight: 300; box-shadow: 0 8px 20px -4px var(--primary-glow); transform: translateY(-20px); transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); border: 2px solid rgba(255,255,255,0.1); }
        .add-btn:active { transform: translateY(-20px) scale(0.92); }
        @keyframes pulse-glow { 0% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(139, 92, 246, 0); } 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0); } }
        .add-btn { animation: pulse-glow 3s infinite; }
        .modal-sheet { position: fixed; bottom: 0; left: 0; right: 0; background: #1e293b; border-radius: 32px 32px 0 0; padding: 24px; z-index: 1000; transform: translateY(110%); transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); border-top: 1px solid rgba(255,255,255,0.1); box-shadow: 0 -10px 40px rgba(0,0,0,0.6); padding-bottom: max(24px, var(--safe-bottom)); }
        .modal-sheet.active { transform: translateY(0); }
        .sheet-handle { width: 40px; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; margin: 0 auto 24px auto; }
        .segment-control { display: flex; background: rgba(0,0,0,0.3); padding: 4px; border-radius: 16px; margin-bottom: 24px; position: relative; }
        .segment-btn { flex: 1; padding: 10px; text-align: center; font-weight: 600; color: var(--text-muted); border-radius: 12px; cursor: pointer; position: relative; z-index: 2; transition: 0.3s; font-size: 14px; }
        .segment-btn.active { color: white; }
        .segment-indicator { position: absolute; top: 4px; left: 4px; bottom: 4px; width: calc(50% - 4px); border-radius: 12px; transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); z-index: 1; }
        .indicator-inc { background: var(--success); opacity: 0.2; }
        .indicator-exp { background: var(--danger); opacity: 0.2; }
        .input-row { display: flex; gap: 12px; margin-bottom: 16px; }
        .modern-input { width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.05); padding: 16px; border-radius: 16px; color: white; font-size: 16px; outline: none; transition: 0.3s; font-weight: 500; }
        .modern-input:focus { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.2); }
        .amount-input { font-family: 'JetBrains Mono'; font-size: 20px; }
        .primary-btn { width: 100%; padding: 16px; background: white; color: black; border: none; border-radius: 18px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 8px; box-shadow: 0 10px 20px -5px rgba(255,255,255,0.3); transition: 0.2s; }
        .primary-btn:active { transform: scale(0.96); }
        .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 900; opacity: 0; pointer-events: none; transition: 0.3s; }
        .overlay.active { opacity: 1; pointer-events: auto; }
        .empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); font-size: 14px; opacity: 0.7; }
        .alert-box { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.9); background: #1e293b; border: 1px solid var(--glass-border); padding: 32px; border-radius: 28px; width: 80%; max-width: 320px; z-index: 2000; text-align: center; opacity: 0; pointer-events: none; transition: 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); box-shadow: 0 40px 80px rgba(0,0,0,0.6); }
        .alert-box.active { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
        .alert-btns { display: flex; gap: 12px; margin-top: 24px; }
        .alert-btn { flex: 1; padding: 12px; border-radius: 14px; font-weight: 600; border: none; cursor: pointer; }
        .btn-cancel { background: rgba(255,255,255,0.1); color: white; }
        .btn-delete { background: var(--danger); color: white; }
        
        /* PWA 安装提示弹窗 */
        .install-prompt {
            position: fixed; bottom: -200px; left: 20px; right: 20px;
            background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(20px);
            border: 1px solid var(--glass-border);
            border-radius: 24px; padding: 20px;
            z-index: 5000; display: flex; align-items: center; gap: 16px;
            box-shadow: 0 20px 50px rgba(0,0,0,0.5);
            transition: bottom 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .install-prompt.show { bottom: 30px; }
        .app-icon-preview { width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #6366f1, #a855f7); }
        .install-text { flex: 1; }
        .install-title { font-weight: 700; color: white; font-size: 15px; margin-bottom: 4px; }
        .install-desc { color: var(--text-muted); font-size: 12px; }
        .install-btn { 
            background: white; color: black; border: none; 
            padding: 8px 16px; border-radius: 99px; 
            font-weight: 700; font-size: 13px; cursor: pointer; 
        }
        .close-install { 
            position: absolute; top: -10px; right: -10px; 
            width: 24px; height: 24px; background: #334155; 
            border-radius: 50%; color: white; display: flex; 
            align-items: center; justify-content: center; 
            font-size: 12px; cursor: pointer; 
        }
    </style>
</head>
<body>
    <div class="overlay" id="overlay" onclick="closeAll()"></div>

    <div class="container">
        <header>
            <div class="brand">
                <img src="${iconBase64}" alt="logo"> 极光记账
            </div>
            <button class="logout-btn" onclick="logout()">退出</button>
        </header>

        <div class="summary-card">
            <div class="balance-label">金额</div>
            <div class="balance-amount" id="balanceDisplay">¥0.00</div>
            
            <div id="dailyChartContainer" style="display:none">
                <canvas id="dailyBalanceChart"></canvas>
            </div>
            
            <div class="stats-grid">
                <div class="stat-box income">
                    <div class="stat-icon-bg">↓</div>
                    <div class="stat-title">本期收入</div>
                    <div class="stat-val" id="incomeDisplay">0.00</div>
                </div>
                <div class="stat-box expense">
                    <div class="stat-icon-bg">↑</div>
                    <div class="stat-title">本期支出</div>
                    <div class="stat-val" id="expenseDisplay">0.00</div>
                </div>
            </div>
            
            <div class="progress-wrapper">
                <div class="p-bar p-inc" id="barIncome" style="width: 50%"></div>
                <div class="p-bar p-exp" id="barExpense" style="width: 50%"></div>
            </div>
        </div>

        <div class="list-header-row">
            <span class="list-title">近期明细</span>
            <span class="list-subtitle">左滑删除记录</span>
        </div>
        <div id="list" class="transaction-list">
            <div class="empty-state">✨ 暂无数据，开始记账吧</div>
        </div>
    </div>

    <div class="dock-container">
        <div class="dock">
            <div class="nav-item active" id="nav-daily" onclick="setPeriod('daily', this)">
                <div class="nav-icon">✨</div>今日
            </div>
            <div class="nav-item" id="nav-weekly" onclick="setPeriod('weekly', this)">
                <div class="nav-icon">☄️</div>本周
            </div>
            
            <div class="add-btn" onclick="openAddModal()">+</div>
            
            <div class="nav-item" id="nav-monthly" onclick="setPeriod('monthly', this)">
                <div class="nav-icon">🌙</div>本月
            </div>
            <div class="nav-item" id="nav-yearly" onclick="setPeriod('yearly', this)">
                <div class="nav-icon">🪐</div>本年
            </div>
        </div>
    </div>

    <div id="addModal" class="modal-sheet">
        <div class="sheet-handle"></div>
        <form id="addForm">
            <div class="segment-control">
                <div class="segment-indicator" id="segIndicator"></div>
                <div class="segment-btn active" id="btnIncome" onclick="setType('income')">收入</div>
                <div class="segment-btn" id="btnExpense" onclick="setType('expense')">支出</div>
            </div>
            
            <div class="input-row">
                <div style="flex: 1.5">
                    <input type="number" inputmode="decimal" id="amount" class="modern-input amount-input" placeholder="¥ 0.00" step="0.01" required>
                </div>
                <div style="flex: 1">
                    <select id="category" class="modern-input" style="-webkit-appearance: none;">
                        <option value="默认">分类</option>
                    </select>
                </div>
            </div>
            
            <div style="margin-bottom: 20px;">
                <input type="text" id="desc" class="modern-input" placeholder="备注 (选填)">
            </div>
            
            <button type="submit" class="primary-btn">确认保存</button>
        </form>
    </div>

    <div id="deleteModal" class="alert-box">
        <div style="font-size: 40px; margin-bottom: 16px;">🗑️</div>
        <h3 style="margin: 0; color: white;">确认删除?</h3>
        <p style="color: var(--text-muted); margin: 8px 0 0 0;">此操作无法撤销。</p>
        <div class="alert-btns">
            <button class="alert-btn btn-cancel" onclick="cancelDelete()">取消</button>
            <button class="alert-btn btn-delete" onclick="confirmDelete()">删除</button>
        </div>
    </div>
    
    <div id="installPrompt" class="install-prompt">
        <div class="close-install" onclick="hideInstallPrompt()">✕</div>
        <div class="app-icon-preview"></div>
        <div class="install-text">
            <div class="install-title">安装 极光记账</div>
            <div class="install-desc">获得原生 APP 体验，离线可用</div>
        </div>
        <button class="install-btn" onclick="installApp()">安装</button>
    </div>

    <script>
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
        let state = { type: 'income', period: 'daily', categories: { expense: ['餐饮 🍔', '购物 🛍️', '交通 🚗', '住房 🏠', '娱乐 🎮', '医疗 💊', '订阅 📅', '其他 📝'], income: ['工资 💰', '奖金 💎', '理财 📈', '兼职 💼', '红包 🧧', '其他 📝'] }, chartInstance: null };
        let pendingDelete = null; 
        
        // PWA 安装逻辑 - 仅提示一次
        let deferredPrompt;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            // 检查本地缓存，如果已经关闭过，则不显示
            if (!localStorage.getItem('pwa_prompt_dismissed')) {
                setTimeout(() => {
                    document.getElementById('installPrompt').classList.add('show');
                }, 3000); 
            }
        });
        
        function installApp() {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                deferredPrompt.userChoice.then((choiceResult) => {
                    if (choiceResult.outcome === 'accepted') {
                        console.log('User accepted the A2HS prompt');
                        localStorage.setItem('pwa_prompt_dismissed', 'true'); // 用户同意后也不再提示
                    }
                    deferredPrompt = null;
                    hideInstallPrompt();
                });
            }
        }
        
        function hideInstallPrompt() {
            document.getElementById('installPrompt').classList.remove('show');
            localStorage.setItem('pwa_prompt_dismissed', 'true'); // 用户关闭后不再提示
        }

        function init() {
            updateCategoryOptions(); setType('income'); loadData();
            if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').then(reg => console.log('SW Registered')));
            }
            handleUrlShortcuts();
        }

        // 恢复折叠功能
        function toggleGroup(id) { 
            const el = document.getElementById(id); 
            if (el) {
                el.classList.toggle('collapsed'); 
                vibrate();
            }
        }
        window.toggleGroup = toggleGroup;

        function handleUrlShortcuts() {
            const urlParams = new URLSearchParams(window.location.search);
            const add = urlParams.get('add'); const period = urlParams.get('period');
            if (add === 'true') openAddModal(); else if (period) { const navEl = document.getElementById(\`nav-\${period}\`); if (navEl) setPeriod(period, navEl); }
            if (add || period) window.history.replaceState(null, null, window.location.pathname); 
        }

        function vibrate() { if (window.navigator.vibrate) window.navigator.vibrate(10); }
        function openAddModal() { document.getElementById('addModal').classList.add('active'); document.getElementById('overlay').classList.add('active'); document.getElementById('amount').focus(); vibrate(); }
        function closeAll() { document.getElementById('addModal').classList.remove('active'); document.getElementById('deleteModal').classList.remove('active'); document.getElementById('overlay').classList.remove('active'); if (pendingDelete) { pendingDelete.content.style.transform = 'translateX(0)'; pendingDelete = null; } }
        function openDeleteModal(id, element, content) { pendingDelete = { id, element, content }; document.getElementById('deleteModal').classList.add('active'); document.getElementById('overlay').classList.add('active'); vibrate(); }
        function cancelDelete() { closeAll(); }

        async function confirmDelete() {
            if (!pendingDelete) return;
            const { id, element, content } = pendingDelete;
            element.style.height = element.offsetHeight + 'px'; element.style.transition = 'all 0.3s ease';
            requestAnimationFrame(() => { element.style.height = '0'; element.style.marginBottom = '0'; element.style.opacity = '0'; });
            closeAll();
            const res = await fetch('/api/transactions/' + id, { method: 'DELETE' });
            const updatedList = await res.json();
            setTimeout(() => { renderList(updatedList); loadSummaryOnly(); refreshChart(); }, 300);
        }
        window.cancelDelete = cancelDelete; window.confirmDelete = confirmDelete; window.closeAll = closeAll;

        function setType(type) { 
            state.type = type; 
            const indicator = document.getElementById('segIndicator'); const btnInc = document.getElementById('btnIncome'); const btnExp = document.getElementById('btnExpense');
            if (type === 'income') { indicator.style.transform = 'translateX(0%)'; indicator.className = 'segment-indicator indicator-inc'; btnInc.classList.add('active'); btnExp.classList.remove('active'); } 
            else { indicator.style.transform = 'translateX(100%)'; indicator.className = 'segment-indicator indicator-exp'; btnExp.classList.add('active'); btnInc.classList.remove('active'); }
            updateCategoryOptions(); vibrate(); 
        }
        
        function updateCategoryOptions() { const select = document.getElementById('category'); select.innerHTML = ''; state.categories[state.type].forEach(c => { const opt = document.createElement('option'); opt.value = c.split(' ')[0]; opt.textContent = c; select.appendChild(opt); }); }

        function setPeriod(period, el) {
            state.period = period; document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active')); if (el) el.classList.add('active'); 
            loadData(); vibrate();
            const chartContainer = document.getElementById('dailyChartContainer');
            if (['monthly', 'yearly', 'weekly'].includes(period)) { chartContainer.style.display = 'block'; refreshChart(); } 
            else { chartContainer.style.display = 'none'; if (state.chartInstance) { state.chartInstance.destroy(); state.chartInstance = null; } }
        }
        
        async function refreshChart() { if (state.period === 'monthly') await loadDailyChart(); if (state.period === 'yearly') await loadYearlyChart(); if (state.period === 'weekly') await loadWeeklyChart(); }
        async function loadData() { try { const [txRes, sumRes] = await Promise.all([ fetch('/api/transactions'), fetch('/api/summary?period=' + state.period) ]); const transactions = await txRes.json(); const summary = await sumRes.json(); renderSummary(summary); renderList(transactions); } catch (e) { console.error(e); } }
        async function loadSummaryOnly() { try { const sumRes = await fetch('/api/summary?period=' + state.period); renderSummary(await sumRes.json()); } catch (e) {} }
        
        async function loadDailyChart() { const now = new Date(); const res = await fetch(\`/api/daily_balance?year=\${now.getFullYear()}&month=\${now.getMonth() + 1}\`); renderChart((await res.json()).map(d => ({ label: d.day, value: d.balance })), '日'); }
        async function loadYearlyChart() { const res = await fetch(\`/api/monthly_balance?year=\${new Date().getFullYear()}\`); renderChart((await res.json()).map(d => ({ label: d.month, value: d.balance })), '月'); }
        async function loadWeeklyChart() { const res = await fetch(\`/api/weekly_balance\`); renderChart((await res.json()).map(d => ({ label: d.day, value: d.balance })), ''); }

        function renderChart(data, suffix) {
             const ctx = document.getElementById('dailyBalanceChart').getContext('2d');
             if (state.chartInstance) { state.chartInstance.destroy(); }
             const gradientInc = ctx.createLinearGradient(0, 0, 0, 200); gradientInc.addColorStop(0, 'rgba(52, 211, 153, 0.8)'); gradientInc.addColorStop(1, 'rgba(52, 211, 153, 0.2)');
             const gradientExp = ctx.createLinearGradient(0, 0, 0, 200); gradientExp.addColorStop(0, 'rgba(251, 113, 133, 0.8)'); gradientExp.addColorStop(1, 'rgba(251, 113, 133, 0.2)');
             state.chartInstance = new Chart(ctx, { type: 'bar', data: { labels: data.map(d => d.label), datasets: [{ label: '净流量', data: data.map(d => d.value), backgroundColor: data.map(d => d.value >= 0 ? gradientInc : gradientExp), borderRadius: 6, barThickness: 'flex', maxBarThickness: 16 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15, 23, 42, 0.9)', padding: 12, cornerRadius: 12, callbacks: { label: (c) => ' ¥' + Math.abs(c.parsed.y).toFixed(2) } } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } }, border: { display: false } }, y: { display: false, grid: { display: false } } } } });
        }

        function renderSummary(data) {
            const balEl = document.getElementById('balanceDisplay'); animateValue(balEl, parseFloat(balEl.innerText.replace(/[¥,]/g,'')) || 0, data.balance);
            document.getElementById('incomeDisplay').innerText = data.totalIncome.toFixed(2); document.getElementById('expenseDisplay').innerText = data.totalExpense.toFixed(2);
            const total = data.totalIncome + data.totalExpense; const incPct = total === 0 ? 0 : (data.totalIncome/total*100); const expPct = total === 0 ? 0 : (data.totalExpense/total*100);
            document.getElementById('barIncome').style.width = incPct + '%'; document.getElementById('barExpense').style.width = expPct + '%';
        }

        function animateValue(obj, start, end) {
            let startTimestamp = null; const duration = 800;
            const step = (timestamp) => { if (!startTimestamp) startTimestamp = timestamp; const progress = Math.min((timestamp - startTimestamp) / duration, 1); const ease = 1 - Math.pow(1 - progress, 4); obj.innerHTML = '¥' + (start + ease * (end - start)).toFixed(2); if (progress < 1) window.requestAnimationFrame(step); }; window.requestAnimationFrame(step);
        }

        function renderList(list) {
            const container = document.getElementById('list');
            if (list.length === 0) { container.innerHTML = '<div class="empty-state">🍃 暂无数据，开始记账吧</div>'; return; }
            const getIcon = (cat) => { const map = {'餐饮':'🍔','购物':'🛍️','交通':'🚗','住房':'🏠','娱乐':'🎮','医疗':'💊','工资':'💰','奖金':'💎','理财':'📈','兼职':'💼','红包':'🧧','其他':'📝','默认':'📝'}; return map[cat] || '📝'; };
            const sortedList = list.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
            const groupedList = sortedList.reduce((groups, item) => { const dateKey = item.timestamp.substring(0, 10); if (!groups[dateKey]) groups[dateKey] = []; groups[dateKey].push(item); return groups; }, {});
            const formatDate = (dateStr) => { const d = new Date(dateStr); const today = new Date(); if (d.toDateString() === today.toDateString()) return '今天'; return (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]; };

            let html = '';
            // 确保日期排序正确
            const sortedDateKeys = Object.keys(groupedList).sort((a, b) => new Date(b) - new Date(a));
            
            sortedDateKeys.forEach((dateKey, index) => {
                const items = groupedList[dateKey]; 
                const dayTotal = items.reduce((sum, t) => sum + (t.type==='income'?parseFloat(t.amount):-parseFloat(t.amount)), 0);
                const groupId = \`group-\${dateKey}\`;
                // 前3个展开，后面的折叠
                const isCollapsed = index >= 3;
                
                html += \`
                <div class="list-group \${isCollapsed ? 'collapsed' : ''}" id="\${groupId}">
                    <div class="list-date-header" onclick="toggleGroup('\${groupId}')">
                        <span>\${formatDate(dateKey)}</span>
                        <span>\${dayTotal > 0 ? '+' : ''}\${dayTotal.toFixed(2)}</span>
                    </div>
                    <div class="group-items">
                        \${items.map(t => \`<div class="t-item" data-id="\${t.id}"><div class="t-content"><div class="t-icon">\${getIcon(t.category)}</div><div class="t-info"><div class="t-name">\${t.description || t.category}</div><div class="t-meta">\${new Date(t.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div></div><div class="t-amt \${t.type === 'income' ? 'amt-in' : 'amt-out'}">\${t.type === 'income' ? '+' : '-'} \${parseFloat(t.amount).toFixed(2)}</div></div></div>\`).join('')}
                    </div>
                </div>\`;
            });
            container.innerHTML = html;
            container.querySelectorAll('.t-item').forEach(item => {
                const content = item.querySelector('.t-content'); let startX = 0; let isDragging = false;
                item.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; content.style.transition = 'none'; }, { passive: true });
                item.addEventListener('touchmove', (e) => { const diff = e.touches[0].clientX - startX; if (diff < 0 && diff > -100) { content.style.transform = \`translateX(\${diff}px)\`; isDragging = true; } }, { passive: true });
                item.addEventListener('touchend', (e) => { content.style.transition = 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)'; const currentOffset = parseInt(content.style.transform.replace('translateX(', '')) || 0; if (currentOffset < -60) { openDeleteModal(item.dataset.id, item, content); } else { content.style.transform = 'translateX(0)'; } isDragging = false; });
            });
        }

        document.getElementById('addForm').onsubmit = async (e) => {
            e.preventDefault(); const btn = e.target.querySelector('button'); btn.disabled = true; btn.innerText = '保存中...';
            try { 
                const res = await fetch('/api/transactions', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ type: state.type, amount: document.getElementById('amount').value, category: document.getElementById('category').value, description: document.getElementById('desc').value }) }); 
                const updatedList = await res.json(); document.getElementById('amount').value = ''; document.getElementById('desc').value = ''; closeAll(); 
                renderList(updatedList); loadSummaryOnly(); refreshChart();
            } catch(e) { alert('保存失败'); } finally { btn.disabled = false; btn.innerText = '确认保存'; }
        };

        function logout() { fetch('/api/auth/logout', {method:'POST'}).then(() => window.location.href = '/login'); }
        init();
    </script>
</body>
</html>`;
}
