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
  
      // Handle CORS preflight requests
      if (method === 'OPTIONS') {
        return new Response(null, {
          headers: corsHeaders,
        });
      }
  
      try {
        // 检查是否已认证（除了登录页面）
        if (path !== '/login' && !path.startsWith('/api/auth')) {
          const isAuthenticated = await checkAuthentication(request, env);
          if (!isAuthenticated) {
            return new Response(getLoginPageHTML(), {
              status: 302,
              headers: {
                'Content-Type': 'text/html',
                ...corsHeaders,
              },
            });
          }
        }
  
        if (path === '/') {
          return new Response(getHTML(), {
            headers: {
              'Content-Type': 'text/html',
              ...corsHeaders,
            },
          });
        }
  
        // API Routes
        if (path.startsWith('/api/')) {
          const response = await handleAPIRequest(request, env, path, method);
          Object.entries(corsHeaders).forEach(([key, value]) => {
            response.headers.set(key, value);
          });
          return response;
        }
  
        // 登录页面
        if (path === '/login') {
          return new Response(getLoginPageHTML(), {
            headers: {
              'Content-Type': 'text/html',
              ...corsHeaders,
            },
          });
        }
  
        return new Response('Not Found', { status: 404 });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders,
          },
        });
      }
    },
  };
  
  // 检查认证状态
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
    const userId = 'default_user'; // 简单实现，实际应用中应该有用户认证
  
    // 认证 API
    if (path === '/api/auth/login' && method === 'POST') {
      const { password } = await request.json();
      const correctPassword = await kv.get('app_password') || 'admin123'; // 默认密码
      
      if (password === correctPassword) {
        const token = generateToken();
        const expiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24小时后过期
        
        await kv.put(`session_${token}`, JSON.stringify({ 
          userId, 
          expiresAt 
        }), {
          expirationTtl: 86400 // 24小时TTL
        });
        
        return new Response(JSON.stringify({ success: true, token }), {
          status: 200,
          headers: { 
            'Content-Type': 'application/json',
            'Set-Cookie': `auth_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
          },
        });
      } else {
        return new Response(JSON.stringify({ error: '密码错误' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
  
    if (path === '/api/auth/logout' && method === 'POST') {
      const cookieHeader = request.headers.get('Cookie') || '';
      const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
        const [name, value] = cookie.trim().split('=');
        acc[name] = value;
        return acc;
      }, {});
  
      if (cookies.auth_token) {
        await kv.delete(`session_${cookies.auth_token}`);
      }
      
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': 'auth_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
        },
      });
    }
  
    if (path === '/api/transactions') {
      if (method === 'GET') {
        // 获取所有交易记录
        const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
        return new Response(JSON.stringify(transactions), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
  
      if (method === 'POST') {
        // 添加新交易记录
        const transaction = await request.json();
        transaction.id = Date.now().toString();
        transaction.timestamp = new Date().toISOString();
  
        const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
        transactions.push(transaction);
        
        await kv.put(`transactions_${userId}`, JSON.stringify(transactions));
        
        return new Response(JSON.stringify(transaction), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
  
    if (path.startsWith('/api/transactions/') && method === 'DELETE') {
      // 删除交易记录
      const transactionId = path.split('/').pop();
      const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
      const filteredTransactions = transactions.filter(t => t.id !== transactionId);
      
      await kv.put(`transactions_${userId}`, JSON.stringify(filteredTransactions));
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    if (path === '/api/summary') {
      // 获取统计信息
      const url = new URL(request.url);
      const period = url.searchParams.get('period') || 'daily';
      
      const transactions = await kv.get(`transactions_${userId}`, 'json') || [];
      const summary = calculateSummary(transactions, period);
      
      return new Response(JSON.stringify(summary), {
        headers: { 'Content-Type': 'application/json' },
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
  
    // Manifest
    if (path === '/manifest.json') {
      return new Response(getManifest(), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }
  
    return new Response('Not Found', { status: 404 });
  }
  
  // Service Worker
  function getServiceWorker() {
    return `
  const CACHE_NAME = 'accounting-app-v1';
  const urlsToCache = [
    '/',
    '/manifest.json'
  ];
  
  self.addEventListener('install', function(event) {
    event.waitUntil(
      caches.open(CACHE_NAME)
        .then(function(cache) {
          return cache.addAll(urlsToCache);
        })
    );
  });
  
  self.addEventListener('fetch', function(event) {
    event.respondWith(
      caches.match(event.request)
        .then(function(response) {
          // Cache hit - return response
          if (response) {
            return response;
          }
  
          // Clone the request
          const fetchRequest = event.request.clone();
  
          return fetch(fetchRequest).then(
            function(response) {
              // Check if valid response
              if(!response || response.status !== 200 || response.type !== 'basic') {
                return response;
              }
  
              // Clone the response
              const responseToCache = response.clone();
  
              caches.open(CACHE_NAME)
                .then(function(cache) {
                  cache.put(event.request, responseToCache);
                });
  
              return response;
            }
          );
        })
      );
  });
  
  self.addEventListener('activate', function(event) {
    event.waitUntil(
      caches.keys().then(function(cacheNames) {
        return Promise.all(
          cacheNames.map(function(cacheName) {
            if (cacheName !== CACHE_NAME) {
              return caches.delete(cacheName);
            }
          })
        );
      })
    );
  });
  `;
  }
  
  // PWA Manifest
  function getManifest() {
    return `{
    "name": "记账应用",
    "short_name": "记账",
    "description": "简单实用的记账应用",
    "start_url": "/",
    "display": "standalone",
    "background_color": "#667eea",
    "theme_color": "#667eea",
    "orientation": "portrait",
    "icons": [
      {
        "src": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTkyIiBoZWlnaHQ9IjE5MiIgdmlld0JveD0iMCAwIDE5MiAxOTIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxOTIiIGhlaWdodD0iMTkyIiByeD0iMjQiIGZpbGw9InVybCgjZ3JhZGllbnQwXzBfMSkiLz4KPHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4PSI2NCIgeT0iNjQiPgo8dGV4dCB4PSIzMiIgeT0iNDAiIGZvbnQtZmFtaWx5PSJBcHBsZSBDb2xvciBFbW9qaSwgU2Vnb2UgVUksIFJvYm90bywgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIzMiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiPjkwPC90ZXh0Pgo8L3N2Zz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQwXzBfMSIgeDE9IjAiIHkxPSIwIiB4Mj0iMTkyIiB5Mj0iMTkyIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IiM2NjdlZWEiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNzY0YmEyIi8+CjwvbGluZWFyR3JhZGllbnQ+CjwvZGVmcz4KPC9zdmc+",
        "sizes": "192x192",
        "type": "image/svg+xml"
      },
      {
        "src": "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgdmlld0JveD0iMCAwIDUxMiA1MTIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiByeD0iNjQiIGZpbGw9InVybCgjZ3JhZGllbnQwXzBfMSkiLz4KPHN2ZyB3aWR0aD0iMTUzIiBoZWlnaHQ9IjE1MyIgdmlld0JveD0iMCAwIDE1MyAxNTMiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeD0iMTc5IiB5PSIxNzkiPgo8dGV4dCB4PSI3Ni41IiB5PSI5NSIgZm9udC1mYW1pbHk9IkFwcGxlIENvbG9yIEVtb2ppLCBTZWdvZSBVSSwgUm9ib3RvLCBzYW5zLXNlcmlmIiBmb250LXNpemU9Ijc2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSJ3aGl0ZSI+4oCcPC90ZXh0Pgo8L3N2Zz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQwXzBfMSIgeDE9IjAiIHkxPSIwIiB4Mj0iNTEyIiB5Mj0iNTEyIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IiM2NjdlZWEiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNzY0YmEyIi8+CjwvbGluZWFyR3JhZGllbnQ+CjwvZGVmcz4KPC9zdmc+",
        "sizes": "512x512",
        "type": "image/svg+xml"
      }
    ]
  }`;
  }
  
  // 日期工具函数
  function getWeekRange(date = new Date()) {
    const d = new Date(date);
    const dayOfWeek = d.getDay();
    // 调整为周一（周日的偏移是-6，其他是1-dayOfWeek）
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mondayOffset);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    
    return {
      start: monday,
      end: sunday,
      startString: monday.toLocaleDateString('zh-CN'),
      endString: sunday.toLocaleDateString('zh-CN')
    };
  }
  
  function getMonthRange(date = new Date()) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0); // 下个月的第0天就是这个月的最后一天
    
    return {
      start: firstDay,
      end: lastDay,
      startString: firstDay.toLocaleDateString('zh-CN'),
      endString: lastDay.toLocaleDateString('zh-CN'),
      daysInMonth: lastDay.getDate()
    };
  }
  
  function getYearRange(date = new Date()) {
    const year = date.getFullYear();
    const firstDay = new Date(year, 0, 1);
    const lastDay = new Date(year, 11, 31);
    
    return {
      start: firstDay,
      end: lastDay,
      startString: firstDay.toLocaleDateString('zh-CN'),
      endString: lastDay.toLocaleDateString('zh-CN')
    };
  }
  
  // 生成简单的 token
  function generateToken() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
  
  function calculateSummary(transactions, period = 'daily') {
    let income = 0;
    let expense = 0;
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // 修正周计算：周一至周日
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // 周日时偏移-6天，其他偏移到周一
    const thisWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisYear = new Date(now.getFullYear(), 0, 1);
    
    // 根据时间周期过滤交易
    const filteredTransactions = transactions.filter(transaction => {
      const transactionDate = new Date(transaction.timestamp);
      
      if (period === 'daily') {
        return transactionDate >= today;
      } else if (period === 'weekly') {
        return transactionDate >= thisWeek;
      } else if (period === 'monthly') {
        return transactionDate >= thisMonth;
      } else if (period === 'yearly') {
        return transactionDate >= thisYear;
      }
      
      return true;
    });
    
    filteredTransactions.forEach(transaction => {
      const amount = parseFloat(transaction.amount);
      if (transaction.type === 'income') {
        income += amount;
      } else {
        expense += amount;
      }
    });
  
    return {
      totalIncome: income,
      totalExpense: expense,
      balance: income - expense,
      transactionCount: filteredTransactions.length,
      period: period
    };
  }
  
  // 登录页面 HTML
  function getLoginPageHTML() {
    return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>登录 - 记账应用</title>
      
      <!-- PWA Meta Tags -->
      <meta name="theme-color" content="#667eea">
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-status-bar-style" content="default">
      <meta name="apple-mobile-web-app-title" content="记账应用">
      
      <!-- PWA Icons -->
      <link rel="apple-touch-icon" sizes="180x180" href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTgwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDE4MCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxODAiIGhlaWdodD0iMTgwIiByeD0iMjAiIGZpbGw9InVybCgjZ3JhZGllbnQwXzBfMSkiLz4KPHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4PSI2MCIgeT0iNjAiPgo8dGV4dCB4PSIzMCIgeT0iMzgiIGZvbnQtZmFtaWx5PSJBcHBsZSBDb2xvciBFbW9qaSwgU2Vnb2UgVUksIFJvYm90bywgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIzMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiPjkwPC90ZXh0Pgo8L3N2Zz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQwXzBfMSIgeDE9IjAiIHkxPSIwIiB4Mj0iMTgwIiB5Mj0iMTgwIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IiM2NjdlZWEiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNzY0YmEyIi8+CjwvbGluZWFyR3JhZGllbnQ+CjwvZGVmcz4KPC9zdmc+">
      <link rel="icon" type="image/svg+xml" sizes="any" href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNCIgZmlsbD0idXJsKCNncmFkaWVudDBfMF8xKSIvPgo8c3ZnIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2IiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHg9IjgiIHk9IjgiPgo8dGV4dCB4PSI4IiB5PSIxMSIgZm9udC1mYW1pbHk9IkFwcGxlIENvbG9yIEVtb2ppLCBTZWdvZSBVSSwgUm9ib3RvLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjEwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSJ3aGl0ZSI+4oCcPC90ZXh0Pgo8L3N2Zz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQwXzBfMSIgeDE9IjAiIHkxPSIwIiB4Mj0iMzIiIHkyPSIzMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjNjY3ZWVhIi8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzc2NGJhMiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM+Cjwvc3ZnPg==">
      <style>
          * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
          }
  
          body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
          }
  
          .login-container {
              background: white;
              padding: 40px;
              border-radius: 15px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.1);
              width: 100%;
              max-width: 400px;
              text-align: center;
          }
  
          .logo {
              font-size: 48px;
              margin-bottom: 20px;
          }
  
          .title {
              font-size: 24px;
              font-weight: 600;
              color: #333;
              margin-bottom: 10px;
          }
  
          .subtitle {
              color: #666;
              margin-bottom: 30px;
          }
  
          .form-group {
              margin-bottom: 20px;
              text-align: left;
          }
  
          label {
              display: block;
              margin-bottom: 8px;
              font-weight: 500;
              color: #333;
          }
  
          input {
              width: 100%;
              padding: 12px 15px;
              border: 2px solid #e1e5e9;
              border-radius: 8px;
              font-size: 16px;
              transition: border-color 0.3s;
          }
  
          input:focus {
              outline: none;
              border-color: #667eea;
          }
  
          .login-btn {
              width: 100%;
              padding: 15px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              border: none;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 500;
              cursor: pointer;
              transition: transform 0.2s;
          }
  
          .login-btn:hover {
              transform: translateY(-2px);
          }
  
          .login-btn:disabled {
              opacity: 0.6;
              cursor: not-allowed;
              transform: none;
          }
  
          .error {
              background: #fee;
              color: #c53030;
              padding: 10px;
              border-radius: 6px;
              margin-bottom: 20px;
              font-size: 14px;
          }
  
          .default-password {
              background: #f0f4ff;
              color: #4c51bf;
              padding: 12px;
              border-radius: 6px;
              margin-top: 20px;
              font-size: 14px;
          }
  
          /* 登录页面现代化移动端优化 */
          @media (max-width: 480px) {
              body {
                  padding: 0;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  min-height: 100vh;
                  position: relative;
              }
  
              body::before {
                  content: '';
                  position: absolute;
                  top: 0;
                  left: 0;
                  right: 0;
                  bottom: 0;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  z-index: -2;
              }
  
              body::after {
                  content: '';
                  position: absolute;
                  top: -50%;
                  left: -50%;
                  width: 200%;
                  height: 200%;
                  background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
                  animation: float 8s ease-in-out infinite;
                  z-index: -1;
              }
  
              .login-container {
                  padding: 40px 25px;
                  border-radius: 24px;
                  box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                  backdrop-filter: blur(20px);
                  background: rgba(255,255,255,0.95);
                  border: 1px solid rgba(255,255,255,0.2);
                  width: 90%;
                  max-width: 380px;
                  animation: slideUp 0.6s ease-out;
              }
  
              @keyframes slideUp {
                  from {
                      opacity: 0;
                      transform: translateY(30px);
                  }
                  to {
                      opacity: 1;
                      transform: translateY(0);
                  }
              }
  
              .logo {
                  font-size: 48px;
                  margin-bottom: 20px;
                  animation: bounce 2s ease-in-out infinite alternate;
              }
  
              @keyframes bounce {
                  0% { transform: translateY(0); }
                  100% { transform: translateY(-10px); }
              }
  
              .title {
                  font-size: 22px;
                  margin-bottom: 8px;
                  font-weight: 700;
                  color: #333;
              }
  
              .subtitle {
                  font-size: 15px;
                  margin-bottom: 30px;
                  color: #666;
                  font-weight: 400;
              }
  
              .form-group {
                  margin-bottom: 20px;
              }
  
              input {
                  padding: 18px 16px;
                  font-size: 16px;
                  border: 2px solid #e9ecef;
                  border-radius: 16px;
                  background: white;
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              }
  
              input:focus {
                  outline: none;
                  border-color: #667eea;
                  box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
                  transform: translateY(-1px);
              }
  
              .login-btn {
                  padding: 18px;
                  font-size: 17px;
                  font-weight: 600;
                  border-radius: 16px;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                  position: relative;
                  overflow: hidden;
              }
  
              .login-btn:active {
                  transform: scale(0.98);
              }
  
              .login-btn:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
              }
  
              .error {
                  background: rgba(239, 68, 68, 0.1);
                  color: #dc2626;
                  border: 1px solid rgba(239, 68, 68, 0.2);
                  padding: 12px;
                  border-radius: 12px;
                  margin-bottom: 20px;
                  font-size: 14px;
                  backdrop-filter: blur(10px);
              }
  
              .default-password {
                  background: rgba(102, 126, 234, 0.1);
                  color: #4c51bf;
                  padding: 14px;
                  border-radius: 12px;
                  margin-top: 20px;
                  font-size: 14px;
                  border: 1px solid rgba(102, 126, 234, 0.2);
                  backdrop-filter: blur(10px);
              }
  
              .default-password code {
                  background: rgba(102, 126, 234, 0.2);
                  padding: 2px 6px;
                  border-radius: 4px;
                  font-weight: 600;
              }
  
              /* 平板适配 */
              @media (min-width: 481px) and (max-width: 768px) {
                  .login-container {
                      padding: 45px 30px;
                      max-width: 420px;
                  }
  
                  .logo {
                      font-size: 52px;
                  }
  
                  .title {
                      font-size: 24px;
                  }
  
                  .subtitle {
                      font-size: 16px;
                  }
              }
  
              /* 大屏适配 */
              @media (min-width: 769px) {
                  .login-container {
                      padding: 50px 35px;
                      max-width: 450px;
                  }
  
                  .logo {
                      font-size: 56px;
                  }
  
                  .title {
                      font-size: 26px;
                  }
  
                  .subtitle {
                      font-size: 17px;
                  }
  
                  input {
                      padding: 20px 18px;
                      font-size: 17px;
                  }
  
                  .login-btn {
                      padding: 20px;
                      font-size: 18px;
                  }
              }
  
              /* 超大屏适配 */
              @media (min-width: 1200px) {
                  .login-container {
                      padding: 60px 40px;
                      max-width: 480px;
                  }
  
                  .logo {
                      font-size: 64px;
                  }
  
                  .title {
                      font-size: 28px;
                  }
  
                  .subtitle {
                      font-size: 18px;
                  }
              }
  
              /* 横屏适配 */
              @media (orientation: landscape) and (max-height: 600px) {
                  body {
                      padding: 10px;
                  }
  
                  .login-container {
                      padding: 30px 25px;
                      margin: 20px auto;
                  }
  
                  .logo {
                      font-size: 40px;
                      margin-bottom: 15px;
                  }
  
                  .title {
                      font-size: 20px;
                      margin-bottom: 6px;
                  }
  
                  .subtitle {
                      font-size: 14px;
                      margin-bottom: 20px;
                  }
  
                  input {
                      padding: 14px 12px;
                      font-size: 15px;
                  }
  
                  .login-btn {
                      padding: 14px;
                      font-size: 15px;
                  }
  
                  .default-password {
                      font-size: 13px;
                      padding: 12px;
                  }
              }
  
              /* 高DPI屏幕优化 */
              @media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
                  .title {
                      font-weight: 300;
                  }
  
                  .logo {
                      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
                  }
              }
  
              /* 深色模式支持 */
              @media (prefers-color-scheme: dark) {
                  body::before {
                      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                  }
  
                  .login-container {
                      background: rgba(31, 31, 31, 0.95);
                      border-color: rgba(255,255,255,0.1);
                  }
  
                  .title {
                      color: #ffffff;
                  }
  
                  .subtitle {
                      color: #cccccc;
                  }
  
                  input {
                      background: #2a2a2a;
                      border-color: #444;
                      color: #ffffff;
                  }
  
                  input:focus {
                      border-color: #667eea;
                      box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.2);
                  }
  
                  .error {
                      background: rgba(239, 68, 68, 0.1);
                      border-color: rgba(239, 68, 68, 0.2);
                      color: #f87171;
                  }
  
                  .default-password {
                      background: rgba(102, 126, 234, 0.1);
                      border-color: rgba(102, 126, 234, 0.2);
                      color: #a5b4fc;
                  }
  
                  .default-password code {
                      background: rgba(102, 126, 234, 0.2);
                      color: #c7d2fe;
                  }
              }
          }
      </style>
  </head>
  <body>
      <div class="login-container">
          <div class="logo">💰</div>
          <h1 class="title">记账应用</h1>
          <p class="subtitle">请输入密码以访问应用</p>
          
          <div id="error-message" class="error" style="display: none;"></div>
          
          <form id="loginForm">
              <div class="form-group">
                  <label for="password">密码</label>
                  <input type="password" id="password" required placeholder="请输入密码" autocomplete="current-password">
              </div>
              <button type="submit" class="login-btn" id="loginBtn">登录</button>
          </form>

          </div>
      </div>
  
      <script>
          document.getElementById('loginForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              
              const password = document.getElementById('password').value;
              const loginBtn = document.getElementById('loginBtn');
              const errorMessage = document.getElementById('error-message');
              
              loginBtn.disabled = true;
              loginBtn.textContent = '登录中...';
              errorMessage.style.display = 'none';
              
              try {
                  const response = await fetch('/api/auth/login', {
                      method: 'POST',
                      headers: {
                          'Content-Type': 'application/json',
                      },
                      body: JSON.stringify({ password })
                  });
                  
                  const result = await response.json();
                  
                  if (response.ok && result.success) {
                      // 登录成功，重定向到主页面
                      window.location.href = '/';
                  } else {
                      throw new Error(result.error || '登录失败');
                  }
              } catch (error) {
                  errorMessage.textContent = error.message || '登录失败，请重试';
                  errorMessage.style.display = 'block';
              } finally {
                  loginBtn.disabled = false;
                  loginBtn.textContent = '登录';
              }
          });
          
          // 页面加载时聚焦密码输入框
          document.getElementById('password').focus();
      </script>
  </body>
  </html>`;
  }
  
  function getHTML() {
    return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>记账应用</title>
      
      <!-- PWA Meta Tags -->
      <meta name="theme-color" content="#667eea">
      <meta name="apple-mobile-web-app-capable" content="yes">
      <meta name="apple-mobile-web-app-status-bar-style" content="default">
      <meta name="apple-mobile-web-app-title" content="记账应用">
      <meta name="application-name" content="记账应用">
      <meta name="msapplication-TileColor" content="#667eea">
      <meta name="msapplication-config" content="/browserconfig.xml">
      
      <!-- PWA Icons -->
      <link rel="apple-touch-icon" sizes="180x180" href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTgwIiBoZWlnaHQ9IjE4MCIgdmlld0JveD0iMCAwIDE4MCAxODAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxODAiIGhlaWdodD0iMTgwIiByeD0iMjAiIGZpbGw9InVybCgjZ3JhZGllbnQwXzBfMSkiLz4KPHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4PSI2MCIgeT0iNjAiPgo8dGV4dCB4PSIzMCIgeT0iMzgiIGZvbnQtZmFtaWx5PSJBcHBsZSBDb2xvciBFbW9qaSwgU2Vnb2UgVUksIFJvYm90bywgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIzMCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0id2hpdGUiPjkw8L3RleHQ+Cjwvc3ZnPgoKPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQwXzBfMSIgeDE9IjAiIHkxPSIwIiB4Mj0iMTgwIiB5Mj0iMTgwIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+CjxzdG9wIHN0b3AtY29sb3I9IiM2NjdlZWEiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNzY0YmEyIi8+CjwvbGluZWFyR3JhZGllbnQ+CjwvZGVmcz4KPC9zdmc+">
      <link rel="icon" type="image/svg+xml" sizes="any" href="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNCIgZmlsbD0idXJsKCNncmFkaWVudDBfMF8xKSIvPgo8c3ZnIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2IiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHg9IjgiIHk9IjgiPgo8dGV4dCB4PSI4IiB5PSIxMSIgZm9udC1mYW1pbHk9IkFwcGxlIENvbG9yIEVtb2ppLCBTZWdvZSBVSSwgUm9ib3RvLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjEwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSJ3aGl0ZSI+4oCcPC90ZXh0Pgo8L3N2Zz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0iZ3JhZGllbnQwXzBfMSIgeDE9IjAiIHkxPSIwIiB4Mj0iMzIiIHkyPSIzMiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjNjY3ZWVhIi8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzc2NGJhMiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM+Cjwvc3ZnPg==">
      
      <!-- Service Worker Registration -->
      <script>
          if ('serviceWorker' in navigator) {
              window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js').then(function(registration) {
                      console.log('ServiceWorker registration successful with scope: ', registration.scope);
                  }, function(err) {
                      console.log('ServiceWorker registration failed: ', err);
                  });
              });
          }
      </script>
      <style>
          * {
              margin: 0;
              padding: 0;
              box-sizing: border-box;
          }
  
          body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              padding: 20px;
          }
  
          .container {
              max-width: 600px;
              margin: 0 auto;
              background: white;
              border-radius: 15px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.1);
              overflow: hidden;
          }
  
          .header {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 30px;
              text-align: center;
          }
  
          .header h1 {
              font-size: 28px;
              margin-bottom: 20px;
          }
  
          .summary {
              display: flex;
              justify-content: space-around;
              margin-top: 20px;
          }
  
          .summary-item {
              text-align: center;
          }
  
          .summary-label {
              font-size: 12px;
              opacity: 0.8;
              margin-bottom: 5px;
          }
  
          .summary-value {
              font-size: 20px;
              font-weight: bold;
          }
  
          .form-section {
              padding: 30px;
              border-bottom: 1px solid #eee;
          }
  
          .form-group {
              margin-bottom: 20px;
          }
  
          label {
              display: block;
              margin-bottom: 8px;
              font-weight: 500;
              color: #333;
          }
  
          input, select, textarea {
              width: 100%;
              padding: 12px;
              border: 2px solid #e1e5e9;
              border-radius: 8px;
              font-size: 16px;
              transition: border-color 0.3s;
          }
  
          input:focus, select:focus, textarea:focus {
              outline: none;
              border-color: #667eea;
          }
  
          .type-toggle {
              display: flex;
              gap: 10px;
              margin-bottom: 20px;
          }
  
          .type-btn {
              flex: 1;
              padding: 12px;
              border: 2px solid #e1e5e9;
              background: white;
              border-radius: 8px;
              cursor: pointer;
              font-size: 16px;
              transition: all 0.3s;
          }
  
          .type-btn.active {
              background: #667eea;
              color: white;
              border-color: #667eea;
          }
  
          .submit-btn {
              width: 100%;
              padding: 15px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              border: none;
              border-radius: 8px;
              font-size: 16px;
              font-weight: 500;
              cursor: pointer;
              transition: transform 0.2s;
          }
  
          .submit-btn:hover {
              transform: translateY(-2px);
          }
  
          .transactions-section {
              padding: 30px;
          }
  
          .section-title {
              font-size: 20px;
              font-weight: 600;
              margin-bottom: 20px;
              color: #333;
          }
  
          .transaction-list {
              max-height: 400px;
              overflow-y: auto;
          }
  
          .transaction-item {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 15px;
              border-bottom: 1px solid #eee;
              transition: background-color 0.2s;
          }
  
          .transaction-item:hover {
              background-color: #f8f9fa;
          }
  
          .transaction-info {
              flex: 1;
          }
  
          .transaction-description {
              font-weight: 500;
              margin-bottom: 5px;
          }
  
          .transaction-category {
              font-size: 12px;
              color: #666;
          }
  
          .transaction-amount {
              font-size: 18px;
              font-weight: bold;
              margin-right: 15px;
          }
  
          .amount-income {
              color: #10b981;
          }
  
          .amount-expense {
              color: #ef4444;
          }
  
          .delete-btn {
              background: #ef4444;
              color: white;
              border: none;
              padding: 8px 12px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 12px;
              transition: background-color 0.2s;
          }
  
          .delete-btn:hover {
              background: #dc2626;
          }
  
          .empty-state {
              text-align: center;
              padding: 40px;
              color: #666;
          }
  
          .loading {
              text-align: center;
              padding: 20px;
              color: #666;
          }
  
          .logout-btn {
              background: #ef4444;
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 6px;
              cursor: pointer;
              font-size: 14px;
              transition: background-color 0.2s;
              position: absolute;
              top: 20px;
              right: 20px;
          }
  
          .logout-btn:hover {
              background: #dc2626;
          }
  
          .summary-tabs {
              display: flex;
              gap: 10px;
              margin-bottom: 20px;
              justify-content: center;
          }
  
          .summary-tab {
              padding: 8px 20px;
              border: 2px solid rgba(255,255,255,0.3);
              background: rgba(255,255,255,0.1);
              color: white;
              border-radius: 20px;
              cursor: pointer;
              font-size: 14px;
              transition: all 0.3s;
          }
  
          .summary-tab.active {
              background: rgba(255,255,255,0.3);
              border-color: rgba(255,255,255,0.5);
          }
  
          .summary-tab:hover {
              background: rgba(255,255,255,0.2);
          }
  
          /* 现代化移动端优化 */
          @media (max-width: 768px) {
              body {
                  padding: 0;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  position: relative;
              }
  
              body::before {
                  content: '';
                  position: fixed;
                  top: 0;
                  left: 0;
                  right: 0;
                  bottom: 0;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  z-index: -1;
              }
  
              .container {
                  border-radius: 20px 20px 0 0;
                  max-width: 100%;
                  box-shadow: 0 -10px 30px rgba(0,0,0,0.1);
                  min-height: 100vh;
                  background: white;
              }
  
              .header {
                  padding: 25px 20px 20px;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                  position: relative;
                  overflow: hidden;
              }
  
              .header::before {
                  content: '';
                  position: absolute;
                  top: -50%;
                  right: -50%;
                  width: 200%;
                  height: 200%;
                  background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
                  animation: float 6s ease-in-out infinite;
              }
  
              @keyframes float {
                  0%, 100% { transform: translate(0, 0) rotate(0deg); }
                  50% { transform: translate(-30px, -30px) rotate(180deg); }
              }
  
              .header h1 {
                  font-size: 26px;
                  margin-bottom: 20px;
                  font-weight: 700;
                  position: relative;
                  z-index: 1;
              }
  
              .summary-tabs {
                  margin-bottom: 20px;
                  gap: 8px;
                  position: relative;
                  z-index: 1;
              }
  
  .summary-tab {
              padding: 8px 16px;
              font-size: 14px;
              border-radius: 20px;
              backdrop-filter: blur(10px);
              border: 1px solid rgba(255,255,255,0.3);
              transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 2px;
              min-width: 80px;
          }
  
          .tab-icon {
              font-size: 16px;
              line-height: 1;
          }
  
          .tab-text {
              font-weight: 500;
              font-size: 13px;
          }
  
          .tab-date {
              font-size: 10px;
              opacity: 0.8;
              font-weight: 400;
          }
  
              .summary-tab.active {
                  background: rgba(255,255,255,0.9);
                  color: #667eea;
                  box-shadow: 0 4px 15px rgba(0,0,0,0.1);
              }
  
              .summary {
                  flex-wrap: wrap;
                  gap: 12px;
                  position: relative;
                  z-index: 1;
              }
  
              .summary-item {
                  flex: 1;
                  min-width: 100px;
                  background: rgba(255,255,255,0.1);
                  backdrop-filter: blur(10px);
                  border-radius: 16px;
                  padding: 12px;
                  border: 1px solid rgba(255,255,255,0.2);
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              }
  
              .summary-item:hover {
                  transform: translateY(-2px);
                  background: rgba(255,255,255,0.15);
              }
  
              .summary-label {
                  font-size: 12px;
                  opacity: 0.9;
                  margin-bottom: 4px;
                  font-weight: 500;
              }
  
              .summary-value {
                  font-size: 20px;
                  font-weight: 700;
                  text-shadow: 0 2px 4px rgba(0,0,0,0.1);
              }
  
              .form-section {
                  padding: 25px 20px;
                  background: white;
              }
  
              .section-title {
                  font-size: 20px;
                  margin-bottom: 20px;
                  color: #333;
                  font-weight: 600;
                  display: flex;
                  align-items: center;
                  gap: 8px;
              }
  
              .section-title::before {
                  content: '📝';
                  font-size: 18px;
              }
  
              .type-toggle {
                  display: flex;
                  gap: 12px;
                  margin-bottom: 20px;
                  padding: 4px;
                  background: #f8f9fa;
                  border-radius: 16px;
              }
  
              .type-btn {
                  flex: 1;
                  padding: 12px;
                  font-size: 16px;
                  font-weight: 500;
                  border: none;
                  border-radius: 12px;
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              }
  
              .type-btn.active {
                  background: white;
                  color: #667eea;
                  box-shadow: 0 2px 10px rgba(102, 126, 234, 0.3);
                  transform: scale(1.02);
              }
  
              .form-group {
                  margin-bottom: 20px;
              }
  
              label {
                  font-weight: 600;
                  color: #555;
                  margin-bottom: 8px;
                  display: flex;
                  align-items: center;
                  gap: 6px;
              }
  
              input, select, textarea {
                  padding: 16px;
                  font-size: 16px;
                  border: 2px solid #e9ecef;
                  border-radius: 12px;
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                  background: white;
              }
  
              input:focus, select:focus, textarea:focus {
                  outline: none;
                  border-color: #667eea;
                  box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.1);
                  transform: translateY(-1px);
              }
  
              .submit-btn {
                  padding: 18px;
                  font-size: 17px;
                  font-weight: 600;
                  border-radius: 16px;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                  position: relative;
                  overflow: hidden;
              }
  
              .submit-btn::before {
                  content: '';
                  position: absolute;
                  top: 50%;
                  left: 50%;
                  width: 0;
                  height: 0;
                  border-radius: 50%;
                  background: rgba(255,255,255,0.3);
                  transform: translate(-50%, -50%);
                  transition: width 0.6s, height 0.6s;
              }
  
              .submit-btn:active::before {
                  width: 300px;
                  height: 300px;
              }
  
              .submit-btn:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5);
              }
  
              .transactions-section {
                  padding: 25px 20px;
                  background: #f8f9fa;
              }
  
              .section-title:nth-of-type(2)::before {
                  content: '📊';
              }
  
              .transaction-list {
                  max-height: 500px;
                  overflow-y: auto;
                  padding: 2px;
              }
  
              .transaction-item {
                  background: white;
                  margin-bottom: 12px;
                  border-radius: 16px;
                  padding: 16px;
                  box-shadow: 0 2px 8px rgba(0,0,0,0.06);
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                  border-left: 4px solid transparent;
              }
  
              .transaction-item:hover {
                  transform: translateX(4px);
                  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
              }
  
              .transaction-item[data-type="income"] {
                  border-left-color: #10b981;
              }
  
              .transaction-item[data-type="expense"] {
                  border-left-color: #ef4444;
              }
  
              .transaction-info {
                  flex: 1;
                  min-width: 0;
              }
  
              .transaction-description {
                  font-weight: 600;
                  margin-bottom: 4px;
                  color: #333;
                  font-size: 16px;
              }
  
              .transaction-category {
                  font-size: 13px;
                  color: #666;
                  display: flex;
                  align-items: center;
                  gap: 4px;
              }
  
              .transaction-category::before {
                  content: '🏷️';
                  font-size: 11px;
              }
  
              .transaction-amount {
                  font-size: 18px;
                  font-weight: 700;
                  margin-right: 12px;
              }
  
              .amount-income {
                  color: #10b981;
                  text-shadow: 0 1px 2px rgba(16, 185, 129, 0.2);
              }
  
              .amount-expense {
                  color: #ef4444;
                  text-shadow: 0 1px 2px rgba(239, 68, 68, 0.2);
              }
  
              .delete-btn {
                  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
                  color: white;
                  border: none;
                  padding: 8px 14px;
                  border-radius: 10px;
                  cursor: pointer;
                  font-size: 12px;
                  font-weight: 500;
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.3);
              }
  
              .delete-btn:hover {
                  transform: scale(1.05);
                  box-shadow: 0 4px 10px rgba(239, 68, 68, 0.4);
              }
  
              .logout-btn {
                  position: fixed;
                  top: 15px;
                  right: 15px;
                  background: rgba(255,255,255,0.2);
                  backdrop-filter: blur(10px);
                  border: 1px solid rgba(255,255,255,0.3);
                  color: white;
                  padding: 8px 16px;
                  border-radius: 20px;
                  font-size: 13px;
                  font-weight: 500;
                  z-index: 1000;
                  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
              }
  
              .logout-btn:hover {
                  background: rgba(255,255,255,0.3);
                  transform: translateY(-1px);
              }
  
              .empty-state {
                  text-align: center;
                  padding: 60px 20px;
                  color: #999;
                  font-size: 16px;
              }
  
              .empty-state::before {
                  content: '📝';
                  display: block;
                  font-size: 48px;
                  margin-bottom: 16px;
                  opacity: 0.5;
              }
          }
  
          /* 小屏幕手机进一步优化 */
          @media (max-width: 480px) {
              .header h1 {
                  font-size: 22px;
              }
  
              .header {
                  padding: 20px 15px 15px;
              }
  
              .summary-value {
                  font-size: 18px;
              }
  
              .form-section {
                  padding: 20px 15px;
              }
  
              .transactions-section {
                  padding: 20px 15px;
              }
  
              .summary-item {
                  min-width: 90px;
                  padding: 10px;
              }
  
              .transaction-item {
                  padding: 14px;
              }
  
              .submit-btn {
                  padding: 16px;
                  font-size: 16px;
              }
  
              .type-btn {
                  padding: 10px;
                  font-size: 15px;
              }
          }
  
          /* 大屏手机和平板优化 */
          @media (min-width: 769px) and (max-width: 1024px) {
              body {
                  padding: 15px;
              }
  
              .container {
                  max-width: 700px;
                  border-radius: 20px;
              }
  
              .header {
                  padding: 35px;
              }
  
              .header h1 {
                  font-size: 30px;
              }
  
              .summary-value {
                  font-size: 22px;
              }
  
              .form-section {
                  padding: 35px;
              }
  
              .transaction-item {
                  padding: 18px;
              }
  
              .logout-btn {
                  top: 20px;
                  right: 20px;
                  padding: 10px 18px;
                  font-size: 14px;
              }
          }
  
          /* 大屏优化 */
          @media (min-width: 1025px) {
              body {
                  padding: 20px;
              }
  
              .container {
                  max-width: 800px;
                  border-radius: 25px;
              }
  
              .header {
                  padding: 40px;
              }
  
              .header h1 {
                  font-size: 32px;
                  margin-bottom: 25px;
              }
  
              .summary-tabs {
                  margin-bottom: 25px;
              }
  
              .summary-tab {
                  padding: 10px 24px;
                  font-size: 16px;
              }
  
              .summary {
                  gap: 16px;
              }
  
              .summary-item {
                  min-width: 120px;
                  padding: 16px;
              }
  
              .summary-label {
                  font-size: 14px;
              }
  
              .summary-value {
                  font-size: 24px;
              }
  
              .form-section {
                  padding: 40px;
              }
  
              .section-title {
                  font-size: 22px;
                  margin-bottom: 25px;
              }
  
              .type-toggle {
                  gap: 16px;
                  margin-bottom: 25px;
              }
  
              .type-btn {
                  padding: 14px;
                  font-size: 17px;
              }
  
              input, select, textarea {
                  padding: 18px;
                  font-size: 17px;
              }
  
              .submit-btn {
                  padding: 20px;
                  font-size: 18px;
              }
  
              .transactions-section {
                  padding: 40px;
              }
  
              .transaction-item {
                  padding: 20px;
                  margin-bottom: 16px;
              }
  
              .transaction-description {
                  font-size: 17px;
              }
  
              .transaction-category {
                  font-size: 14px;
              }
  
              .transaction-amount {
                  font-size: 20px;
              }
  
              .delete-btn {
                  padding: 10px 16px;
                  font-size: 13px;
              }
  
              .logout-btn {
                  top: 25px;
                  right: 25px;
                  padding: 12px 20px;
                  font-size: 15px;
              }
          }
  
          /* 超大屏优化 */
          @media (min-width: 1441px) {
              body {
                  padding: 30px;
              }
  
              .container {
                  max-width: 900px;
                  margin: 0 auto;
              }
  
              .header {
                  padding: 50px;
              }
  
              .header h1 {
                  font-size: 36px;
                  margin-bottom: 30px;
              }
  
              .form-section {
                  padding: 50px;
              }
  
              .transactions-section {
                  padding: 50px;
              }
  
              .transaction-list {
                  max-height: 600px;
              }
          }
  
          /* 横屏优化 */
          @media (orientation: landscape) and (max-height: 600px) {
              body {
                  padding: 10px;
              }
  
              .header {
                  padding: 15px;
              }
  
              .header h1 {
                  font-size: 20px;
                  margin-bottom: 10px;
              }
  
              .summary-tabs {
                  margin-bottom: 10px;
              }
  
              .summary-tab {
                  padding: 4px 10px;
                  font-size: 12px;
                  min-width: 65px;
                  gap: 1px;
              }
  
              .tab-icon {
                  font-size: 14px;
              }
  
              .tab-text {
                  font-size: 11px;
              }
  
              .tab-date {
                  font-size: 9px;
              }
  
              .summary {
                  gap: 8px;
              }
  
              .summary-item {
                  min-width: 70px;
                  padding: 8px;
              }
  
              .summary-label {
                  font-size: 10px;
              }
  
              .summary-value {
                  font-size: 16px;
              }
  
              .form-section {
                  padding: 15px;
              }
  
              .section-title {
                  font-size: 16px;
                  margin-bottom: 10px;
              }
  
              .type-toggle {
                  gap: 8px;
                  margin-bottom: 10px;
              }
  
              .type-btn {
                  padding: 8px;
                  font-size: 14px;
              }
  
              .form-group {
                  margin-bottom: 12px;
              }
  
              input, select, textarea {
                  padding: 12px;
                  font-size: 14px;
              }
  
              .submit-btn {
                  padding: 12px;
                  font-size: 14px;
              }
  
              .transactions-section {
                  padding: 15px;
              }
  
              .transaction-item {
                  padding: 10px;
                  margin-bottom: 8px;
              }
  
              .logout-btn {
                  top: 10px;
                  right: 10px;
                  padding: 6px 12px;
                  font-size: 11px;
              }
          }
  
          /* 动态视口高度适配 */
          @media (min-height: 800px) {
              .transaction-list {
                  max-height: 450px;
              }
          }
  
          @media (min-height: 1000px) {
              .transaction-list {
                  max-height: 550px;
              }
          }
  
          /* 触摸设备优化 */
          @media (hover: none) and (pointer: coarse) {
              .type-btn, .submit-btn, .delete-btn, .logout-btn {
                  min-height: 44px;
                  min-width: 44px;
              }
  
              input, select, textarea {
                  min-height: 44px;
              }
  
              .transaction-item {
                  min-height: 60px;
                  padding: 16px;
              }
  
              .summary-tab {
                  min-height: 40px;
                  min-width: 60px;
              }
          }
  
          /* 高DPI屏幕优化 */
          @media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
              .header h1 {
                  font-weight: 300;
              }
  
              .summary-value {
                  font-weight: 600;
              }
  
              .submit-btn {
                  font-weight: 500;
              }
          }
  
          /* 深色模式支持 */
          @media (prefers-color-scheme: dark) {
              body {
                  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
              }
  
              .container {
                  background: #1f1f1f;
                  color: #ffffff;
              }
  
              .transaction-item {
                  background: #2a2a2a;
                  border-color: rgba(255,255,255,0.1);
              }
  
              input, select, textarea {
                  background: #2a2a2a;
                  border-color: #444;
                  color: #ffffff;
              }
  
              .form-section {
                  background: #1f1f1f;
              }
  
              .transactions-section {
                  background: #0a0a0a;
              }
  
              .section-title {
                  color: #ffffff;
              }
  
              label {
                  color: #cccccc;
              }
  
              .transaction-description {
                  color: #ffffff;
              }
  
              .transaction-category {
                  color: #999999;
              }
          }
      </style>
  </head>
  <body>
      <button class="logout-btn" onclick="logout()">退出登录</button>
      <div class="container">
          <div class="header">
              <h1>💰 记账应用</h1>
              
              <div class="summary-tabs">
                  <button class="summary-tab active" data-period="daily">
                      <span class="tab-icon">📅</span>
                      <span class="tab-text">今日</span>
                      <span class="tab-date" id="dailyDate"></span>
                  </button>
                  <button class="summary-tab" data-period="weekly">
                      <span class="tab-icon">📊</span>
                      <span class="tab-text">本周(周一至周日)</span>
                      <span class="tab-date" id="weeklyDate"></span>
                  </button>
                  <button class="summary-tab" data-period="monthly">
                      <span class="tab-icon">📆</span>
                      <span class="tab-text">本月(1日至月末)</span>
                      <span class="tab-date" id="monthlyDate"></span>
                  </button>
                  <button class="summary-tab" data-period="yearly">
                      <span class="tab-icon">📈</span>
                      <span class="tab-text">今年(1月至12月)</span>
                      <span class="tab-date" id="yearlyDate"></span>
                  </button>
              </div>
              
              <div class="summary">
                  <div class="summary-item">
                      <div class="summary-label">收入</div>
                      <div class="summary-value" id="periodIncome">¥0</div>
                  </div>
                  <div class="summary-item">
                      <div class="summary-label">支出</div>
                      <div class="summary-value" id="periodExpense">¥0</div>
                  </div>
                  <div class="summary-item">
                      <div class="summary-label">余额</div>
                      <div class="summary-value" id="periodBalance">¥0</div>
                  </div>
              </div>
          </div>
  
          <div class="form-section">
              <h2 class="section-title">添加记录</h2>
              <form id="transactionForm">
                  <div class="type-toggle">
                      <button type="button" class="type-btn active" data-type="income">收入</button>
                      <button type="button" class="type-btn" data-type="expense">支出</button>
                  </div>
  
                  <div class="form-group">
                      <label for="amount">金额</label>
                      <input type="number" id="amount" step="0.01" required placeholder="0.00">
                  </div>
  
                  <div class="form-group">
                      <label for="category">分类</label>
                      <select id="category" required>
                          <option value="">请选择分类</option>
                      </select>
                  </div>
  
                  <div class="form-group">
                      <label for="description">描述</label>
                      <input type="text" id="description" required placeholder="请输入描述" value="微信">
                  </div>
  
                  <button type="submit" class="submit-btn">添加记录</button>
              </form>
          </div>
  
          <div class="transactions-section">
              <h2 class="section-title">最近记录</h2>
              <div id="transactionList" class="transaction-list">
                  <div class="loading">加载中...</div>
              </div>
          </div>
      </div>
  
      <script>
          let currentType = 'income';
          
          const categories = {
              expense: ['现金'],
              income: ['现金']
          };
  
          // 初始化分类选择
          function updateCategories() {
              const categorySelect = document.getElementById('category');
              categorySelect.innerHTML = '<option value="">请选择分类</option>';
              
              categories[currentType].forEach(category => {
                  const option = document.createElement('option');
                  option.value = category;
                  option.textContent = category;
                  categorySelect.appendChild(option);
              });
              
              // 默认选择现金
              categorySelect.value = '现金';
          }
  
          // 类型切换
          document.querySelectorAll('.type-btn').forEach(btn => {
              btn.addEventListener('click', function() {
                  document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
                  this.classList.add('active');
                  currentType = this.dataset.type;
                  updateCategories();
              });
          });
  
          // 格式化金额
          function formatAmount(amount, type) {
              const className = type === 'income' ? 'amount-income' : 'amount-expense';
              const prefix = type === 'income' ? '+' : '-';
              return \`<span class="\${className}">¥\${prefix}\${amount.toFixed(2)}</span>\`;
          }
  
          // 格式化时间
          function formatDate(timestamp) {
              const date = new Date(timestamp);
              return date.toLocaleDateString('zh-CN') + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
          }
  
          // 加载交易记录
          async function loadTransactions() {
              try {
                  const response = await fetch('/api/transactions');
                  const transactions = await response.json();
                  
                  const listElement = document.getElementById('transactionList');
                  
                  if (transactions.length === 0) {
                      listElement.innerHTML = '<div class="empty-state">暂无记录</div>';
                      return;
                  }
  
                  listElement.innerHTML = transactions
                      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
                      .map(transaction => \`
                          <div class="transaction-item" data-type="\${transaction.type}">
                              <div class="transaction-info">
                                  <div class="transaction-description">\${transaction.description}</div>
                                  <div class="transaction-category">\${transaction.category} · \${formatDate(transaction.timestamp)}</div>
                              </div>
                              \${formatAmount(parseFloat(transaction.amount), transaction.type)}
                              <button class="delete-btn" onclick="deleteTransaction('\${transaction.id}')">删除</button>
                          </div>
                      \`).join('');
  
                  await loadSummary(currentPeriod);
              } catch (error) {
                  console.error('加载失败:', error);
                  document.getElementById('transactionList').innerHTML = '<div class="empty-state">加载失败</div>';
              }
          }
  
          let currentPeriod = 'daily';
  
          // 更新日期显示
          function updateDateDisplay() {
              const now = new Date();
              const dailyDate = document.getElementById('dailyDate');
              const weeklyDate = document.getElementById('weeklyDate');
              const monthlyDate = document.getElementById('monthlyDate');
              const yearlyDate = document.getElementById('yearlyDate');
              
              // 显示今日日期
              if (dailyDate) {
                  dailyDate.textContent = now.toLocaleDateString('zh-CN', { 
                      month: 'short', 
                      day: 'numeric' 
                  });
              }
              
              // 显示本周日期范围（周一至周日）
              if (weeklyDate) {
                  const weekRange = getWeekRange(now);
                  const weekStart = weekRange.startString;
                  const weekEnd = weekRange.endString;
                  weeklyDate.textContent = weekStart.split('/').slice(1).join('/') + ' - ' + weekEnd.split('/').slice(1).join('/');
              }
              
              // 显示本月日期范围（1日至月末）
              if (monthlyDate) {
                  const monthRange = getMonthRange(now);
                  const monthStart = monthRange.startString;
                  const monthEnd = monthRange.endString;
                  const daysInMonth = monthRange.daysInMonth;
                  monthlyDate.textContent = monthStart.split('/').slice(1).join('/') + ' - ' + monthEnd.split('/').slice(1).join('/') + ' (' + daysInMonth + '天)';
              }
              
              // 显示今年日期范围（1月至12月）
              if (yearlyDate) {
                  const yearRange = getYearRange(now);
                  const yearStart = yearRange.startString;
                  const yearEnd = yearRange.endString;
                  yearlyDate.textContent = yearStart + ' - ' + yearEnd;
              }
          }
  
          // 加载统计信息
          async function loadSummary(period = currentPeriod) {
              try {
                  const response = await fetch('/api/summary?period=' + period);
                  const summary = await response.json();
                  
                  document.getElementById('periodIncome').textContent = '¥' + summary.totalIncome.toFixed(2);
                  document.getElementById('periodExpense').textContent = '¥' + summary.totalExpense.toFixed(2);
                  document.getElementById('periodBalance').textContent = '¥' + summary.balance.toFixed(2);
                  
                  currentPeriod = period;
                  updateDateDisplay(); // 更新日期显示
              } catch (error) {
                  console.error('加载统计失败:', error);
              }
          }
  
          // 统计周期切换
          document.querySelectorAll('.summary-tab').forEach(tab => {
              tab.addEventListener('click', function() {
                  document.querySelectorAll('.summary-tab').forEach(t => t.classList.remove('active'));
                  this.classList.add('active');
                  
                  const period = this.dataset.period;
                  loadSummary(period);
              });
          });
  
          // 添加交易记录
          document.getElementById('transactionForm').addEventListener('submit', async (e) => {
              e.preventDefault();
              
              const transaction = {
                  type: currentType,
                  amount: document.getElementById('amount').value,
                  category: document.getElementById('category').value,
                  description: document.getElementById('description').value
              };
  
              try {
                  await fetch('/api/transactions', {
                      method: 'POST',
                      headers: {
                          'Content-Type': 'application/json',
                      },
                      body: JSON.stringify(transaction)
                  });
  
                  // 重置表单
                  document.getElementById('transactionForm').reset();
                  
                  // 重新加载记录
                  await loadTransactions();
              } catch (error) {
                  console.error('添加失败:', error);
                  alert('添加失败，请重试');
              }
          });
  
          // 删除交易记录
          async function deleteTransaction(id) {
              if (!confirm('确定要删除这条记录吗？')) {
                  return;
              }
  
              try {
                  await fetch(\`/api/transactions/\${id}\`, {
                      method: 'DELETE'
                  });
                  
                  await loadTransactions();
              } catch (error) {
                  console.error('删除失败:', error);
                  alert('删除失败，请重试');
              }
          }
  
          // 退出登录
          async function logout() {
              try {
                  await fetch('/api/auth/logout', {
                      method: 'POST'
                  });
                  window.location.href = '/login';
              } catch (error) {
                  console.error('退出失败:', error);
                  // 即使API失败也重定向到登录页面
                  window.location.href = '/login';
              }
          }
  
          // PWA 安装提示
          let deferredPrompt;
  
          window.addEventListener('beforeinstallprompt', function(e) {
              e.preventDefault();
              deferredPrompt = e;
              
              // 显示安装提示（可选）
              if (document.getElementById('install-btn') === null) {
                  const installBtn = document.createElement('button');
                  installBtn.id = 'install-btn';
                  installBtn.textContent = '📱 安装到手机';
                  installBtn.style.cssText = 'position: fixed; bottom: 20px; right: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; padding: 12px 20px; border-radius: 25px; font-size: 14px; font-weight: 500; cursor: pointer; box-shadow: 0 4px 15px rgba(0,0,0,0.2); z-index: 1000; transition: transform 0.2s;';
                  
                  installBtn.addEventListener('mouseenter', () => {
                      installBtn.style.transform = 'translateY(-2px)';
                  });
                  
                  installBtn.addEventListener('mouseleave', () => {
                      installBtn.style.transform = 'translateY(0)';
                  });
                  
                  installBtn.addEventListener('click', async function() {
                      if (deferredPrompt) {
                          deferredPrompt.prompt();
                          const { outcome } = await deferredPrompt.userChoice;
                          console.log('User response to the install prompt: ' + outcome);
                          deferredPrompt = null;
                          installBtn.remove();
                      }
                  });
                  
                  document.body.appendChild(installBtn);
                  
                  // 5秒后自动隐藏
                  setTimeout(() => {
                      if (installBtn && installBtn.parentNode) {
                          installBtn.remove();
                      }
                  }, 5000);
              }
          });
  
          // 初始化
          updateCategories();
          loadTransactions();
          loadSummary('daily'); // 默认加载每日统计
          updateDateDisplay(); // 初始化日期显示
      </script>
  </body>
  </html>`;
  }
