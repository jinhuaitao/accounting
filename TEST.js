export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
  
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };
  
      if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  
      try {
        if (path === '/manifest.json') return serveJSON(getManifest(), { 'Cache-Control': 'public, max-age=3600' });
        if (path === '/sw.js') return serveJS(getServiceWorker(), { 'Cache-Control': 'no-cache' });
  
        const isAuthRoute = path === '/login' || path.startsWith('/api/auth');
        
        if (!isAuthRoute) {
          const isAuthenticated = await checkAuthentication(request, env);
          if (!isAuthenticated) {
            if (path.startsWith('/api/')) {
               return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }
            return new Response(getLoginPageHTML(), { status: 302, headers: { 'Content-Type': 'text/html', ...corsHeaders } });
          }
        }
  
        if (path === '/') return new Response(getHTML(), { headers: { 'Content-Type': 'text/html', ...corsHeaders } });
        if (path === '/login') return new Response(getLoginPageHTML(), { headers: { 'Content-Type': 'text/html', ...corsHeaders } });
  
        if (path.startsWith('/api/')) {
          const response = await handleAPIRequest(request, env, path, method);
          Object.entries(corsHeaders).forEach(([key, value]) => response.headers.set(key, value));
          return response;
        }
  
        return new Response('Not Found', { status: 404 });
      } catch (error) {
        console.error(error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    },
  };
  
  const serveJSON = (data, extraHeaders = {}) => new Response(typeof data === 'string' ? data : JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...extraHeaders } });
  const serveJS = (data, extraHeaders = {}) => new Response(data, { headers: { 'Content-Type': 'application/javascript', ...extraHeaders } });
  
  function getBJTDate(timestamp = Date.now()) { return new Date(timestamp + 8 * 60 * 60 * 1000); }
  function generateUUID() { return crypto.randomUUID(); }
  
  // --- 核心修改：带迁移功能的 R2 读取 ---
  async function getR2Data(env, userId) {
      const r2Key = `transactions_${userId}.json`;
      const kvKey = `transactions_${userId}`; // 旧 KV 里的 Key
  
      // 1. 先尝试从 R2 读取
      const object = await env.ACCOUNTING_R2.get(r2Key);
      
      // 2. 如果 R2 有数据，直接返回
      if (object !== null) {
          return await object.json();
      }
  
      // 3. 如果 R2 为空，尝试从 KV 迁移数据 (自动救援)
      console.log("R2 is empty, checking KV for migration...");
      const kvData = await env.ACCOUNTING_KV.get(kvKey, 'json');
      
      if (kvData && Array.isArray(kvData) && kvData.length > 0) {
          // 4. 发现 KV 有旧数据，保存到 R2
          await env.ACCOUNTING_R2.put(r2Key, JSON.stringify(kvData), {
              httpMetadata: { contentType: 'application/json' }
          });
          console.log("Migration successful: KV -> R2");
          return kvData; // 返回找回的数据
      }
  
      // 4. 都没有，确实是新用户
      return [];
  }
  
  async function saveR2Data(env, userId, data) {
      const key = `transactions_${userId}.json`;
      await env.ACCOUNTING_R2.put(key, JSON.stringify(data), {
          httpMetadata: { contentType: 'application/json' }
      });
  }
  
  // --- 鉴权逻辑 ---
  async function checkAuthentication(request, env) {
    const cookieHeader = request.headers.get('Cookie') || '';
    const token = parseCookie(cookieHeader, 'auth_token');
    if (token) {
      const session = await env.ACCOUNTING_KV.get(`session_${token}`);
      return session !== null;
    }
    return false;
  }
  
  function parseCookie(cookieHeader, name) {
      const match = cookieHeader.match(new RegExp('(^| )' + name + '=([^;]+)'));
      return match ? match[2] : null;
  }
  
  // --- API 处理器 ---
  async function handleAPIRequest(request, env, path, method) {
    const kv = env.ACCOUNTING_KV;
    const userId = 'default_user'; 
  
    if (path === '/api/auth/login' && method === 'POST') {
      const { password } = await request.json();
      const correctPassword = env.ADMIN_PASSWORD || await kv.get('app_password');
      if (password === correctPassword) {
        const token = generateUUID();
        await kv.put(`session_${token}`, JSON.stringify({ userId, loginAt: Date.now() }), { expirationTtl: 2592000 });
        return new Response(JSON.stringify({ success: true, token }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Set-Cookie': `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` },
        });
      }
      return new Response(JSON.stringify({ error: '密码错误' }), { status: 401 });
    }
  
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = parseCookie(request.headers.get('Cookie') || '', 'auth_token');
      if (token) await kv.delete(`session_${token}`);
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Set-Cookie': 'auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' } });
    }
  
    if (path === '/api/transactions') {
      if (method === 'GET') {
        const transactions = await getR2Data(env, userId);
        return serveJSON(transactions);
      }
      if (method === 'POST') {
        const body = await request.json();
        if (!body.amount || isNaN(body.amount)) return new Response('Invalid Amount', { status: 400 });
        const transaction = {
          id: generateUUID(),
          type: body.type, 
          amount: parseFloat(body.amount),
          category: body.category || '其他',
          description: body.description || '',
          timestamp: new Date().toISOString()
        };
        const transactions = await getR2Data(env, userId);
        transactions.push(transaction);
        await saveR2Data(env, userId, transactions);
        return serveJSON(transactions);
      }
    }
  
    if (path.startsWith('/api/transactions/') && method === 'DELETE') {
      const transactionId = path.split('/').pop();
      let transactions = await getR2Data(env, userId);
      const initialLen = transactions.length;
      transactions = transactions.filter(t => t.id !== transactionId);
      if (transactions.length !== initialLen) {
          await saveR2Data(env, userId, transactions);
      }
      return serveJSON(transactions);
    }
  
    const transactions = await getR2Data(env, userId);
  
    if (path === '/api/daily_balance') {
        const url = new URL(request.url);
        const targetYear = parseInt(url.searchParams.get('year') || new Date().getFullYear());
        const targetMonth = parseInt(url.searchParams.get('month') || new Date().getMonth() + 1);
        return serveJSON(calculateDailyBalances(transactions, targetYear, targetMonth));
    }
    
    if (path === '/api/monthly_balance') {
      const url = new URL(request.url);
      const targetYear = parseInt(url.searchParams.get('year') || new Date().getFullYear());
      return serveJSON(calculateMonthlyNetFlow(transactions, targetYear));
    }
    
    if (path === '/api/weekly_balance') return serveJSON(calculateWeeklyNetFlow(transactions));
  
    if (path === '/api/summary') {
      const url = new URL(request.url);
      const period = url.searchParams.get('period') || 'daily';
      return serveJSON(calculateSummary(transactions, period));
    }
  
    return new Response('API Not Found', { status: 404 });
  }
  
  // --- 统计逻辑 ---
  function calculateDailyBalances(transactions, targetYear, targetMonth) {
      const monthlyTrans = transactions.filter(t => {
          const bjtDate = new Date(new Date(t.timestamp).getTime() + 8*3600*1000);
          return bjtDate.getUTCFullYear() === targetYear && (bjtDate.getUTCMonth() + 1) === targetMonth;
      });
      const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
      const dailyMap = new Array(daysInMonth).fill(0);
      monthlyTrans.forEach(t => {
          const bjtDate = new Date(new Date(t.timestamp).getTime() + 8*3600*1000);
          const dayIdx = bjtDate.getUTCDate() - 1;
          if (dayIdx >= 0 && dayIdx < daysInMonth) dailyMap[dayIdx] += (t.type === 'income' ? t.amount : -t.amount);
      });
      const todayBJT = getBJTDate();
      const isCurrentMonth = targetYear === todayBJT.getUTCFullYear() && targetMonth === (todayBJT.getUTCMonth() + 1);
      const currentDay = todayBJT.getUTCDate();
      return dailyMap.map((bal, idx) => {
          const day = idx + 1;
          if (isCurrentMonth && day > currentDay) return null;
          return { day, balance: bal };
      }).filter(item => item !== null);
  }
  
  function calculateMonthlyNetFlow(transactions, targetYear) {
      const monthlyMap = new Array(12).fill(0);
      transactions.forEach(t => {
          const bjtDate = new Date(new Date(t.timestamp).getTime() + 8*3600*1000);
          if (bjtDate.getUTCFullYear() === targetYear) monthlyMap[bjtDate.getUTCMonth()] += (t.type === 'income' ? t.amount : -t.amount);
      });
      const todayBJT = getBJTDate();
      const isCurrentYear = targetYear === todayBJT.getUTCFullYear();
      const currentMonth = todayBJT.getUTCMonth();
      return monthlyMap.map((bal, idx) => {
          if (isCurrentYear && idx > currentMonth) return null;
          return { month: idx + 1, balance: bal };
      }).filter(Boolean);
  }
  
  function calculateWeeklyNetFlow(transactions) {
      const now = getBJTDate();
      const dayOfWeek = now.getUTCDay(); 
      const distToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(now); monday.setUTCDate(now.getUTCDate() + distToMon); monday.setUTCHours(0,0,0,0);
      const nextMonday = new Date(monday); nextMonday.setUTCDate(monday.getUTCDate() + 7);
      const weekData = ['一','二','三','四','五','六','日'].map(d => ({ day: d, balance: 0 }));
      transactions.forEach(t => {
          const tTime = new Date(t.timestamp).getTime() + 8*3600*1000;
          if (tTime >= monday.getTime() && tTime < nextMonday.getTime()) {
              let dayIdx = new Date(tTime).getUTCDay(); 
              dayIdx = dayIdx === 0 ? 6 : dayIdx - 1;
              weekData[dayIdx].balance += (t.type === 'income' ? t.amount : -t.amount);
          }
      });
      const currentDayIdx = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      return weekData.map((d, i) => { if (i > currentDayIdx) return { ...d, balance: 0 }; return d; });
  }
  
  function calculateSummary(transactions, period) {
      let income = 0, expense = 0;
      const now = getBJTDate();
      const getStartTimestamp = () => {
          const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
          if (period === 'daily') return Date.UTC(y, m, d) - 8*3600*1000;
          if (period === 'weekly') {
              const day = now.getUTCDay();
              const diff = now.getUTCDate() - day + (day == 0 ? -6 : 1);
              return Date.UTC(y, m, diff) - 8*3600*1000;
          }
          if (period === 'monthly') return Date.UTC(y, m, 1) - 8*3600*1000;
          if (period === 'yearly') return Date.UTC(y, 0, 1) - 8*3600*1000;
          return 0;
      };
      const startTime = getStartTimestamp();
      const filtered = transactions.filter(t => new Date(t.timestamp).getTime() >= startTime);
      filtered.forEach(t => { if (t.type === 'income') income += t.amount; else expense += t.amount; });
      return { totalIncome: income, totalExpense: expense, balance: income - expense, transactionCount: filtered.length, period };
  }
  
  // --- 资源生成 ---
  function getServiceWorker() {
    const CACHE_NAME = 'aurora-v31-migrator'; 
    return `
  const CACHE_NAME = '${CACHE_NAME}';
  const ASSETS = ['/manifest.json','https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js','https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap'];
  self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
  self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null))).then(() => self.clients.claim())); });
  self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (url.pathname.startsWith('/api/')) {
      e.respondWith(fetch(e.request).then(res => { const clone = res.clone(); if(res.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, clone)); return res; }).catch(() => caches.match(e.request)));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/login') {
       e.respondWith(caches.match(e.request).then(cached => { const networkFetch = fetch(e.request).then(res => { caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone())); return res; }); return cached || networkFetch; }));
       return;
    }
    e.respondWith(caches.match(e.request).then(res => res || fetch(e.request)));
  });`;
  }
  
  function getManifest() {
    const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjUxMiIgeTI9IjUxMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzYzNjZmMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2E4NTVmNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiByeD0iMTI4IiBmaWxsPSJ1cmwoI2EpIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI1NiAxMjhsLTMyIDgwSDEyOGw4MCAzMi04MCAzMmg5NmwzMiA4MEwyNTYgNDAwTDI4OCAyNTZoOTZsMzItODBoLTk2ek0yNTYgMTkybDMyIDgwaDk2bDMyLTgwaC05NnoiLz48L3N2Zz4=";
    return {
      id: "aurora-accounting-app", name: "极光记账", short_name: "极光", description: "极简高效的个人记账应用", start_url: "/", scope: "/", display: "standalone", background_color: "#020617", theme_color: "#020617", orientation: "portrait",
      icons: [{ src: iconBase64, sizes: "192x192", type: "image/svg+xml", purpose: "any maskable" }, { src: iconBase64, sizes: "512x512", type: "image/svg+xml", purpose: "any maskable" }],
      categories: ["finance"], shortcuts: [{ name: "记一笔", url: "/?add=true", icons: [{ src: iconBase64, sizes: "96x96", purpose: "any maskable" }] }]
    };
  }
  
  function getLoginPageHTML() {
      const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjUxMiIgeTI9IjUxMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzYzNjZmMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2E4NTVmNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiByeD0iMTI4IiBmaWxsPSJ1cmwoI2EpIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI1NiAxMjhsLTMyIDgwSDEyOGw4MCAzMi04MCAzMmg5NmwzMiA4MEwyNTYgNDAwTDI4OCAyNTZoOTZsMzItODBoLTk2ek0yNTYgMTkybDMyIDgwaDk2bDMyLTgwaC05NnoiLz48L3N2Zz4=";
      return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><title>登录 - 极光记账</title><meta name="theme-color" content="#020617"><link rel="manifest" href="/manifest.json"><link rel="apple-touch-icon" href="${iconBase64}"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet"><style>:root{--primary:#8b5cf6;--bg:#020617;--text:#f8fafc}body{margin:0;font-family:'Plus Jakarta Sans',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background-color:var(--bg);color:var(--text);overflow:hidden;position:relative}.aurora-bg{position:absolute;width:150%;height:150%;top:-25%;left:-25%;z-index:-1;background:radial-gradient(at 0% 0%,hsla(253,16%,7%,1) 0,transparent 50%),radial-gradient(at 50% 0%,hsla(225,39%,30%,1) 0,transparent 50%),radial-gradient(at 100% 0%,hsla(339,49%,30%,1) 0,transparent 50%);filter:blur(60px);opacity:.6;animation:aurora-spin 20s linear infinite}@keyframes aurora-spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}.card{background:rgba(30,41,59,.3);backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);border:1px solid rgba(255,255,255,.1);padding:56px 40px;border-radius:40px;width:85%;max-width:380px;text-align:center;box-shadow:0 40px 80px -12px rgba(0,0,0,.6),inset 0 0 0 1px rgba(255,255,255,.05);animation:floatIn .8s cubic-bezier(.2,.8,.2,1);position:relative;overflow:hidden}.card::before{content:'';position:absolute;top:0;left:-100%;width:100%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.05),transparent);transition:.5s;pointer-events:none}.card:hover::before{left:100%;transition:.8s ease-in-out}@keyframes floatIn{from{opacity:0;transform:translateY(30px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}.logo-img{width:88px;height:88px;margin-bottom:32px;filter:drop-shadow(0 0 30px rgba(139,92,246,.4));border-radius:24px;transition:transform .5s ease}.card:hover .logo-img{transform:scale(1.05) rotate(3deg)}h1{margin:0 0 12px 0;font-size:32px;font-weight:800;color:#fff;letter-spacing:-1px;background:linear-gradient(to right,#fff,#c4b5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent}p{margin:0 0 48px 0;color:#94a3b8;font-size:15px;font-weight:500}.input-group{position:relative;margin-bottom:24px}input{width:100%;padding:20px 24px;border-radius:24px;border:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.2);color:#fff;font-size:18px;letter-spacing:4px;outline:0;text-align:center;transition:.3s cubic-bezier(.4,0,.2,1);box-sizing:border-box;font-family:'Plus Jakarta Sans',monospace}input::placeholder{font-size:16px;letter-spacing:normal;opacity:.4;font-family:'Plus Jakarta Sans',sans-serif}input:focus{border-color:rgba(139,92,246,.5);background:rgba(0,0,0,.4);box-shadow:0 0 0 4px rgba(139,92,246,.15);transform:translateY(-2px)}button{width:100%;padding:20px;border-radius:24px;border:none;background:linear-gradient(135deg,#6366f1,#a855f7,#ec4899);background-size:200% 200%;animation:gradient-anim 5s ease infinite;color:#fff;font-size:16px;font-weight:700;cursor:pointer;transition:all .3s;box-shadow:0 10px 25px -10px rgba(99,102,241,.6)}@keyframes gradient-anim{0%{background-position:0 50%}50%{background-position:100% 50%}100%{background-position:0 50%}}button:hover{transform:translateY(-3px);box-shadow:0 20px 40px -10px rgba(99,102,241,.7)}button:active{transform:scale(.97)}button:disabled{opacity:.7;cursor:not-allowed;transform:none}.error{color:#f43f5e;font-size:14px;margin-bottom:24px;display:none;background:rgba(244,63,94,.15);padding:12px;border-radius:16px;animation:shake .5s cubic-bezier(.36,.07,.19,.97) both}@keyframes shake{10%,90%{transform:translate3d(-1px,0,0)}20%,80%{transform:translate3d(2px,0,0)}30%,50%,70%{transform:translate3d(-4px,0,0)}40%,60%{transform:translate3d(4px,0,0)}}</style></head><body><div class="aurora-bg"></div><div class="card"><img src="${iconBase64}" class="logo-img" alt="Logo"><h1>Welcome Back</h1><p>安全访问您的个人账本</p><div id="error" class="error"></div><form id="form"><div class="input-group"><input type="password" id="pwd" placeholder="输入密码" required></div><button type="submit" id="btn">解锁进入</button></form></div><script>document.getElementById('form').onsubmit=async e=>{e.preventDefault();const t=document.getElementById('btn'),r=document.getElementById('error');r.style.display='none';const n=t.innerText;t.innerText='验证中...',t.disabled=!0;try{const a=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pwd').value})});if(a.ok){t.innerText='验证成功',window.location.href='/';return}const s=await a.json();throw new Error(s.error||'登录失败')}catch(e){r.innerText=e.message,r.style.display='block',t.innerText=n,t.disabled=!1,document.getElementById('pwd').value='',document.getElementById('pwd').focus()}};</script></body></html>`;
  }
  
  function getHTML() {
    const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjUxMiIgeTI9IjUxMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzYzNjZmMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2E4NTVmNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiByeD0iMTI4IiBmaWxsPSJ1cmwoI2EpIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI1NiAxMjhsLTMyIDgwSDEyOGw4MCAzMi04MCAzMmg5NmwzMiA4MEwyNTYgNDAwTDI4OCAyNTZoOTZsMzItODBoLTk2ek0yNTYgMTkybDMyIDgwaDk2bDMyLTgwaC05NnoiLz48L3N2Zz4=";
    
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
          :root { 
              --primary: #7c3aed; --success: #34d399; --danger: #fb7185; 
              --bg: #020617; --card-glass: rgba(30, 41, 59, 0.4); --border-glass: rgba(255, 255, 255, 0.08); 
              --text: #f8fafc; --text-muted: #94a3b8; --text-highlight: #fff;
              --input-bg: rgba(255,255,255,0.03); --input-border: rgba(255,255,255,0.05);
              --dock-bg: rgba(15, 23, 42, 0.85); --dock-border: rgba(255,255,255,0.1);
              --safe-bottom: env(safe-area-inset-bottom, 20px); 
          }
          
          /* Light Theme Override (Plain/Simple Style) */
          body.light-mode {
              --bg: #f8fafc; --card-glass: rgba(255, 255, 255, 0.85); --border-glass: rgba(0, 0, 0, 0.05);
              --text: #0f172a; --text-muted: #64748b; --text-highlight: #334155;
              --input-bg: rgba(0,0,0,0.03); --input-border: rgba(0,0,0,0.06);
              --dock-bg: rgba(255, 255, 255, 0.85); --dock-border: rgba(0,0,0,0.05);
              background-image: none; background-color: #f1f5f9;
          }
  
          * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; user-select: none; }
          body { margin: 0; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; background-color: var(--bg); color: var(--text); min-height: 100vh; padding-bottom: calc(90px + var(--safe-bottom)); background-image: radial-gradient(circle at 15% 10%, rgba(99, 102, 241, 0.18), transparent 45%), radial-gradient(circle at 85% 30%, rgba(236, 72, 153, 0.15), transparent 45%), radial-gradient(circle at 50% 90%, rgba(124, 58, 237, 0.15), transparent 50%); background-attachment: fixed; background-size: 100% 100%; transition: background-color 0.3s ease; }
          
          .glass { background: var(--card-glass); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid var(--border-glass); transition: background 0.3s, border 0.3s; }
          
          header { display: flex; justify-content: space-between; align-items: center; padding: 24px 6px 16px; }
          .brand { font-size: 20px; font-weight: 800; display: flex; align-items: center; gap: 12px; letter-spacing: -0.5px; }
          .brand span { background: linear-gradient(to right, var(--text), var(--text-muted)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          .brand img { width: 32px; height: 32px; border-radius: 10px; box-shadow: 0 4px 12px rgba(99,102,241,0.3); }
          
          .header-actions { display: flex; gap: 8px; align-items: center; }
          .action-btn { background: rgba(128,128,128,0.1); border: 1px solid var(--border-glass); color: var(--text-muted); padding: 8px 12px; border-radius: 99px; font-size: 12px; font-weight: 600; cursor: pointer; transition: 0.3s; display: flex; align-items: center; justify-content: center; }
          .action-btn:hover { background: rgba(128,128,128,0.2); color: var(--text); }
          
          .container { max-width: 600px; margin: 0 auto; padding: 0 20px; }
          .summary-card { border-radius: 36px; padding: 36px 28px; margin-bottom: 36px; position: relative; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.1); }
          body:not(.light-mode) .summary-card::before { content: ''; position: absolute; inset: 0; background: linear-gradient(120deg, rgba(255,255,255,0.03) 0%, transparent 40%, rgba(255,255,255,0.03) 60%); pointer-events: none; }
          
          .balance-label { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; opacity: 0.7; }
          .balance-amount { font-family: 'JetBrains Mono', monospace; font-size: 48px; font-weight: 700; margin-bottom: 36px; letter-spacing: -2px; color: var(--text); filter: drop-shadow(0 2px 10px rgba(0,0,0,0.05)); }
          
          .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
          .stat-box { background: rgba(128,128,128,0.05); border-radius: 24px; padding: 20px; display: flex; flex-direction: column; border: 1px solid var(--border-glass); transition: transform 0.2s; }
          .stat-box:active { transform: scale(0.98); }
          .stat-icon-bg { width: 36px; height: 36px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 16px; margin-bottom: 12px; }
          .income .stat-icon-bg { background: rgba(52, 211, 153, 0.15); color: var(--success); }
          .expense .stat-icon-bg { background: rgba(251, 113, 133, 0.15); color: var(--danger); }
          .stat-title { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; font-weight: 600; }
          .stat-val { font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 600; color: var(--text); letter-spacing: -0.5px; }
          
          .progress-wrapper { height: 8px; background: rgba(128,128,128,0.1); border-radius: 99px; overflow: hidden; margin-top: 28px; display: flex; padding: 2px; }
          .p-bar { height: 100%; border-radius: 99px; transition: width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1); }
          .p-inc { background: linear-gradient(90deg, #34d399, #10b981); }
          .p-exp { background: linear-gradient(90deg, #fb7185, #f43f5e); }
          
          #dailyChartContainer { margin-bottom: 24px; height: 200px; width: 100%; }
          .list-header-row { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; padding: 0 8px; }
          .list-title { font-size: 18px; font-weight: 700; color: var(--text); }
          .list-subtitle { font-size: 12px; color: var(--text-muted); font-weight: 500; }
          
          .list-date-header { font-size: 12px; color: var(--text-muted); font-weight: 700; padding: 8px 16px; border-radius: 16px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; background: var(--card-glass); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); position: sticky; top: 10px; z-index: 5; cursor: pointer; transition: 0.2s ease; border: 1px solid var(--border-glass); }
          .list-date-header:active { transform: scale(0.98); opacity: 0.8; }
          
          .group-items { transition: max-height 0.4s ease, opacity 0.4s ease; max-height: 5000px; opacity: 1; overflow: hidden; }
          .list-group.collapsed .group-items { max-height: 0; opacity: 0; }
          
          .t-item { margin-bottom: 6px; border-radius: 16px; background: #dc2626; overflow: hidden; position: relative; }
          .t-item::before { content: '🗑️'; font-size: 20px; position: absolute; right: 24px; top: 50%; transform: translateY(-50%); color: white; z-index: 1; }
          .t-content { position: relative; z-index: 2; width: 100%; background: var(--card-glass); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border: 1px solid var(--border-glass); border-radius: 16px; padding: 8px 12px; display: flex; align-items: center; transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1); will-change: transform; }
          .t-icon { width: 32px; height: 32px; border-radius: 10px; background: rgba(128,128,128,0.1); border: 1px solid var(--border-glass); display: flex; align-items: center; justify-content: center; font-size: 16px; margin-right: 10px; flex-shrink: 0; }
          .t-info { flex: 1; overflow: hidden; }
          .t-name { font-weight: 600; font-size: 14px; margin-bottom: 0px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .t-meta { font-size: 11px; color: var(--text-muted); font-weight: 500; margin-top: 1px; }
          .t-amt { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 14px; }
          .amt-in { color: var(--success); } .amt-out { color: var(--text); }
          
          .dock-container { position: fixed; bottom: 30px; left: 0; right: 0; display: flex; justify-content: center; z-index: 100; padding-bottom: var(--safe-bottom); pointer-events: none; }
          .dock { pointer-events: auto; background: var(--dock-bg); backdrop-filter: blur(25px) saturate(180%); -webkit-backdrop-filter: blur(25px) saturate(180%); border: 1px solid var(--dock-border); border-radius: 32px; padding: 10px 28px; display: flex; align-items: center; gap: 28px; box-shadow: 0 25px 50px -5px rgba(0,0,0,0.2); }
          .nav-item { display: flex; flex-direction: column; align-items: center; color: var(--text-muted); font-size: 10px; font-weight: 600; cursor: pointer; transition: 0.3s; width: 44px; position: relative; }
          .nav-icon { font-size: 22px; margin-bottom: 4px; opacity: 0.5; filter: grayscale(1); transition: 0.3s; }
          .nav-item.active { color: var(--text); }
          .nav-item.active .nav-icon { opacity: 1; transform: scale(1.15); filter: grayscale(0); }
          .add-btn { width: 56px; height: 56px; background: linear-gradient(135deg, var(--primary), #d946ef); border-radius: 20px; display: flex; align-items: center; justify-content: center; color: white; font-size: 28px; box-shadow: 0 10px 25px -4px rgba(124, 58, 237, 0.5); transform: translateY(-24px); border: 2px solid rgba(255,255,255,0.15); cursor: pointer; transition: 0.2s; }
          .add-btn:active { transform: translateY(-24px) scale(0.9); }
          
          .modal-sheet { position: fixed; bottom: 0; left: 0; right: 0; background: var(--bg); border-radius: 32px 32px 0 0; padding: 32px 24px; z-index: 1000; transform: translateY(110%); transition: transform 0.4s cubic-bezier(0.32, 0.72, 0, 1); border-top: 1px solid var(--border-glass); box-shadow: 0 -20px 60px rgba(0,0,0,0.3); padding-bottom: max(32px, var(--safe-bottom)); }
          .modal-sheet.active { transform: translateY(0); }
          .sheet-handle { width: 40px; height: 5px; background: var(--text-muted); opacity: 0.3; border-radius: 10px; margin: 0 auto 32px auto; }
          .segment-control { display: flex; background: rgba(128,128,128,0.1); padding: 5px; border-radius: 20px; margin-bottom: 28px; position: relative; }
          .segment-btn { flex: 1; padding: 12px; text-align: center; font-weight: 700; color: var(--text-muted); border-radius: 16px; cursor: pointer; position: relative; z-index: 2; transition: 0.3s; }
          .segment-btn.active { color: white; }
          .segment-indicator { position: absolute; top: 5px; left: 5px; bottom: 5px; width: calc(50% - 5px); border-radius: 16px; transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); z-index: 1; }
          .indicator-inc { background: var(--success); opacity: 0.8; } .indicator-exp { background: var(--danger); opacity: 0.8; }
          .input-row { display: flex; gap: 16px; margin-bottom: 20px; }
          .modern-input { width: 100%; background: var(--input-bg); border: 1px solid var(--input-border); padding: 16px; border-radius: 18px; color: var(--text); font-size: 16px; outline: none; transition: 0.3s; font-family: inherit; }
          .modern-input:focus { border-color: var(--primary); background: rgba(128,128,128,0.05); }
          .amount-input { font-family: 'JetBrains Mono'; font-size: 24px; font-weight: 700; }
          .primary-btn { width: 100%; padding: 16px; background: var(--text); color: var(--bg); border: none; border-radius: 18px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 12px; transition: 0.2s; }
          .primary-btn:active { transform: scale(0.96); }
          .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 900; opacity: 0; pointer-events: none; transition: 0.3s; }
          .overlay.active { opacity: 1; pointer-events: auto; }
          .empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); font-size: 14px; opacity: 0.7; }
          
          .alert-box { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.9); background: var(--bg); border: 1px solid var(--border-glass); padding: 32px 28px; border-radius: 28px; width: 80%; max-width: 320px; z-index: 2000; text-align: center; opacity: 0; pointer-events: none; transition: 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); box-shadow: 0 40px 80px rgba(0,0,0,0.5); }
          .alert-box.active { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
          .alert-btns { display: flex; gap: 12px; margin-top: 24px; }
          .alert-btn { flex: 1; padding: 12px; border-radius: 14px; font-weight: 600; border: none; cursor: pointer; font-size: 14px; }
          .btn-cancel { background: rgba(128,128,128,0.1); color: var(--text); }
          .btn-delete { background: var(--danger); color: white; }
          
          .install-prompt { position: fixed; bottom: -200px; left: 24px; right: 24px; background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(24px); border: 1px solid var(--border-glass); border-radius: 24px; padding: 16px; z-index: 5000; display: flex; align-items: center; gap: 16px; box-shadow: 0 25px 60px rgba(0,0,0,0.6); transition: bottom 0.6s cubic-bezier(0.2, 0.8, 0.2, 1); }
          .install-prompt.show { bottom: 40px; }
          .app-icon-preview { width: 48px; height: 48px; border-radius: 12px; background: linear-gradient(135deg, #6366f1, #a855f7); }
          .install-btn { background: white; color: black; border: none; padding: 8px 16px; border-radius: 99px; font-weight: 700; font-size: 13px; cursor: pointer; margin-left: auto; }
      </style>
  </head>
  <body>
      <div class="overlay" id="overlay" onclick="closeAll()"></div>
      <div class="container">
          <header>
              <div class="brand"><img src="${iconBase64}" alt="logo"><span>极光记账</span></div>
              <div class="header-actions">
                  <button class="action-btn" onclick="toggleTheme()" id="themeBtn">☀</button>
                  <button class="action-btn" onclick="logout()">退出</button>
              </div>
          </header>
          <div class="summary-card glass">
              <div class="balance-label">总资产净值</div>
              <div class="balance-amount" id="balanceDisplay">¥0.00</div>
              <div id="dailyChartContainer" style="display:none"><canvas id="dailyBalanceChart"></canvas></div>
              <div class="stats-grid">
                  <div class="stat-box income">
                      <div class="stat-icon-bg">↓</div><div class="stat-title">本期收入</div><div class="stat-val" id="incomeDisplay">0.00</div>
                  </div>
                  <div class="stat-box expense">
                      <div class="stat-icon-bg">↑</div><div class="stat-title">本期支出</div><div class="stat-val" id="expenseDisplay">0.00</div>
                  </div>
              </div>
              <div class="progress-wrapper">
                  <div class="p-bar p-inc" id="barIncome" style="width: 50%"></div>
                  <div class="p-bar p-exp" id="barExpense" style="width: 50%"></div>
              </div>
          </div>
          <div class="list-header-row"><span class="list-title">账单明细</span><span class="list-subtitle">左滑管理</span></div>
          <div id="list" class="transaction-list"><div class="empty-state">Loading...</div></div>
      </div>
      <div class="dock-container">
          <div class="dock">
              <div class="nav-item active" id="nav-daily" onclick="setPeriod('daily', this)"><div class="nav-icon">✨</div>今日</div>
              <div class="nav-item" id="nav-weekly" onclick="setPeriod('weekly', this)"><div class="nav-icon">☄️</div>本周</div>
              <div class="add-btn" onclick="openAddModal()">+</div>
              <div class="nav-item" id="nav-monthly" onclick="setPeriod('monthly', this)"><div class="nav-icon">🌙</div>本月</div>
              <div class="nav-item" id="nav-yearly" onclick="setPeriod('yearly', this)"><div class="nav-icon">🪐</div>本年</div>
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
                  <div style="flex: 1.5"><input type="number" inputmode="decimal" id="amount" class="modern-input amount-input" placeholder="0.00" step="0.01" required></div>
                  <div style="flex: 1"><select id="category" class="modern-input" style="-webkit-appearance: none;"><option value="默认">分类</option></select></div>
              </div>
              <div style="margin-bottom: 20px;"><input type="text" id="desc" class="modern-input" placeholder="备注 (选填)"></div>
              <button type="submit" class="primary-btn">确认保存</button>
          </form>
      </div>
      <div id="deleteModal" class="alert-box">
          <div style="font-size: 48px; margin-bottom: 16px;">🗑️</div>
          <h3 style="margin: 0; color: var(--text); font-size: 18px;">确认删除?</h3>
          <div class="alert-btns"><button class="alert-btn btn-cancel" onclick="cancelDelete()">取消</button><button class="alert-btn btn-delete" onclick="confirmDelete()">删除</button></div>
      </div>
      <div id="installPrompt" class="install-prompt">
          <div style="flex:1"><div style="font-weight:700;color:white;font-size:15px">安装 极光记账</div><div style="color:#94a3b8;font-size:12px">原生 APP 体验</div></div>
          <button class="install-btn" onclick="installApp()">安装</button><div onclick="hideInstallPrompt()" style="padding:10px;color:#64748b">✕</div>
      </div>
      <script>
          Chart.defaults.color='#64748b';Chart.defaults.font.family="'Plus Jakarta Sans', sans-serif";Chart.defaults.scale.grid.display=false;
          let state={type:'income',period:'daily',categories:{expense:['餐饮 🍔','购物 🛍️','交通 🚗','住房 🏠','娱乐 🎮','医疗 💊','订阅 📅','其他 📝'],income:['工资 💰','奖金 💎','理财 📈','兼职 💼','红包 🧧','其他 📝']},chartInstance:null};
          let pendingDelete=null,deferredPrompt;
          
          window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;if(!localStorage.getItem('pwa_dismissed'))setTimeout(()=>document.getElementById('installPrompt').classList.add('show'),3000)});
          function installApp(){if(deferredPrompt){deferredPrompt.prompt();deferredPrompt.userChoice.then(c=>{if(c.outcome==='accepted')localStorage.setItem('pwa_dismissed','true');deferredPrompt=null;hideInstallPrompt()})}}
          function hideInstallPrompt(){document.getElementById('installPrompt').classList.remove('show');localStorage.setItem('pwa_dismissed','true')}
  
          function init(){
              initTheme();
              updateCategoryOptions();setType('income');loadData();
              if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js'));
              handleUrlShortcuts();
          }
          
          // Theme Logic
          function initTheme(){
              const isLight = localStorage.getItem('theme') === 'light';
              if(isLight) document.body.classList.add('light-mode');
              updateThemeBtn();
          }
          function toggleTheme(){
              document.body.classList.toggle('light-mode');
              const isLight = document.body.classList.contains('light-mode');
              localStorage.setItem('theme', isLight ? 'light' : 'dark');
              updateThemeBtn();
              if(state.chartInstance) refreshChart(); // Refresh chart to adapt colors if needed
          }
          function updateThemeBtn(){
              document.getElementById('themeBtn').innerText = document.body.classList.contains('light-mode') ? '🌙' : '☀';
          }
  
          function vibrate(){if(navigator.vibrate)navigator.vibrate(50);} 
          function handleUrlShortcuts(){const p=new URLSearchParams(location.search);if(p.get('add'))openAddModal();const pd=p.get('period');if(pd)setPeriod(pd,document.getElementById('nav-'+pd));if(p.has('add')||pd)history.replaceState(null,null,location.pathname);}
  
          function toggleGroup(id){const el=document.getElementById(id);if(el){el.classList.toggle('collapsed');}}
          function openAddModal(){document.getElementById('addModal').classList.add('active');document.getElementById('overlay').classList.add('active');setTimeout(()=>document.getElementById('amount').focus(),100);vibrate();}
          function closeAll(){document.getElementById('addModal').classList.remove('active');document.getElementById('deleteModal').classList.remove('active');document.getElementById('overlay').classList.remove('active');if(pendingDelete){resetSwipe(pendingDelete.content);pendingDelete=null;}}
          function openDeleteModal(id,el,c){pendingDelete={id,element:el,content:c};document.getElementById('deleteModal').classList.add('active');document.getElementById('overlay').classList.add('active');vibrate();}
          function cancelDelete(){closeAll();}
          function resetSwipe(el){el.style.transform='translateX(0)';}
  
          async function confirmDelete(){
              if(!pendingDelete)return;const{id,element}=pendingDelete;
              element.style.height=element.offsetHeight+'px';
              requestAnimationFrame(()=>{element.style.transition='all 0.3s ease';element.style.height='0';element.style.opacity='0';element.style.margin='0';});
              closeAll();
              await fetch('/api/transactions/'+id,{method:'DELETE'});
              setTimeout(()=>{loadData()},300);
          }
  
          function setType(t){
              state.type=t;
              const ind=document.getElementById('segIndicator'),b1=document.getElementById('btnIncome'),b2=document.getElementById('btnExpense');
              if(t==='income'){ind.style.transform='translateX(0%)';ind.className='segment-indicator indicator-inc';b1.classList.add('active');b2.classList.remove('active');}
              else{ind.style.transform='translateX(100%)';ind.className='segment-indicator indicator-exp';b2.classList.add('active');b1.classList.remove('active');}
              updateCategoryOptions();vibrate();
          }
          function updateCategoryOptions(){const s=document.getElementById('category');s.innerHTML='';state.categories[state.type].forEach(c=>{const o=document.createElement('option');o.value=c.split(' ')[0];o.textContent=c;s.appendChild(o)});}
          
          function setPeriod(p,el){
              state.period=p;
              document.querySelectorAll('.nav-item').forEach(t=>t.classList.remove('active'));if(el)el.classList.add('active');
              
              const cc=document.getElementById('dailyChartContainer');
              if(['monthly','yearly','weekly'].includes(p)){
                  cc.style.display='block';
                  setTimeout(refreshChart,50);
              } else {
                  cc.style.display='none';
                  if(state.chartInstance){state.chartInstance.destroy();state.chartInstance=null;}
              }
  
              const listHeader = document.querySelector('.list-header-row');
              const listEl = document.getElementById('list');
              if (p === 'daily') {
                  listHeader.style.display = 'flex';
                  listEl.style.display = 'block';
              } else {
                  listHeader.style.display = 'none';
                  listEl.style.display = 'none';
              }
  
              loadData();
              vibrate();
          }
  
          async function loadData(){
              try{
                  const sumRes = await fetch('/api/summary?period='+state.period);
                  renderSummary(await sumRes.json());
                  
                  if(state.period === 'daily') {
                      const txRes = await fetch('/api/transactions');
                      renderList(await txRes.json());
                  }
              } catch(e){console.error(e)}
          }
  
          async function refreshChart(){
              let res,suffix='';
              if(state.period==='monthly'){res=await fetch(\`/api/daily_balance?year=\${new Date().getFullYear()}&month=\${new Date().getMonth()+1}\`);suffix='日';}
              else if(state.period==='yearly'){res=await fetch(\`/api/monthly_balance?year=\${new Date().getFullYear()}\`);suffix='月';}
              else if(state.period==='weekly'){res=await fetch('/api/weekly_balance');}
              if(res){const data=await res.json();renderChart(data.map(d=>({label:d.day||d.month,value:d.balance})),suffix);}
          }
  
          function renderChart(data,suffix){
              const ctx=document.getElementById('dailyBalanceChart').getContext('2d');
              if(state.chartInstance){state.chartInstance.destroy();}
              const g1=ctx.createLinearGradient(0,0,0,200);g1.addColorStop(0,'#34d399');g1.addColorStop(1,'rgba(52,211,153,0.1)');
              const g2=ctx.createLinearGradient(0,0,0,200);g2.addColorStop(0,'#fb7185');g2.addColorStop(1,'rgba(251,113,133,0.1)');
              state.chartInstance=new Chart(ctx,{type:'bar',data:{labels:data.map(d=>d.label+suffix),datasets:[{data:data.map(d=>d.value),backgroundColor:data.map(d=>d.value>=0?g1:g2),borderRadius:4,barThickness:8}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:'#64748b'}},y:{display:false}}}});
          }
  
          function renderSummary(d){
              const el=document.getElementById('balanceDisplay');
              const end=d.balance;
              el.innerText='¥'+end.toFixed(2);
              document.getElementById('incomeDisplay').innerText=d.totalIncome.toFixed(2);
              document.getElementById('expenseDisplay').innerText=d.totalExpense.toFixed(2);
              const total=d.totalIncome+d.totalExpense;
              document.getElementById('barIncome').style.width=(total?d.totalIncome/total*100:0)+'%';
              document.getElementById('barExpense').style.width=(total?d.totalExpense/total*100:0)+'%';
          }
  
          function renderList(list){
              const c=document.getElementById('list');
              if(!list.length){c.innerHTML='<div class="empty-state">🍃 暂无账单，开始记录吧</div>';return;}
              const getIcon=cat=>{const map={'餐饮':'🍔','购物':'🛍️','交通':'🚗','住房':'🏠','娱乐':'🎮','医疗':'💊','工资':'💰'};return map[cat]||'📝'};
              
              const groups={};
              list.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).forEach(t=>{
                  const d=new Date(t.timestamp).toLocaleDateString('zh-CN');
                  if(!groups[d])groups[d]=[];groups[d].push(t);
              });
              
              let html='';
              Object.keys(groups).forEach((date,i)=>{
                  const items=groups[date];
                  const dayTotal=items.reduce((acc,cur)=>acc+(cur.type==='income'?cur.amount:-cur.amount),0);
                  const gid='g-'+i;
                  html+=\`<div class="list-group \${i>2?'collapsed':''}" id="\${gid}">
                      <div class="list-date-header" onclick="toggleGroup('\${gid}')"><span>\${date}</span><span>\${dayTotal>0?'+':''}\${dayTotal.toFixed(2)}</span></div>
                      <div class="group-items">\${items.map(t=>\`
                          <div class="t-item" data-id="\${t.id}">
                              <div class="t-content">
                                  <div class="t-icon">\${getIcon(t.category)}</div>
                                  <div class="t-info"><div class="t-name">\${t.description||t.category}</div><div class="t-meta">\${new Date(t.timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</div></div>
                                  <div class="t-amt \${t.type==='income'?'amt-in':'amt-out'}">\${t.type==='income'?'+':'-'} \${parseFloat(t.amount).toFixed(2)}</div>
                              </div>
                          </div>\`).join('')}</div></div>\`;
              });
              c.innerHTML=html;
              bindSwipe();
          }
  
          function bindSwipe(){
              document.querySelectorAll('.t-item').forEach(item=>{
                  const content=item.querySelector('.t-content');
                  let startX,currentX,isSwiping=false;
                  
                  content.addEventListener('touchstart',e=>{startX=e.touches[0].clientX;content.style.transition='none';},{passive:true});
                  content.addEventListener('touchmove',e=>{
                      currentX=e.touches[0].clientX;
                      let diff=currentX-startX;
                      if(diff<0 && diff > -100){ 
                          content.style.transform=\`translateX(\${diff}px)\`;
                          isSwiping=true;
                      }
                  },{passive:true});
                  content.addEventListener('touchend',e=>{
                      content.style.transition='transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)';
                      const diff=currentX-startX;
                      if(diff < -60 && isSwiping){
                          openDeleteModal(item.dataset.id, item, content);
                      } else {
                          resetSwipe(content);
                      }
                      isSwiping=false;
                  });
              });
          }
  
          document.getElementById('addForm').onsubmit=async e=>{
              e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;b.innerText='保存中...';
              try{
                  await fetch('/api/transactions',{method:'POST',headers:{'Content-Type':'application/json'},
                  body:JSON.stringify({type:state.type,amount:document.getElementById('amount').value,category:document.getElementById('category').value,description:document.getElementById('desc').value})});
                  document.getElementById('amount').value='';document.getElementById('desc').value='';closeAll();loadData();
              }catch(err){alert('保存失败')}finally{b.disabled=false;b.innerText='确认保存';}
          };
  
          function logout(){fetch('/api/auth/logout',{method:'POST'}).then(()=>window.location.href='/login');}
          init();
      </script>
  </body>
  </html>`;
  }
