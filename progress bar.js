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
            // 确保登录页也包含 PWA 配置
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
  
  // --- 核心逻辑 (省略未修改部分) ---
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
        transaction.id = Date.now().toString();
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
  
  // Service Worker
  function getServiceWorker() {
    return `
  const CACHE_NAME = 'accounting-app-v3';
  const urlsToCache = ['/', '/manifest.json'];
  self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(urlsToCache))));
  self.addEventListener('fetch', e => {
    // 优先从缓存获取，失败则进行网络请求
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  });
  self.addEventListener('activate', e => {
    // 清理旧版本缓存
    e.waitUntil(caches.keys().then(names => Promise.all(names.map(n => n !== CACHE_NAME ? caches.delete(n) : null))));
  });`;
  }
  
  // PWA Manifest (包含内嵌 Base64 图标)
  function getManifest() {
    const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcng9IjEyOCIgZmlsbD0iIzBmMTcyYSIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0yNTYgMTI4bC0zMiA4MEgxMjhsODAgMzItODAgMzJoOTZsMzIgODBMMjg4IDI1Nmg5NmwzMi04MGgtOTZ6Ii8+PC9zdmc+";
    
    return `{
      "name": "极光记账",
      "short_name": "记账",
      "description": "极简高效的个人记账应用",
      "start_url": "/",
      "display": "standalone",
      "background_color": "#0f172a",
      "theme_color": "#0f172a",
      "icons": [
        {
          "src": "\${iconBase64}",
          "sizes": "192x192",
          "type": "image/svg+xml"
        },
        {
          "src": "\${iconBase64}",
          "sizes": "512x512",
          "type": "image/svg+xml"
        }
      ]
    }`;
  }
  
  // 工具函数
  function generateToken() { return Math.random().toString(36).substring(2) + Date.now().toString(36); }
  
  function calculateSummary(transactions, period = 'daily') {
    let income = 0, expense = 0;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const thisWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisYear = new Date(now.getFullYear(), 0, 1);
    
    const filtered = transactions.filter(t => {
      const d = new Date(t.timestamp);
      if (period === 'daily') return d >= today;
      if (period === 'weekly') return d >= thisWeek;
      if (period === 'monthly') return d >= thisMonth;
      if (period === 'yearly') return d >= thisYear;
      return true;
    });
    
    filtered.forEach(t => t.type === 'income' ? income += parseFloat(t.amount) : expense += parseFloat(t.amount));
    return { totalIncome: income, totalExpense: expense, balance: income - expense, transactionCount: filtered.length, period };
  }
  
  // --- 极致美化版 登录页面 (添加 PWA 链接) ---
  function getLoginPageHTML() {
    const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcng9IjEyOCIgZmlsbD0iIzBmMTcyYSIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0yNTYgMTI4bC0zMiA4MEgxMjhsODAgMzItODAgMzJoOTZsMzIgODBMMjg4IDI1Nmg5NmwzMi04MGgtOTZ6Ii8+PC9zdmc+";
    
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
              margin: 0;
              font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              background-color: #000;
              background-image: 
                  radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), 
                  radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%), 
                  radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%);
              color: white;
              overflow: hidden;
          }
  
          /* 动态极光背景 */
          .aurora {
              position: absolute;
              top: -50%;
              left: -50%;
              width: 200%;
              height: 200%;
              background: 
                  conic-gradient(from 0deg at 50% 50%, #1a2a6c 0deg, #b21f1f 120deg, #fdbb2d 240deg, #1a2a6c 360deg);
              filter: blur(80px);
              opacity: 0.3;
              animation: spin 20s linear infinite;
              z-index: -1;
          }
          @keyframes spin { 100% { transform: rotate(360deg); } }
  
          .card {
              background: rgba(255, 255, 255, 0.03);
              backdrop-filter: blur(24px);
              border: 1px solid rgba(255, 255, 255, 0.1);
              padding: 40px;
              border-radius: 32px;
              width: 90%;
              max-width: 360px;
              text-align: center;
              box-shadow: 0 20px 40px rgba(0,0,0,0.4);
              animation: float 6s ease-in-out infinite;
          }
          @keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
  
          .icon { font-size: 48px; margin-bottom: 20px; display: inline-block; filter: drop-shadow(0 0 15px rgba(255,255,255,0.3)); }
          h1 { margin: 0 0 8px 0; font-size: 28px; letter-spacing: -1px; background: linear-gradient(to right, #fff, #bbb); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          p { margin: 0 0 32px 0; color: #888; font-size: 14px; }
  
          input {
              width: 100%;
              padding: 16px;
              border-radius: 16px;
              border: 1px solid rgba(255,255,255,0.1);
              background: rgba(0,0,0,0.3);
              color: white;
              font-size: 16px;
              margin-bottom: 20px;
              outline: none;
              text-align: center;
              transition: 0.3s;
              box-sizing: border-box;
          }
          input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); background: rgba(0,0,0,0.5); }
  
          button {
              width: 100%;
              padding: 16px;
              border-radius: 16px;
              border: none;
              background: white;
              color: black;
              font-size: 16px;
              font-weight: 700;
              cursor: pointer;
              transition: 0.2s;
          }
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
                  const res = await fetch('/api/auth/login', {
                      method: 'POST', body: JSON.stringify({ password: document.getElementById('pwd').value })
                  });
                  if (res.ok) window.location.href = '/';
                  else throw new Error('密码错误');
              } catch (e) {
                  err.innerText = e.message;
                  err.style.display = 'block';
                  btn.innerText = '解锁进入';
                  btn.disabled = false;
              }
          }
      </script>
  </body>
  </html>`;
  }
  
  // --- 极致美化版 主页面 (添加 PWA 链接和 Service Worker 注册) ---
  function getHTML() {
    const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcng9IjEyOCIgZmlsbD0iIzBmMTcyYSIvPjxwYXRoIGZpbGw9IiNmZmYiIGQ9Ik0yNTYgMTI4bC0zMiA4MEgxMjhsODAgMzItODAgMzJoOTZsMzIgODBMMjg4IDI1Nmg5NmwzMi04MGgtOTZ6Ii8+PC9zdmc+";
    
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
              margin: 0;
              font-family: 'Plus Jakarta Sans', system-ui, sans-serif;
              background-color: var(--bg);
              color: var(--text);
              min-height: 100vh;
              padding-bottom: 40px;
              /* Mesh Gradient Background */
              background-image: 
                  radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), 
                  radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%), 
                  radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%);
              background-attachment: fixed;
          }
  
          /* 背景光斑动画 */
          .glow-spot {
              position: fixed;
              width: 300px;
              height: 300px;
              background: var(--primary);
              filter: blur(100px);
              opacity: 0.15;
              border-radius: 50%;
              z-index: -1;
              pointer-events: none;
              animation: moveSpot 10s infinite alternate;
          }
          @keyframes moveSpot { from { transform: translate(0,0); } to { transform: translate(50px, 50px); } }
  
          .container {
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
          }
  
          /* Header */
          header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 20px 0;
              margin-bottom: 20px;
          }
          .brand { font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
          .logout-btn {
              background: rgba(255,255,255,0.1);
              border: 1px solid var(--glass-border);
              color: var(--text-muted);
              padding: 8px 16px;
              border-radius: 20px;
              font-size: 12px;
              cursor: pointer;
              transition: 0.3s;
          }
          .logout-btn:hover { background: rgba(255,255,255,0.2); color: white; }
  
          /* Period Tabs */
          .tabs {
              display: flex;
              background: rgba(0,0,0,0.2);
              padding: 4px;
              border-radius: 16px;
              margin-bottom: 24px;
              border: 1px solid var(--glass-border);
          }
          .tab {
              flex: 1;
              text-align: center;
              padding: 10px;
              font-size: 13px;
              color: var(--text-muted);
              border-radius: 12px;
              cursor: pointer;
              transition: all 0.3s ease;
          }
          .tab.active {
              background: rgba(255,255,255,0.1);
              color: white;
              font-weight: 600;
              box-shadow: 0 4px 12px rgba(0,0,0,0.2);
          }
  
          /* Summary Card */
          .summary-card {
              background: linear-gradient(135deg, rgba(99,102,241,0.1) 0%, rgba(168,85,247,0.1) 100%);
              backdrop-filter: blur(20px);
              border-radius: 28px;
              padding: 30px;
              border: 1px solid rgba(255,255,255,0.1);
              box-shadow: 0 20px 40px -10px rgba(0,0,0,0.3);
              margin-bottom: 30px;
              position: relative;
              overflow: hidden;
          }
          .summary-card::before {
              content: '';
              position: absolute;
              top: 0; left: 0; right: 0; height: 1px;
              background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent);
          }
          
          .balance-label { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
          .balance-amount { font-family: 'JetBrains Mono', monospace; font-size: 36px; font-weight: 700; margin-bottom: 24px; letter-spacing: -1px; }
          
          /* Visual Bar */
          .progress-bar {
              height: 8px;
              background: rgba(255,255,255,0.1);
              border-radius: 4px;
              overflow: hidden;
              margin-bottom: 20px;
              display: flex;
          }
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
          .input-area {
              background: var(--card-bg);
              backdrop-filter: blur(20px);
              border-radius: 24px;
              padding: 24px;
              border: 1px solid var(--glass-border);
              margin-bottom: 30px;
          }
          .input-header { font-size: 16px; font-weight: 600; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
          
          /* Custom Switch */
          .type-switch {
              display: flex;
              gap: 10px;
              margin-bottom: 20px;
          }
          .type-btn {
              flex: 1;
              padding: 12px;
              border-radius: 14px;
              border: 1px solid var(--glass-border);
              background: rgba(255,255,255,0.03);
              color: var(--text-muted);
              font-weight: 600;
              cursor: pointer;
              transition: 0.3s;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 6px;
          }
          .type-btn.active.income { background: rgba(16, 185, 129, 0.2); border-color: var(--success); color: var(--success); }
          .type-btn.active.expense { background: rgba(244, 63, 94, 0.2); border-color: var(--danger); color: var(--danger); }
  
          .form-group { position: relative; margin-bottom: 16px; }
          .form-input {
              width: 100%;
              padding: 16px;
              background: rgba(0,0,0,0.2);
              border: 1px solid var(--glass-border);
              border-radius: 14px;
              color: white;
              font-size: 16px;
              outline: none;
              transition: 0.3s;
              box-sizing: border-box; /* Fix width overflow */
          }
          .form-input:focus { border-color: var(--primary); background: rgba(0,0,0,0.4); }
          
          .submit-btn {
              width: 100%;
              padding: 16px;
              background: white;
              color: black;
              border: none;
              border-radius: 16px;
              font-size: 16px;
              font-weight: 700;
              cursor: pointer;
              margin-top: 8px;
              transition: transform 0.2s;
          }
          .submit-btn:active { transform: scale(0.98); }
  
          /* Transaction List */
          .list-header { font-size: 14px; color: var(--text-muted); margin-bottom: 12px; margin-left: 4px; }
          .transaction-list { display: flex; flex-direction: column; gap: 12px; padding-bottom: 40px; }
          
          .t-item {
              background: var(--card-bg);
              border: 1px solid var(--glass-border);
              border-radius: 18px;
              padding: 16px;
              display: flex;
              align-items: center;
              animation: slideIn 0.4s ease-out forwards;
              opacity: 0;
              transform: translateY(10px);
          }
          @keyframes slideIn { to { opacity: 1; transform: translateY(0); } }
  
          .t-icon {
              width: 44px;
              height: 44px;
              border-radius: 14px;
              background: rgba(255,255,255,0.05);
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 20px;
              margin-right: 16px;
              flex-shrink: 0;
          }
          .t-details { flex: 1; min-width: 0; }
          .t-title { font-weight: 600; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .t-meta { font-size: 12px; color: var(--text-muted); }
          .t-amount { font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 16px; text-align: right; margin-left: 10px; }
          
          .del-btn {
              background: transparent;
              border: none;
              color: var(--text-muted);
              padding: 8px;
              margin-left: 8px;
              cursor: pointer;
              opacity: 0.5;
              transition: 0.3s;
          }
          .del-btn:hover { opacity: 1; color: var(--danger); transform: scale(1.1); }
          
          .empty-state { text-align: center; padding: 40px; color: var(--text-muted); }
  
          /* Mobile optimization */
          @media (max-width: 480px) {
              .container { padding: 16px; }
              .balance-amount { font-size: 32px; }
              .summary-card { padding: 24px; }
          }
      </style>
  </head>
  <body>
      <div class="glow-spot" style="top: 10%; left: 0;"></div>
      <div class="glow-spot" style="bottom: 10%; right: 0; background: var(--danger);"></div>
  
      <div class="container">
          <header>
              <div class="brand">✨ 极光记账</div>
              <button class="logout-btn" onclick="logout()">退出登录</button>
          </header>
  
          <div class="tabs">
              <div class="tab active" onclick="setPeriod('daily', this)">今日</div>
              <div class="tab" onclick="setPeriod('weekly', this)">本周</div>
              <div class="tab" onclick="setPeriod('monthly', this)">本月</div>
              <div class="tab" onclick="setPeriod('yearly', this)">今年</div>
          </div>
  
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
  
          <div class="input-area">
              <div class="input-header">📝 记一笔</div>
              <form id="addForm">
                  <div class="type-switch">
                      <div class="type-btn active income" id="btnIncome" onclick="setType('income')">↓ 收入</div>
                      <div class="type-btn" id="btnExpense" onclick="setType('expense')">↑ 支出</div>
                  </div>
                  
                  <div style="display:flex; gap:12px; margin-bottom:12px;">
                      <div style="flex:1">
                          <input type="number" id="amount" class="form-input" placeholder="金额 0.00" step="0.01" required style="font-family:'JetBrains Mono'">
                      </div>
                      <div style="flex:1">
                          <select id="category" class="form-input" required style="-webkit-appearance:none;">
                              <option value="默认">分类</option>
                          </select>
                      </div>
                  </div>
                  
                  <div class="form-group">
                      <input type="text" id="desc" class="form-input" placeholder="备注 (选填)">
                  </div>
                  
                  <button type="submit" class="submit-btn">确认添加</button>
              </form>
          </div>
  
          <div class="list-header">近期明细 · RECENT</div>
          <div id="list" class="transaction-list">
              <div class="empty-state">加载中...</div>
          </div>
      </div>
  
      <script>
          // 状态管理
          let state = {
              type: 'income',
              period: 'daily',
              categories: {
                  expense: ['餐饮 🍔', '购物 🛍️', '交通 🚗', '住房 🏠', '娱乐 🎮', '医疗 💊', '其他 📝'],
                  income: ['工资 💰', '奖金 💎', '理财 📈', '兼职 💼', '红包 🧧', '其他 📝']
              }
          };
  
          // 初始化
          function init() {
              updateCategoryOptions();
              loadData();
              
              // 注册 Service Worker
              if ('serviceWorker' in navigator) {
                  window.addEventListener('load', () => {
                      navigator.serviceWorker.register('/sw.js')
                      .then(reg => console.log('Service Worker registered: ', reg))
                      .catch(err => console.log('Service Worker registration failed: ', err));
                  });
              }
          }
  
          // 切换收支类型
          function setType(type) {
              state.type = type;
              document.getElementById('btnIncome').className = \`type-btn \${type === 'income' ? 'active income' : ''}\`;
              document.getElementById('btnExpense').className = \`type-btn \${type === 'expense' ? 'active expense' : ''}\`;
              updateCategoryOptions();
          }
  
          // 更新分类选项
          function updateCategoryOptions() {
              const select = document.getElementById('category');
              select.innerHTML = '';
              state.categories[state.type].forEach(c => {
                  const opt = document.createElement('option');
                  opt.value = c.split(' ')[0]; // 只存文字
                  opt.textContent = c;
                  select.appendChild(opt);
              });
          }
  
          // 切换时间周期
          function setPeriod(period, el) {
              state.period = period;
              document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
              el.classList.add('active');
              loadData();
          }
  
          // 加载数据
          async function loadData() {
              try {
                  const [txRes, sumRes] = await Promise.all([
                      fetch('/api/transactions'),
                      fetch('/api/summary?period=' + state.period)
                  ]);
                  
                  const transactions = await txRes.json();
                  const summary = await sumRes.json();
                  
                  renderSummary(summary);
                  renderList(transactions);
              } catch (e) { console.error(e); }
          }
  
          // 渲染统计卡片
          function renderSummary(data) {
              const balEl = document.getElementById('balanceDisplay');
              // 数字滚动动画
              animateValue(balEl, parseFloat(balEl.innerText.replace('¥','')) || 0, data.balance);
              
              document.getElementById('incomeDisplay').innerText = '+' + data.totalIncome.toFixed(2);
              document.getElementById('expenseDisplay').innerText = '-' + data.totalExpense.toFixed(2);
  
              // 进度条逻辑
              const total = data.totalIncome + data.totalExpense;
              if (total === 0) {
                  document.getElementById('barIncome').style.width = '0%';
                  document.getElementById('barExpense').style.width = '0%';
              } else {
                  const incPct = (data.totalIncome / total) * 100;
                  const expPct = (data.totalExpense / total) * 100;
                  document.getElementById('barIncome').style.width = incPct + '%';
                  document.getElementById('barExpense').style.width = expPct + '%';
              }
          }
  
          // 简易数字动画
          function animateValue(obj, start, end) {
              let startTimestamp = null;
              const duration = 500;
              const step = (timestamp) => {
                  if (!startTimestamp) startTimestamp = timestamp;
                  const progress = Math.min((timestamp - startTimestamp) / duration, 1);
                  obj.innerHTML = '¥' + (start + progress * (end - start)).toFixed(2);
                  if (progress < 1) window.requestAnimationFrame(step);
              };
              window.requestAnimationFrame(step);
          }
  
          // 渲染列表
          function renderList(list) {
              const container = document.getElementById('list');
              if (list.length === 0) {
                  container.innerHTML = '<div class="empty-state">🍃 暂无数据，开始记账吧</div>';
                  return;
              }
              
              // 简单的图标匹配
              const getIcon = (cat) => {
                  const map = {'餐饮':'🍔','购物':'🛍️','交通':'🚗','住房':'🏠','娱乐':'🎮','医疗':'💊','工资':'💰','奖金':'💎','理财':'📈','兼职':'💼','红包':'🧧'};
                  return map[cat] || '📝';
              };
  
              container.innerHTML = list.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).map((t, index) => \`
                  <div class="t-item" style="animation-delay: \${index * 0.05}s">
                      <div class="t-icon">\${getIcon(t.category)}</div>
                      <div class="t-details">
                          <div class="t-title">\${t.description || t.category}</div>
                          <div class="t-meta">\${new Date(t.timestamp).toLocaleDateString()} · \${t.category}</div>
                      </div>
                      <div class="t-amount" style="color: \${t.type === 'income' ? 'var(--success)' : 'var(--danger)'}">
                          \${t.type === 'income' ? '+' : '-'} \${parseFloat(t.amount).toFixed(2)}
                      </div>
                      <button class="del-btn" onclick="deleteItem('\${t.id}')">✕</button>
                  </div>
              \`).join('');
          }
  
          // 提交表单
          document.getElementById('addForm').onsubmit = async (e) => {
              e.preventDefault();
              const btn = e.target.querySelector('button');
              btn.disabled = true;
              btn.innerText = '保存中...';
  
              try {
                  await fetch('/api/transactions', {
                      method: 'POST',
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({
                          type: state.type,
                          amount: document.getElementById('amount').value,
                          category: document.getElementById('category').value,
                          description: document.getElementById('desc').value
                      })
                  });
                  document.getElementById('amount').value = '';
                  document.getElementById('desc').value = '';
                  await loadData();
              } catch(e) { alert('保存失败'); } 
              finally { btn.disabled = false; btn.innerText = '确认添加'; }
          };
  
          async function deleteItem(id) {
              if(!confirm('确定删除这条记录吗？')) return;
              await fetch('/api/transactions/' + id, { method: 'DELETE' });
              loadData();
          }
  
          function logout() {
              fetch('/api/auth/logout', {method:'POST'}).then(() => window.location.href = '/login');
          }
  
          init();
      </script>
  </body>
  </html>`;
  }
