export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
  
      // --- 安全响应头 ---
      const securityHeaders = {
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src https://challenges.cloudflare.com;",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Access-Control-Allow-Origin': url.origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
  
      if (method === 'OPTIONS') {
        return new Response(null, { headers: securityHeaders });
      }
  
      try {
        // 路由守卫
        if (path !== '/login' && !path.startsWith('/api/auth') && path !== '/manifest.json' && path !== '/sw.js') {
          const isAuthenticated = await checkAuthentication(request, env);
          if (!isAuthenticated) {
            return new Response(getLoginPageHTML(), {
              status: 302,
              headers: { 'Content-Type': 'text/html', ...securityHeaders },
            });
          }
        }
  
        // 首页 HTML
        if (path === '/') {
          return new Response(getHTML(), {
            headers: { 'Content-Type': 'text/html', ...securityHeaders },
          });
        }
  
        // API 路由
        if (path.startsWith('/api/')) {
          const response = await handleAPIRequest(request, env, path, method);
          Object.entries(securityHeaders).forEach(([key, value]) => {
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
            headers: { 'Content-Type': 'text/html', ...securityHeaders },
          });
        }
  
        return new Response('Not Found', { status: 404 });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...securityHeaders },
        });
      }
    },
  };
  
  // --- 安全辅助函数 ---
  
  // 1. 密码加盐哈希
  async function hashPassword(password, salt = null) {
    const enc = new TextEncoder();
    if (!salt) {
      salt = crypto.getRandomValues(new Uint8Array(16));
    } else {
      salt = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
    }
    
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]
    );
    
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
    
    const exported = await crypto.subtle.exportKey("raw", key);
    
    const saltStr = btoa(String.fromCharCode(...salt));
    const hashStr = btoa(String.fromCharCode(...new Uint8Array(exported)));
    return { salt: saltStr, hash: hashStr };
  }
  
  // 2. 验证密码
  async function verifyPassword(inputPassword, storedSalt, storedHash) {
    const result = await hashPassword(inputPassword, storedSalt);
    return result.hash === storedHash;
  }
  
  // 3. 安全随机 Token
  function generateSecureToken() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  
  // 4. 输入清洗
  function sanitize(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>"'/]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;'
    }[char]));
  }

  // 5. Cloudflare Turnstile 验证
  async function verifyTurnstile(token, secretKey, ip) {
    if (!secretKey) return false; 
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    formData.append('remoteip', ip || '');
  
    const url = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    try {
        const result = await fetch(url, { body: formData, method: 'POST' });
        const outcome = await result.json();
        return outcome.success;
    } catch (e) {
        console.error('Turnstile Verify Error:', e);
        return false;
    }
  }
  
  // --- 鉴权逻辑 ---
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
  
  async function getCurrentUser(request, env) {
    const kv = env.ACCOUNTING_KV;
    const cookieHeader = request.headers.get('Cookie') || '';
    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
      const [name, value] = cookie.trim().split('=');
      acc[name] = value;
      return acc;
    }, {});
  
    if (cookies.auth_token) {
      const sessionStr = await kv.get(`session_${cookies.auth_token}`);
      if (sessionStr) {
        return JSON.parse(sessionStr); 
      }
    }
    return null;
  }
  
  // --- R2 逻辑 ---
  async function getTransactionsFromR2(env, userId) {
      const r2Key = `transactions_${userId}.json`;
      const object = await env.ACCOUNTING_BUCKET.get(r2Key);
      if (object !== null) {
          try { return await object.json(); } catch (e) { return []; }
      }
      return [];
  }
  
  async function saveTransactionsToR2(env, userId, data) {
      const key = `transactions_${userId}.json`;
      await env.ACCOUNTING_BUCKET.put(key, JSON.stringify(data));
  }
  
  // --- API 处理逻辑 ---
  async function handleAPIRequest(request, env, path, method) {
    const kv = env.ACCOUNTING_KV; 
  
    // --- 1. 注册接口 ---
    if (path === '/api/auth/register' && method === 'POST') {
      try {
        const { username, password, cfToken } = await request.json();
        if (!username || !password) return new Response(JSON.stringify({ error: '请输入账号和密码' }), { status: 400 });
        
        // Turnstile 验证
        const ip = request.headers.get('CF-Connecting-IP');
        const isHuman = await verifyTurnstile(cfToken, env.TURNSTILE_SECRET, ip);
        if (!isHuman) {
             return new Response(JSON.stringify({ error: '人机验证失败，请刷新重试' }), { status: 403 });
        }

        const cleanUsername = sanitize(username); 
  
        const existingUser = await kv.get(`u_${cleanUsername}`);
        if (existingUser) return new Response(JSON.stringify({ error: '用户名已存在' }), { status: 409 });
  
        const { salt, hash } = await hashPassword(password);
        const userId = generateSecureToken();
        
        const userData = { 
          salt, 
          hash, 
          userId, 
          createdAt: Date.now() 
        };
        
        await kv.put(`u_${cleanUsername}`, JSON.stringify(userData));
  
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }
  
    // --- 2. 登录接口 (核心修改：添加 Turnstile 验证) ---
    if (path === '/api/auth/login' && method === 'POST') {
      // 1. 从请求体获取 cfToken
      const { username, password, cfToken } = await request.json();
      if (!username || !password) return new Response(JSON.stringify({ error: '请输入账号和密码' }), { status: 400 });
  
      const cleanUsername = sanitize(username);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const rateLimitKey = `limit_${ip}`;
      
      // 2. 先验证 Turnstile (阻挡机器人请求)
      const isHuman = await verifyTurnstile(cfToken, env.TURNSTILE_SECRET, ip);
      if (!isHuman) {
           return new Response(JSON.stringify({ error: '验证失败，请刷新验证码' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      // 防暴力破解检测 (保留 IP 频率限制作为第二道防线)
      let attempts = parseInt(await kv.get(rateLimitKey) || '0');
      if (attempts >= 5) {
          return new Response(JSON.stringify({ error: '尝试次数过多，请15分钟后再试' }), { status: 429, headers: { 'Content-Type': 'application/json' } });
      }
  
      const userStr = await kv.get(`u_${cleanUsername}`);
      
      if (userStr) {
        const userData = JSON.parse(userStr);
        if (!userData.salt || !userData.hash) {
             return new Response(JSON.stringify({ error: '账号数据需升级，请联系管理员或重新注册' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }
  
        const isValid = await verifyPassword(password, userData.salt, userData.hash);
  
        if (isValid) {
          await kv.delete(rateLimitKey);
  
          const token = generateSecureToken();
          await kv.put(`session_${token}`, JSON.stringify({ userId: userData.userId, username: cleanUsername }), { expirationTtl: 86400 });
          
          return new Response(JSON.stringify({ success: true, token }), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Set-Cookie': `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400`
            },
          });
        }
      }
      
      await kv.put(rateLimitKey, (attempts + 1).toString(), { expirationTtl: 900 });
      return new Response(JSON.stringify({ error: '账号或密码错误' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
  
    // 3. 登出
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
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'auth_token=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0' },
      });
    }
  
    const currentUser = await getCurrentUser(request, env);
    if (!currentUser) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }
    const userId = currentUser.userId;
  
    // --- 账单业务逻辑 (保持不变) ---
    
    if (path === '/api/transactions') {
      if (method === 'GET') {
        const transactions = await getTransactionsFromR2(env, userId);
        return new Response(JSON.stringify(transactions), { headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST') {
        const rawTx = await request.json();
        const transaction = {
            id: generateSecureToken(),
            timestamp: new Date().toISOString(),
            type: rawTx.type,
            amount: parseFloat(rawTx.amount),
            category: sanitize(rawTx.category),
            description: sanitize(rawTx.description)
        };
        
        const transactions = await getTransactionsFromR2(env, userId);
        transactions.push(transaction);
        await saveTransactionsToR2(env, userId, transactions);
        return new Response(JSON.stringify(transactions), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
    }
  
    if (path.startsWith('/api/transactions/') && method === 'DELETE') {
      const transactionId = path.split('/').pop();
      const transactions = await getTransactionsFromR2(env, userId);
      const filteredTransactions = transactions.filter(t => t.id !== transactionId);
      await saveTransactionsToR2(env, userId, filteredTransactions);
      return new Response(JSON.stringify(filteredTransactions), { headers: { 'Content-Type': 'application/json' } });
    }
  
    if (path === '/api/daily_balance') {
        const transactions = await getTransactionsFromR2(env, userId);
        const url = new URL(request.url);
        const targetYear = parseInt(url.searchParams.get('year') || new Date().getFullYear());
        const targetMonth = parseInt(url.searchParams.get('month') || new Date().getMonth() + 1);
        const dailyBalances = calculateDailyBalances(transactions, targetYear, targetMonth);
        return new Response(JSON.stringify(dailyBalances), { headers: { 'Content-Type': 'application/json' } });
    }
    
    if (path === '/api/monthly_balance') {
      const transactions = await getTransactionsFromR2(env, userId);
      const url = new URL(request.url);
      const targetYear = parseInt(url.searchParams.get('year') || new Date().getFullYear());
      const monthlyBalances = calculateMonthlyNetFlow(transactions, targetYear);
      return new Response(JSON.stringify(monthlyBalances), { headers: { 'Content-Type': 'application/json' } });
    }
    
    if (path === '/api/weekly_balance') {
      const transactions = await getTransactionsFromR2(env, userId);
      const weeklyBalances = calculateWeeklyNetFlow(transactions);
      return new Response(JSON.stringify(weeklyBalances), { headers: { 'Content-Type': 'application/json' } });
    }
  
    if (path === '/api/summary') {
      const url = new URL(request.url);
      const period = url.searchParams.get('period') || 'daily';
      const transactions = await getTransactionsFromR2(env, userId);
      const summary = calculateSummary(transactions, period);
      return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
    }
  
    return new Response('Not Found', { status: 404 });
  }
  
  // --- 计算逻辑 (不变) ---
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
  const CACHE_NAME = 'aurora-app-v32-secure';
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
    const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjUxMiIgeTI9IjUxMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzYzNjZmMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2E4NTVmNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiByeD0iMTI4IiBmaWxsPSJ1cmwoI2EpIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI1NiAxMjhsLTMyIDgwSDEyOGw4MCAzMi04MCAzMmg5NmwzMiA4MEwyNTYgNDAwTDI4OCAyNTZoOTZsMzItODBoLTk2ek0yNTYgMTkybDMyIDgwaDk2bDMyLTgwaC05NnoiLz48L3N2Zz4=";
    
    return `{
      "id": "aurora-accounting-app",
      "name": "极光记账",
      "short_name": "极光",
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
  
  // --- 登录/注册页面 (HTML + JS) ---
  function getLoginPageHTML() {
      const iconBase64 = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjUxMiIgeTI9IjUxMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzYzNjZmMSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iI2E4NTVmNyIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiByeD0iMTI4IiBmaWxsPSJ1cmwoI2EpIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI1NiAxMjhsLTMyIDgwSDEyOGw4MCAzMi04MCAzMmg5NmwzMiA4MEwyNTYgNDAwTDI4OCAyNTZoOTZsMzItODBoLTk2ek0yNTYgMTkybDMyIDgwaDk2bDMyLTgwaC05NnoiLz48L3N2Zz4=";
      return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
      <title>登录 - 极光记账</title>
      <meta name="theme-color" content="#020617">
      <link rel="manifest" href="/manifest.json">
      <link rel="apple-touch-icon" href="${iconBase64}">
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      <style>
          :root { --primary: #8b5cf6; --bg: #020617; --text: #f8fafc; }
          body { margin: 0; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; background-color: var(--bg); color: var(--text); overflow: hidden; position: relative; }
          
          .aurora-bg { position: absolute; width: 150%; height: 150%; top: -25%; left: -25%; z-index: -1; background: radial-gradient(at 0% 0%, hsla(253,16%,7%,1) 0, transparent 50%), radial-gradient(at 50% 0%, hsla(225,39%,30%,1) 0, transparent 50%), radial-gradient(at 100% 0%, hsla(339,49%,30%,1) 0, transparent 50%); filter: blur(60px); opacity: 0.6; animation: aurora-spin 20s linear infinite; }
          @keyframes aurora-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          
          .card { 
              background: rgba(30, 41, 59, 0.3); 
              backdrop-filter: blur(24px) saturate(180%); -webkit-backdrop-filter: blur(24px) saturate(180%); 
              border: 1px solid rgba(255, 255, 255, 0.1); 
              padding: 48px 40px; border-radius: 40px; 
              width: 85%; max-width: 380px; text-align: center; 
              box-shadow: 0 40px 80px -12px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.05); 
              animation: floatIn 0.8s cubic-bezier(0.2, 0.8, 0.2, 1); 
              position: relative; overflow: hidden;
              transition: height 0.3s ease;
          }
          .card::before {
              content: ''; position: absolute; top: 0; left: -100%; width: 100%; height: 100%;
              background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
              transition: 0.5s; pointer-events: none;
          }
          .card:hover::before { left: 100%; transition: 0.8s ease-in-out; }
          @keyframes floatIn { from { opacity: 0; transform: translateY(30px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
          
          .logo-img { width: 80px; height: 80px; margin-bottom: 20px; filter: drop-shadow(0 0 30px rgba(139,92,246,0.4)); border-radius: 24px; transition: transform 0.5s ease; }
          .card:hover .logo-img { transform: scale(1.05) rotate(3deg); }
          
          h1 { margin: 0 0 8px 0; font-size: 32px; font-weight: 800; color: white; letter-spacing: -1px; background: linear-gradient(to right, #fff, #c4b5fd); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          p { margin: 0 0 32px 0; color: #94a3b8; font-size: 15px; font-weight: 500; }
          
          .input-group { position: relative; margin-bottom: 16px; transition: all 0.3s ease; }
          input { 
              width: 100%; padding: 16px 24px; border-radius: 20px; 
              border: 1px solid rgba(255,255,255,0.08); 
              background: rgba(0,0,0,0.2); 
              color: white; font-size: 16px; 
              outline: none; text-align: left; transition: 0.3s cubic-bezier(0.4, 0, 0.2, 1); 
              box-sizing: border-box; font-family: 'Plus Jakarta Sans', monospace; 
          }
          input::placeholder { color: #64748b; font-family: 'Plus Jakarta Sans', sans-serif; letter-spacing: normal; }
          input:focus { border-color: rgba(139, 92, 246, 0.5); background: rgba(0,0,0,0.4); box-shadow: 0 0 0 4px rgba(139,92,246,0.15); transform: translateY(-2px); }
          
          /* Turnstile 样式调整 */
          .cf-turnstile { margin-bottom: 16px; display: flex; justify-content: center; }
          
          button { 
              width: 100%; padding: 18px; border-radius: 20px; border: none; margin-top: 10px;
              background: linear-gradient(135deg, #6366f1, #a855f7, #ec4899); 
              background-size: 200% 200%;
              animation: gradient-anim 5s ease infinite;
              color: white; font-size: 16px; font-weight: 700; cursor: pointer; 
              transition: all 0.3s; 
              box-shadow: 0 10px 25px -10px rgba(99, 102, 241, 0.6); 
          }
          @keyframes gradient-anim { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
          button:hover { transform: translateY(-3px); box-shadow: 0 20px 40px -10px rgba(99, 102, 241, 0.7); }
          button:active { transform: scale(0.97); }
          button:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }
          
          .switch-mode { margin-top: 24px; font-size: 14px; color: #94a3b8; cursor: pointer; transition: 0.3s; }
          .switch-mode:hover { color: white; text-decoration: underline; }
          
          .error { color: #f43f5e; font-size: 14px; margin-bottom: 20px; display: none; background: rgba(244,63,94,0.15); padding: 12px; border-radius: 16px; animation: shake 0.5s cubic-bezier(.36,.07,.19,.97) both; }
          @keyframes shake { 10%, 90% { transform: translate3d(-1px, 0, 0); } 20%, 80% { transform: translate3d(2px, 0, 0); } 30%, 50%, 70% { transform: translate3d(-4px, 0, 0); } 40%, 60% { transform: translate3d(4px, 0, 0); } }
          
          /* 隐藏注册专用字段 */
          .register-only { display: none; }
      </style>
  </head>
  <body>
      <div class="aurora-bg"></div>
      <div class="card">
          <img src="${iconBase64}" class="logo-img" alt="Logo">
          <h1 id="title">Welcome</h1>
          <p id="subtitle">登录您的个人账本</p>
          <div id="error" class="error"></div>
          
          <form id="form">
              <div class="input-group">
                  <input type="text" id="username" name="username" placeholder="用户名" required autocomplete="username">
              </div>
              <div class="input-group">
                  <input type="password" id="pwd" name="password" placeholder="密码" required autocomplete="current-password">
              </div>
              
              <div class="input-group register-only" id="group-confirm">
                  <input type="password" id="pwd-confirm" placeholder="再次输入密码" autocomplete="new-password">
              </div>
              
              <div id="group-turnstile">
                  <div class="cf-turnstile" data-sitekey="REPLACE_WITH_YOUR_SITE_KEY" data-theme="dark"></div>
              </div>
  
              <button type="submit" id="btn">立即登录</button>
          </form>
          
          <div class="switch-mode" id="switchBtn" onclick="toggleMode()">没有账号？点击注册</div>
      </div>
  
      <script>
          let isLogin = true;
  
          const els = {
              title: document.getElementById('title'),
              subtitle: document.getElementById('subtitle'),
              btn: document.getElementById('btn'),
              switchBtn: document.getElementById('switchBtn'),
              form: document.getElementById('form'),
              error: document.getElementById('error'),
              username: document.getElementById('username'),
              pwd: document.getElementById('pwd'),
              pwdConfirm: document.getElementById('pwd-confirm'),
              regFields: document.querySelectorAll('.register-only')
          };
  
          function toggleMode() {
              isLogin = !isLogin;
              els.error.style.display = 'none';
              
              if (isLogin) {
                  // 切换到登录模式
                  els.title.innerText = 'Welcome';
                  els.subtitle.innerText = '登录您的个人账本';
                  els.btn.innerText = '立即登录';
                  els.switchBtn.innerText = '没有账号？点击注册';
                  els.regFields.forEach(el => el.style.display = 'none');
                  
                  els.pwdConfirm.value = '';
              } else {
                  // 切换到注册模式
                  els.title.innerText = 'Join Aurora';
                  els.subtitle.innerText = '创建一个新的账本';
                  els.btn.innerText = '注册并登录';
                  els.switchBtn.innerText = '已有账号？返回登录';
                  els.regFields.forEach(el => el.style.display = 'block');
              }
              // 切换模式时重置验证码
              if (window.turnstile) turnstile.reset();
              els.username.focus();
          }
  
          els.form.onsubmit = async (e) => {
              e.preventDefault();
              els.error.style.display = 'none';
              
              const username = els.username.value.trim();
              const password = els.pwd.value;
              let cfToken = '';
  
              // 1. 验证两次密码是否一致 (仅注册)
              if (!isLogin) {
                  const confirm = els.pwdConfirm.value;
                  if (password !== confirm) {
                      showError('两次输入的密码不一致');
                      els.pwdConfirm.focus();
                      return;
                  }
              }
  
              // 2. 获取 Turnstile Token (核心修改：登录注册均需要)
              const formData = new FormData(els.form);
              cfToken = formData.get('cf-turnstile-response');
              
              if (!cfToken) {
                  showError('请完成人机验证');
                  return;
              }
  
              const originalText = els.btn.innerText;
              els.btn.innerText = '处理中...';
              els.btn.disabled = true;
              
              const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
  
              try {
                  const res = await fetch(endpoint, { 
                      method: 'POST', 
                      headers: { 'Content-Type': 'application/json' }, 
                      // 核心修改：登录也发送 cfToken
                      body: JSON.stringify({ username, password, cfToken }) 
                  });
                  
                  const data = await res.json();
                  
                  if (res.ok) {
                      if (isLogin) {
                          els.btn.innerText = '验证成功';
                          window.location.href = '/'; 
                      } else {
                          els.btn.innerText = '注册成功，登录中...';
                          const loginRes = await fetch('/api/auth/login', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ username, password, cfToken }) // 自动登录也带 Token
                          });
                          if (loginRes.ok) window.location.href = '/';
                          else throw new Error('自动登录失败，请手动登录');
                      }
                  } else { 
                      throw new Error(data.error || (isLogin ? '登录失败' : '注册失败')); 
                  }
              } catch (e) { 
                  showError(e.message);
                  els.btn.innerText = originalText; 
                  els.btn.disabled = false; 
                  // 失败后重置验证码 (登录注册均需要)
                  if (window.turnstile) turnstile.reset();
              }
          }
  
          function showError(msg) {
              els.error.innerText = msg;
              els.error.style.display = 'block';
              // 简单的震动反馈
              els.error.style.animation = 'none';
              els.error.offsetHeight; /* trigger reflow */
              els.error.style.animation = 'shake 0.5s cubic-bezier(.36,.07,.19,.97) both';
          }
      </script>
  </body>
  </html>`;
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
              --primary: #7c3aed; 
              --primary-light: #a78bfa;
              --success: #34d399; 
              --danger: #fb7185; 
              --bg: #020617; 
              --card-glass: rgba(30, 41, 59, 0.4); 
              --border-glass: rgba(255, 255, 255, 0.08); 
              --text: #f8fafc; 
              --text-muted: #94a3b8; 
              --safe-bottom: env(safe-area-inset-bottom, 20px); 
              --list-bg: #1e1b4b;
              --dock-bg: rgba(15, 23, 42, 0.7);
              --item-text: #fff;
              --t-content-bg: rgba(30, 41, 59, 0.5);
              --chart-grid: rgba(255, 255, 255, 0.1);
          }
  
          /* 素雅（亮色）主题变量覆盖 */
          [data-theme="light"] {
              --primary: #6366f1;
              --bg: #f8fafc;
              --card-glass: #ffffff;
              --border-glass: rgba(0, 0, 0, 0.05);
              --text: #0f172a;
              --text-muted: #64748b;
              --list-bg: #e2e8f0;
              --dock-bg: rgba(255, 255, 255, 0.85);
              --item-text: #1e293b;
              --t-content-bg: #ffffff;
              --chart-grid: rgba(0, 0, 0, 0.05);
          }
          
          * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
          
          body { 
              margin: 0; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; 
              background-color: var(--bg); color: var(--text); min-height: 100vh; 
              padding-bottom: calc(90px + var(--safe-bottom)); 
              /* 默认深色极光背景 */
              background-image: 
                  radial-gradient(circle at 15% 10%, rgba(99, 102, 241, 0.18), transparent 45%), 
                  radial-gradient(circle at 85% 30%, rgba(236, 72, 153, 0.15), transparent 45%),
                  radial-gradient(circle at 50% 90%, rgba(124, 58, 237, 0.15), transparent 50%);
              background-attachment: fixed;
              background-size: 100% 100%;
              transition: background-color 0.4s ease, color 0.4s ease;
          }
  
          /* 亮色模式下去除背景图，保持干净 */
          [data-theme="light"] body {
              background-image: none;
          }
  
          /* 通用毛玻璃类 */
          .glass {
              background: var(--card-glass);
              backdrop-filter: blur(20px) saturate(180%);
              -webkit-backdrop-filter: blur(20px) saturate(180%);
              border: 1px solid var(--border-glass);
          }
  
          /* 亮色模式下卡片不使用毛玻璃，而是实体白+阴影 */
          [data-theme="light"] .glass {
              backdrop-filter: none;
              box-shadow: 0 10px 30px -10px rgba(0,0,0,0.08);
          }
  
          header { display: flex; justify-content: space-between; align-items: center; padding: 24px 6px 16px; }
          
          .brand { 
              font-size: 20px; font-weight: 800; display: flex; align-items: center; gap: 12px; 
              letter-spacing: -0.5px;
          }
          .brand span { background: linear-gradient(to right, #fff, #cbd5e1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
          [data-theme="light"] .brand span { background: none; -webkit-text-fill-color: var(--text); }
  
          .brand img { width: 32px; height: 32px; border-radius: 10px; box-shadow: 0 4px 12px rgba(99,102,241,0.3); }
          
          .header-actions { display: flex; gap: 12px; }
  
          .icon-btn {
              background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); 
              color: var(--text-muted); width: 36px; height: 36px; border-radius: 50%;
              display: flex; align-items: center; justify-content: center;
              font-size: 16px; cursor: pointer; transition: 0.3s;
          }
          [data-theme="light"] .icon-btn { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.05); }
          
          .logout-btn { 
              background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.05); 
              color: var(--text-muted); padding: 8px 18px; border-radius: 99px; 
              font-size: 12px; font-weight: 600; cursor: pointer; transition: 0.3s; 
          }
          [data-theme="light"] .logout-btn { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.05); }
          .logout-btn:hover { background: rgba(255,255,255,0.08); color: white; border-color: rgba(255,255,255,0.15); }
          [data-theme="light"] .logout-btn:hover { background: rgba(0,0,0,0.08); color: var(--text); border-color: rgba(0,0,0,0.1); }
  
          .container { max-width: 600px; margin: 0 auto; padding: 0 20px; }
  
          .summary-card { 
              border-radius: 36px; padding: 36px 28px; 
              margin-bottom: 36px; position: relative; overflow: hidden; 
              box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
              transition: background 0.4s, box-shadow 0.4s;
          }
          
          /* 卡片光泽 */
          .summary-card::before {
              content: ''; position: absolute; inset: 0;
              background: linear-gradient(120deg, rgba(255,255,255,0.03) 0%, transparent 40%, rgba(255,255,255,0.03) 60%);
              pointer-events: none;
          }
          [data-theme="light"] .summary-card::before { display: none; }
  
          .balance-label { font-size: 13px; color: var(--text-muted); margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; opacity: 0.7; }
          .balance-amount { 
              font-family: 'JetBrains Mono', monospace; font-size: 48px; font-weight: 700; margin-bottom: 36px; 
              letter-spacing: -2px; 
              background: linear-gradient(180deg, #fff 10%, #cbd5e1 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; 
              filter: drop-shadow(0 2px 10px rgba(255,255,255,0.1));
              transition: 0.4s;
          }
          [data-theme="light"] .balance-amount { 
              background: none; -webkit-text-fill-color: var(--text); 
              filter: none; color: var(--text);
          }
  
          .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 12px; }
          .stat-box { 
              background: rgba(0,0,0,0.2); border-radius: 24px; padding: 20px; 
              display: flex; flex-direction: column; position: relative; 
              border: 1px solid rgba(255,255,255,0.03); 
              transition: transform 0.2s;
          }
          [data-theme="light"] .stat-box { background: #f1f5f9; border-color: transparent; }
          .stat-box:active { transform: scale(0.98); }
          
          .stat-icon-bg { 
              width: 36px; height: 36px; border-radius: 12px; 
              display: flex; align-items: center; justify-content: center; font-size: 16px; margin-bottom: 12px; 
          }
          .income .stat-icon-bg { background: rgba(52, 211, 153, 0.1); color: var(--success); border: 1px solid rgba(52, 211, 153, 0.1); }
          .expense .stat-icon-bg { background: rgba(251, 113, 133, 0.1); color: var(--danger); border: 1px solid rgba(251, 113, 133, 0.1); }
          
          .stat-title { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; font-weight: 600; letter-spacing: 0.5px; }
          .stat-val { font-family: 'JetBrains Mono', monospace; font-size: 18px; font-weight: 600; color: white; letter-spacing: -0.5px; }
          [data-theme="light"] .stat-val { color: var(--text); }
  
          .progress-wrapper { height: 8px; background: rgba(255,255,255,0.05); border-radius: 99px; overflow: hidden; margin-top: 28px; display: flex; padding: 2px; }
          [data-theme="light"] .progress-wrapper { background: rgba(0,0,0,0.05); }
          .p-bar { height: 100%; border-radius: 99px; transition: width 0.8s cubic-bezier(0.34, 1.56, 0.64, 1); }
          .p-inc { background: linear-gradient(90deg, #34d399, #10b981); box-shadow: 0 0 12px rgba(52, 211, 153, 0.3); }
          .p-exp { background: linear-gradient(90deg, #fb7185, #f43f5e); box-shadow: 0 0 12px rgba(251, 113, 133, 0.3); }
  
          #dailyChartContainer { margin-bottom: 24px; height: 200px; width: 100%; }
  
          .list-header-row { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; padding: 0 8px; }
          .list-title { font-size: 18px; font-weight: 700; color: white; letter-spacing: -0.5px; }
          [data-theme="light"] .list-title { color: var(--text); }
          .list-subtitle { font-size: 12px; color: var(--text-muted); font-weight: 500; }
          
          .list-group { margin-bottom: 24px; }
          
          /* 粘性标题 */
          .list-date-header { 
              font-size: 12px; color: var(--text-muted); font-weight: 700; 
              padding: 8px 16px; border-radius: 16px; 
              margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;
              background: rgba(2, 6, 23, 0.6); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
              position: sticky; top: 10px; z-index: 5;
              cursor: pointer; transition: 0.2s ease; border: 1px solid rgba(255,255,255,0.03);
          }
          [data-theme="light"] .list-date-header { 
              background: rgba(255, 255, 255, 0.85); 
              border: 1px solid rgba(0,0,0,0.05);
          }
          .list-date-header:active { transform: scale(0.98); background: rgba(255,255,255,0.05); }
          
          .group-items { transition: max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease; max-height: 3000px; opacity: 1; overflow: hidden; }
          .list-group.collapsed .group-items { max-height: 0; opacity: 0; margin: 0; }
          
          .t-item { 
              margin-bottom: 8px; border-radius: 24px; /* 压缩间距 */
              background: var(--list-bg); /* 垃圾桶背景色 */
              overflow: hidden; 
              box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); 
              position: relative; 
          }
          /* 垃圾桶图标 */
          .t-item::before {
              content: '🗑️'; font-size: 20px;
              position: absolute; right: 24px; top: 50%; transform: translateY(-50%);
              color: var(--text-muted); z-index: 1; transition: 0.3s;
          }
  
          .t-content { 
              position: relative; z-index: 2; width: 100%; 
              background: var(--t-content-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
              border: 1px solid var(--border-glass); border-radius: 24px; 
              padding: 10px 14px; /* 减小内边距 */
              display: flex; align-items: center; 
              transition: transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1), background 0.2s; 
          }
          [data-theme="light"] .t-content { backdrop-filter: none; }
          .t-content:active { background: rgba(50, 60, 80, 0.8); }
          [data-theme="light"] .t-content:active { background: #f1f5f9; }
          
          .t-icon { 
              width: 36px; height: 36px; /* 缩小图标尺寸 */
              border-radius: 12px; 
              background: linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.01)); 
              border: 1px solid rgba(255,255,255,0.06); 
              display: flex; align-items: center; justify-content: center; 
              font-size: 18px; /* 缩小图标字号 */
              margin-right: 12px; flex-shrink: 0; 
              box-shadow: 0 4px 10px rgba(0,0,0,0.1);
          }
          [data-theme="light"] .t-icon { background: #f1f5f9; border-color: transparent; box-shadow: none; }
          
          .t-info { flex: 1; overflow: hidden; display: flex; flex-direction: column; justify-content: center; }
          .t-name { font-weight: 600; font-size: 14px; margin-bottom: 2px; color: var(--item-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .t-meta { font-size: 11px; color: var(--text-muted); font-weight: 500; }
          
          .t-amt { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 14px; letter-spacing: -0.5px; }
          .amt-in { color: var(--success); text-shadow: 0 0 20px rgba(52, 211, 153, 0.2); }
          [data-theme="light"] .amt-in { text-shadow: none; }
          .amt-out { color: var(--item-text); }
  
          /* 底部导航 Dock */
          .dock-container { position: fixed; bottom: 30px; left: 0; right: 0; display: flex; justify-content: center; z-index: 100; padding-bottom: var(--safe-bottom); pointer-events: none; }
          .dock { 
              pointer-events: auto; 
              background: var(--dock-bg); 
              backdrop-filter: blur(25px) saturate(180%); -webkit-backdrop-filter: blur(25px) saturate(180%); 
              border: 1px solid var(--border-glass); 
              border-radius: 32px; padding: 10px 28px; 
              display: flex; align-items: center; gap: 28px; 
              box-shadow: 0 25px 50px -5px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.1); 
              transition: background 0.4s;
          }
          
          .nav-item { display: flex; flex-direction: column; align-items: center; justify-content: center; color: #64748b; font-size: 10px; font-weight: 600; cursor: pointer; transition: 0.3s; width: 44px; position: relative; }
          .nav-icon { font-size: 22px; margin-bottom: 4px; transition: 0.3s; opacity: 0.5; filter: grayscale(1); transform: scale(0.9); }
          .nav-item.active { color: white; }
          [data-theme="light"] .nav-item.active { color: var(--primary); }
          .nav-item.active .nav-icon { opacity: 1; transform: scale(1.1); filter: grayscale(0); text-shadow: 0 0 15px rgba(255,255,255,0.5); }
          [data-theme="light"] .nav-item.active .nav-icon { text-shadow: none; }
          .nav-item.active::after { content: ''; position: absolute; bottom: -8px; width: 4px; height: 4px; background: white; border-radius: 50%; box-shadow: 0 0 8px white; }
          [data-theme="light"] .nav-item.active::after { background: var(--primary); box-shadow: none; }
  
          .add-btn { 
              width: 60px; height: 60px; 
              background: linear-gradient(135deg, var(--primary), #d946ef); 
              border-radius: 22px; display: flex; align-items: center; justify-content: center; 
              color: white; font-size: 30px; font-weight: 300; 
              box-shadow: 0 10px 25px -4px rgba(124, 58, 237, 0.5); 
              transform: translateY(-24px); 
              transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); 
              border: 2px solid rgba(255,255,255,0.15); 
          }
          .add-btn:active { transform: translateY(-24px) scale(0.9); }
          
          /* Modal Sheets */
          .modal-sheet { 
              position: fixed; bottom: 0; left: 0; right: 0; 
              background: #1e293b; 
              border-radius: 40px 40px 0 0; 
              padding: 32px 24px; z-index: 1000; 
              transform: translateY(110%); 
              transition: transform 0.5s cubic-bezier(0.32, 0.72, 0, 1); 
              border-top: 1px solid rgba(255,255,255,0.1); 
              box-shadow: 0 -20px 60px rgba(0,0,0,0.7); 
              padding-bottom: max(32px, var(--safe-bottom)); 
          }
          [data-theme="light"] .modal-sheet { background: #fff; border-top-color: rgba(0,0,0,0.05); }
          .modal-sheet.active { transform: translateY(0); }
          
          .sheet-handle { width: 48px; height: 5px; background: rgba(255,255,255,0.15); border-radius: 10px; margin: 0 auto 32px auto; }
          [data-theme="light"] .sheet-handle { background: rgba(0,0,0,0.1); }
          
          .segment-control { display: flex; background: rgba(0,0,0,0.3); padding: 5px; border-radius: 20px; margin-bottom: 28px; position: relative; }
          [data-theme="light"] .segment-control { background: #f1f5f9; }
          .segment-btn { flex: 1; padding: 12px; text-align: center; font-weight: 700; color: var(--text-muted); border-radius: 16px; cursor: pointer; position: relative; z-index: 2; transition: 0.3s; font-size: 15px; }
          .segment-btn.active { color: white; }
          [data-theme="light"] .segment-btn.active { color: var(--text); }
          .segment-indicator { position: absolute; top: 5px; left: 5px; bottom: 5px; width: calc(50% - 5px); border-radius: 16px; transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); z-index: 1; }
          .indicator-inc { background: var(--success); opacity: 0.25; box-shadow: 0 0 15px rgba(52, 211, 153, 0.2); }
          .indicator-exp { background: var(--danger); opacity: 0.25; box-shadow: 0 0 15px rgba(251, 113, 133, 0.2); }
          
          .input-row { display: flex; gap: 16px; margin-bottom: 20px; }
          .modern-input { 
              width: 100%; background: rgba(255,255,255,0.03); 
              border: 1px solid rgba(255,255,255,0.05); 
              padding: 18px; border-radius: 20px; 
              color: white; font-size: 16px; outline: none; 
              transition: 0.3s; font-weight: 500; 
              font-family: 'Plus Jakarta Sans', sans-serif;
          }
          [data-theme="light"] .modern-input { background: #f8fafc; border-color: rgba(0,0,0,0.05); color: var(--text); }
          .modern-input:focus { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.2); box-shadow: 0 0 0 4px rgba(255,255,255,0.05); }
          [data-theme="light"] .modern-input:focus { background: #fff; border-color: var(--primary); box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1); }
          .amount-input { font-family: 'JetBrains Mono'; font-size: 24px; font-weight: 700; }
          
          .primary-btn { 
              width: 100%; padding: 18px; 
              background: white; color: black; 
              border: none; border-radius: 22px; 
              font-size: 17px; font-weight: 700; 
              cursor: pointer; margin-top: 12px; 
              box-shadow: 0 10px 25px -5px rgba(255,255,255,0.2); 
              transition: 0.2s; 
          }
          [data-theme="light"] .primary-btn { background: var(--primary); color: white; box-shadow: 0 10px 25px -5px rgba(99, 102, 241, 0.4); }
          .primary-btn:active { transform: scale(0.96); opacity: 0.9; }
          
          .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 900; opacity: 0; pointer-events: none; transition: 0.4s; }
          .overlay.active { opacity: 1; pointer-events: auto; }
          
          .empty-state { text-align: center; padding: 80px 20px; color: var(--text-muted); font-size: 15px; opacity: 0.6; display: flex; flex-direction: column; align-items: center; gap: 16px; }
          .empty-state::before { content: '🍃'; font-size: 48px; opacity: 0.5; filter: grayscale(1); margin-bottom: 10px; }
          
          .alert-box { 
              position: fixed; top: 50%; left: 50%; 
              transform: translate(-50%, -50%) scale(0.9); 
              background: #1e293b; border: 1px solid var(--border-glass); 
              padding: 40px 32px; border-radius: 32px; 
              width: 80%; max-width: 320px; z-index: 2000; 
              text-align: center; opacity: 0; pointer-events: none; 
              transition: 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); 
              box-shadow: 0 40px 80px rgba(0,0,0,0.8); 
          }
          [data-theme="light"] .alert-box { background: #fff; box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
          [data-theme="light"] .alert-box h3 { color: var(--text) !important; }
  
          .alert-box.active { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
          .alert-btns { display: flex; gap: 12px; margin-top: 32px; }
          .alert-btn { flex: 1; padding: 14px; border-radius: 16px; font-weight: 600; border: none; cursor: pointer; font-size: 15px; transition: 0.2s; }
          .btn-cancel { background: rgba(255,255,255,0.08); color: white; }
          [data-theme="light"] .btn-cancel { background: #f1f5f9; color: var(--text); }
          .btn-delete { background: var(--danger); color: white; box-shadow: 0 8px 20px -6px rgba(251, 113, 133, 0.4); }
          .btn-delete:active { transform: scale(0.95); }
  
          /* Install Prompt */
          .install-prompt {
              position: fixed; bottom: -200px; left: 24px; right: 24px;
              background: rgba(30, 41, 59, 0.95); backdrop-filter: blur(24px);
              border: 1px solid var(--border-glass);
              border-radius: 28px; padding: 20px;
              z-index: 5000; display: flex; align-items: center; gap: 16px;
              box-shadow: 0 25px 60px rgba(0,0,0,0.6);
              transition: bottom 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
          }
          [data-theme="light"] .install-prompt { background: rgba(255,255,255,0.95); box-shadow: 0 20px 60px rgba(0,0,0,0.2); }
          .install-prompt.show { bottom: 40px; }
          .app-icon-preview { width: 52px; height: 52px; border-radius: 14px; background: linear-gradient(135deg, #6366f1, #a855f7); box-shadow: 0 8px 16px rgba(99,102,241,0.3); }
          .install-text { flex: 1; }
          .install-title { font-weight: 700; color: white; font-size: 16px; margin-bottom: 2px; }
          [data-theme="light"] .install-title { color: var(--text); }
          .install-desc { color: var(--text-muted); font-size: 13px; }
          .install-btn { 
              background: white; color: black; border: none; 
              padding: 10px 20px; border-radius: 99px; 
              font-weight: 700; font-size: 14px; cursor: pointer; 
              box-shadow: 0 4px 12px rgba(255,255,255,0.2);
          }
          [data-theme="light"] .install-btn { background: var(--primary); color: white; box-shadow: 0 4px 12px rgba(99,102,241,0.3); }
          .close-install { 
              position: absolute; top: -10px; right: -10px; 
              width: 28px; height: 28px; background: #334155; 
              border-radius: 50%; color: white; display: flex; 
              align-items: center; justify-content: center; 
              font-size: 12px; cursor: pointer; border: 2px solid var(--bg);
          }
      </style>
  </head>
  <body>
      <div class="overlay" id="overlay" onclick="closeAll()"></div>
  
      <div class="container">
          <header>
              <div class="brand">
                  <img src="${iconBase64}" alt="logo"> <span>极光记账</span>
              </div>
              <div class="header-actions">
                  <button class="icon-btn" onclick="toggleTheme()" id="themeBtn">☀️</button>
                  <button class="logout-btn" onclick="logout()">退出</button>
              </div>
          </header>
  
          <div class="summary-card glass">
              <div class="balance-label">总资产净值</div>
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
              <span class="list-title">账单明细</span>
              <span class="list-subtitle">左滑管理</span>
          </div>
          <div id="list" class="transaction-list">
              <div class="empty-state">暂无数据，开始记账吧</div>
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
                      <input type="number" inputmode="decimal" id="amount" class="modern-input amount-input" placeholder="0.00" step="0.01" required>
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
          <div style="font-size: 48px; margin-bottom: 16px;">🗑️</div>
          <h3 style="margin: 0; color: white; font-size: 20px;">确认删除?</h3>
          <p style="color: var(--text-muted); margin: 8px 0 0 0; font-size: 14px;">该记录将无法恢复。</p>
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
          Chart.defaults.color = '#64748b';
          Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";
          Chart.defaults.scale.grid.display = false;
          
          let state = { type: 'income', period: 'daily', categories: { expense: ['餐饮 🍔', '购物 🛍️', '交通 🚗', '住房 🏠', '娱乐 🎮', '医疗 💊', '订阅 📅', '其他 📝'], income: ['工资 💰', '奖金 💎', '理财 📈', '兼职 💼', '红包 🧧', '其他 📝'] }, chartInstance: null };
          let pendingDelete = null; 
          
          let deferredPrompt;
          window.addEventListener('beforeinstallprompt', (e) => {
              e.preventDefault();
              deferredPrompt = e;
              if (!localStorage.getItem('pwa_prompt_dismissed')) {
                  setTimeout(() => {
                      document.getElementById('installPrompt').classList.add('show');
                  }, 3000); 
              }
          });
  
          function initTheme() {
              const savedTheme = localStorage.getItem('app_theme');
              if (savedTheme === 'light') {
                  document.documentElement.setAttribute('data-theme', 'light');
                  document.getElementById('themeBtn').textContent = '🌙';
              } else {
                  document.getElementById('themeBtn').textContent = '☀️';
              }
          }
  
          function toggleTheme() {
              const current = document.documentElement.getAttribute('data-theme');
              const btn = document.getElementById('themeBtn');
              if (current === 'light') {
                  document.documentElement.removeAttribute('data-theme');
                  localStorage.setItem('app_theme', 'dark');
                  btn.textContent = '☀️';
              } else {
                  document.documentElement.setAttribute('data-theme', 'light');
                  localStorage.setItem('app_theme', 'light');
                  btn.textContent = '🌙';
              }
              if (state.chartInstance) refreshChart(); 
          }
          window.toggleTheme = toggleTheme;
          
          function installApp() {
              if (deferredPrompt) {
                  deferredPrompt.prompt();
                  deferredPrompt.userChoice.then((choiceResult) => {
                      if (choiceResult.outcome === 'accepted') {
                          localStorage.setItem('pwa_prompt_dismissed', 'true');
                      }
                      deferredPrompt = null;
                      hideInstallPrompt();
                  });
              }
          }
          
          function hideInstallPrompt() {
              document.getElementById('installPrompt').classList.remove('show');
              localStorage.setItem('pwa_prompt_dismissed', 'true');
          }
  
          function init() {
              initTheme();
              updateCategoryOptions(); setType('income'); loadData();
              if ('serviceWorker' in navigator) {
                  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').then(reg => console.log('SW Registered')));
              }
              handleUrlShortcuts();
          }
  
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
  
          function vibrate() { if (window.navigator.vibrate) window.navigator.vibrate(50); }
          function openAddModal() { document.getElementById('addModal').classList.add('active'); document.getElementById('overlay').classList.add('active'); document.getElementById('amount').focus(); vibrate(); }
          function closeAll() { document.getElementById('addModal').classList.remove('active'); document.getElementById('deleteModal').classList.remove('active'); document.getElementById('overlay').classList.remove('active'); if (pendingDelete) { pendingDelete.content.style.transform = 'translateX(0)'; pendingDelete = null; } }
          function openDeleteModal(id, element, content) { pendingDelete = { id, element, content }; document.getElementById('deleteModal').classList.add('active'); document.getElementById('overlay').classList.add('active'); vibrate(); }
          function cancelDelete() { closeAll(); }
  
          async function confirmDelete() {
              if (!pendingDelete) return;
              const { id, element, content } = pendingDelete;
              element.style.height = element.offsetHeight + 'px'; element.style.transition = 'all 0.4s ease';
              requestAnimationFrame(() => { element.style.height = '0'; element.style.marginBottom = '0'; element.style.opacity = '0'; element.style.transform = 'scale(0.9)'; });
              closeAll();
              const res = await fetch('/api/transactions/' + id, { method: 'DELETE' });
              const updatedList = await res.json();
              setTimeout(() => { renderList(updatedList); loadSummaryOnly(); refreshChart(); }, 400);
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
              state.period = period; 
              document.querySelectorAll('.nav-item').forEach(t => t.classList.remove('active')); 
              if (el) el.classList.add('active'); 
              
              const listHeader = document.querySelector('.list-header-row');
              const listContainer = document.getElementById('list');
              
              if (period === 'daily') {
                  if(listHeader) listHeader.style.display = 'flex';
                  if(listContainer) listContainer.style.display = 'block';
                  loadData(); 
              } else {
                  if(listHeader) listHeader.style.display = 'none';
                  if(listContainer) listContainer.style.display = 'none';
                  loadSummaryOnly(); 
              }
              
              vibrate();
              
              const chartContainer = document.getElementById('dailyChartContainer');
              if (['monthly', 'yearly', 'weekly'].includes(period)) { 
                  chartContainer.style.display = 'block'; 
                  setTimeout(refreshChart, 50); 
              } else { 
                  chartContainer.style.display = 'none'; 
                  if (state.chartInstance) { state.chartInstance.destroy(); state.chartInstance = null; } 
              }
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
               
               const gradientInc = ctx.createLinearGradient(0, 0, 0, 200); 
               gradientInc.addColorStop(0, '#34d399'); gradientInc.addColorStop(1, 'rgba(52, 211, 153, 0.2)');
               
               const gradientExp = ctx.createLinearGradient(0, 0, 0, 200); 
               gradientExp.addColorStop(0, '#fb7185'); gradientExp.addColorStop(1, 'rgba(251, 113, 133, 0.2)');
               
               state.chartInstance = new Chart(ctx, { 
                   type: 'bar', 
                   data: { 
                       labels: data.map(d => d.label), 
                       datasets: [{ 
                           label: '净流量', 
                           data: data.map(d => d.value), 
                           backgroundColor: data.map(d => d.value >= 0 ? gradientInc : gradientExp), 
                           borderRadius: 100, 
                           borderSkipped: false,
                           barThickness: 8, 
                       }] 
                   }, 
                   options: { 
                       responsive: true, 
                       maintainAspectRatio: false, 
                       animation: { duration: 1000, easing: 'easeOutQuart' },
                       plugins: { 
                           legend: { display: false }, 
                           tooltip: { 
                               backgroundColor: 'rgba(30, 41, 59, 0.9)', 
                               padding: 12, cornerRadius: 14, 
                               titleFont: { size: 13 }, bodyFont: { family: 'JetBrains Mono' },
                               callbacks: { label: (c) => ' ¥' + Math.abs(c.parsed.y).toFixed(2) } 
                           } 
                       }, 
                       scales: { 
                           x: { grid: { display: false, drawBorder: false }, ticks: { font: { size: 11 }, color: '#94a3b8' }, border: { display: false } }, 
                           y: { display: false, grid: { display: false } } 
                       } 
                   } 
               });
          }
  
          function renderSummary(data) {
              const balEl = document.getElementById('balanceDisplay'); animateValue(balEl, parseFloat(balEl.innerText.replace(/[¥,]/g,'')) || 0, data.balance);
              document.getElementById('incomeDisplay').innerText = data.totalIncome.toFixed(2); document.getElementById('expenseDisplay').innerText = data.totalExpense.toFixed(2);
              const total = data.totalIncome + data.totalExpense; const incPct = total === 0 ? 0 : (data.totalIncome/total*100); const expPct = total === 0 ? 0 : (data.totalExpense/total*100);
              document.getElementById('barIncome').style.width = incPct + '%'; document.getElementById('barExpense').style.width = expPct + '%';
          }
  
          function animateValue(obj, start, end) {
              let startTimestamp = null; const duration = 1000;
              const step = (timestamp) => { if (!startTimestamp) startTimestamp = timestamp; const progress = Math.min((timestamp - startTimestamp) / duration, 1); const ease = 1 - Math.pow(1 - progress, 5); obj.innerHTML = '¥' + (start + ease * (end - start)).toFixed(2); if (progress < 1) window.requestAnimationFrame(step); }; window.requestAnimationFrame(step);
          }
  
          function renderList(list) {
              const container = document.getElementById('list');
              if (list.length === 0) { container.innerHTML = '<div class="empty-state">暂无数据，开始记账吧</div>'; return; }
              const getIcon = (cat) => { const map = {'餐饮':'🍔','购物':'🛍️','交通':'🚗','住房':'🏠','娱乐':'🎮','医疗':'💊','工资':'💰','奖金':'💎','理财':'📈','兼职':'💼','红包':'🧧','其他':'📝','默认':'📝'}; return map[cat] || '📝'; };
              const sortedList = list.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
              const groupedList = sortedList.reduce((groups, item) => { const dateKey = item.timestamp.substring(0, 10); if (!groups[dateKey]) groups[dateKey] = []; groups[dateKey].push(item); return groups; }, {});
              const formatDate = (dateStr) => { const d = new Date(dateStr); const today = new Date(); if (d.toDateString() === today.toDateString()) return '今天'; return (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]; };
  
              let html = '';
              const sortedDateKeys = Object.keys(groupedList).sort((a, b) => new Date(b) - new Date(a));
              
              sortedDateKeys.forEach((dateKey, index) => {
                  const items = groupedList[dateKey]; 
                  const dayTotal = items.reduce((sum, t) => sum + (t.type==='income'?parseFloat(t.amount):-parseFloat(t.amount)), 0);
                  const groupId = \`group-\${dateKey}\`;
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
                  const content = item.querySelector('.t-content'); 
                  let startX = 0; 
                  let startY = 0; 
                  let isDragging = false;
                  
                  item.addEventListener('touchstart', (e) => { 
                      startX = e.touches[0].clientX; 
                      startY = e.touches[0].clientY; 
                      content.style.transition = 'none'; 
                      isDragging = false;
                  }, { passive: true });
                  
                  item.addEventListener('touchmove', (e) => { 
                      const currentX = e.touches[0].clientX;
                      const currentY = e.touches[0].clientY;
                      const diffX = currentX - startX; 
                      const diffY = currentY - startY;
  
                      // 防误触逻辑：水平移动 > 垂直移动时才触发左滑
                      if (Math.abs(diffX) > Math.abs(diffY) && diffX < 0) {
                           if (diffX > -120) { 
                               content.style.transform = \`translateX(\${diffX}px)\`; 
                               isDragging = true; 
                           } 
                      }
                  }, { passive: true });
                  
                  item.addEventListener('touchend', (e) => { 
                      content.style.transition = 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)'; 
                      const currentOffset = parseInt(content.style.transform.replace('translateX(', '')) || 0; 
                      if (currentOffset < -75) { 
                          openDeleteModal(item.dataset.id, item, content); 
                      } else { 
                          content.style.transform = 'translateX(0)'; 
                      } 
                      isDragging = false; 
                  });
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
