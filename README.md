# 极光记账 · Cloudflare Workers 版

一个跑在 Cloudflare Workers 上的个人记账 PWA：账号登录、收支记录、日/周/月/年统计、
可安装到手机主屏、支持离线浏览。数据存在你自己的 Cloudflare 账号里。

- **计算**：Cloudflare Workers（免费额度 10 万次请求/天）
- **账号与会话**：Workers KV
- **账单数据**：R2 对象存储（每个用户一个 `transactions_<userId>.json`）
- **前端**：零构建，单文件内联 HTML/CSS/JS + Chart.js + PWA

---

## 🎛️ 选择部署版本

仓库里有**两个独立的 Worker**，部署时二选一（也可以都部署，互不影响）：

| | 个人版 | 多人注册版 |
| --- | --- | --- |
| 入口文件 | `index.js` | `Multiplayer.js` |
| 配置文件 | `wrangler.jsonc` | `wrangler.multiplayer.jsonc` |
| Worker 名称 | `aurora-accounting` | `aurora-accounting-multi` |
| 适用场景 | 自己一个人用 | 家人 / 朋友各自注册账号 |
| 找回密码 | 无 | 用安全问题找回 |
| 人机验证 | Turnstile，可在应用内 ⚙️ 系统设置里开 | 注册时的算术题（轻量，挡不住有心人） |
| 应用内系统设置 | 有 | 无 |
| 注册限流 | 无（靠 Turnstile 兜） | 有，20 次/小时/IP |

**在 Cloudflare 上怎么选**：连接同一个仓库，只改 **Deploy command** 这一行：

| 想部署 | Deploy command 填 |
| --- | --- |
| 个人版 | `npx wrangler deploy` |
| 多人注册版 | `npx wrangler deploy -c wrangler.multiplayer.jsonc` |

两个版本的 Worker 名称不同，所以**自动创建出来的 KV / R2 是两套独立资源**，
数据完全隔离，可以放心同时部署两个。

> 想让两个版本**共用同一份数据**？把 `wrangler.multiplayer.jsonc` 里的 `name`
> 改成和 `wrangler.jsonc` 一样即可。两边的账号记录格式是兼容的（多人版多存了
> 安全问题和答案哈希，个人版会忽略这些字段），但个人版注册的账号在多人版里
> **没有安全问题，无法找回密码**。

---

## 🚀 一键部署（Dashboard 连接 GitHub，KV / R2 全自动）

**不需要**手动去创建 KV 命名空间，**也不需要**手动创建 R2 存储桶、更不需要手动点绑定。
`wrangler.jsonc` 里已经用「自动供给」写法声明好了，Cloudflare 会在首次部署时自动建好并绑定。

### 第 0 步：确认两个前提

1. 已开通 **Workers**（免费计划即可）。
2. 首次使用 **R2** 的账号，需要先去 Dashboard → **R2** 页面点一次开通/同意条款
   （不点的话自动创建存储桶会失败）。已有 R2 存储桶的账号可跳过。

### 第 1 步：把代码推到 GitHub

```bash
cd accounting-main
git init
git add .
git commit -m "chore: init aurora accounting"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

### 第 2 步：在 Cloudflare 连接仓库（**选版本就在这一步**）

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → 左侧 **Workers & Pages**
2. 点 **Create application** → 在 **Import a repository** 那一栏点 **Get started**
3. 选 **Git account** → 从列表里选中你的仓库
4. 进入 **Configure your project** 表单。**版本就是在这里选的**——关键只有两个字段：

   | 字段 | 个人版 | 多人注册版 |
   | --- | --- | --- |
   | **Project name** | `aurora-accounting` | `aurora-accounting-multi` |
   | **Deploy command** | `npx wrangler deploy` | `npx wrangler deploy -c wrangler.multiplayer.jsonc` |

   同一个表单里其余字段：

   | 字段 | 填什么 |
   | --- | --- |
   | Build command | `npm install` |
   | Root directory | 留空（仓库根目录即项目根目录） |
   | Build variables and secrets | 不用动 |
   | API token | 保持默认（Cloudflare 自动生成） |

   > ⚠️ **Project name 必须和所选配置文件里的 `name` 完全一致**，否则构建直接失败。
   > 这是 Cloudflare 的硬性要求：Dashboard 里的 Worker 名称必须等于 wrangler 配置文件里的 `name`。
   > 个人版对应 `wrangler.jsonc` 的 `aurora-accounting`，多人版对应
   > `wrangler.multiplayer.jsonc` 的 `aurora-accounting-multi`。

5. 点 **Save and Deploy**

#### 两个版本都想部署？

再走一遍上面 1–5 步就行：**同一个仓库**，换一组 **Project name** + **Deploy command**。
两个 Worker 名称不同 → 自动创建两套独立的 KV / R2，互不干扰，可以同时在线。

#### 建好之后想换版本？

Worker → **Settings** → **Build** → 修改 **Deploy command** → 保存。

注意两点：
- 换版本时 **Project name 也要一起改**（要和目标配置文件的 `name` 对上），
  但 Worker 名称在 Dashboard 里改不了，所以**换版本更推荐新建一个 Worker 项目**。
- 构建设置**只对下一次构建生效**，改完要再推一次 commit，或在 Deployments 里点 **Retry build**。

#### 记不住那串 `-c` 参数？

也可以直接用 `package.json` 里的脚本当 Deploy command（Cloudflare 官方支持这种写法）：

| 想部署 | Deploy command 也可以填 |
| --- | --- |
| 个人版 | `npm run deploy` |
| 多人注册版 | `npm run deploy:multiplayer` |

### 第 3 步：看构建日志，确认资源被自动创建

构建日志里会依次出现：

```
🌀 Creating new KV namespace "aurora-accounting-ACCOUNTING_KV"...
🌀 Creating new R2 bucket "aurora-accounting-accounting-bucket"...
✅ Uploaded aurora-accounting
Deployed aurora-accounting triggers
  https://aurora-accounting.<你的子域>.workers.dev
```

打开这个 URL → 注册一个账号 → 开始记账。**至此结束，无需任何额外配置。**

> 部署完成后可以在 Dashboard → Worker → **Settings → Bindings** 里看到
> `ACCOUNTING_KV`（KV Namespace）和 `ACCOUNTING_BUCKET`（R2 Bucket）已经绑好。

### 第 4 步（可选，仅个人版）：在应用内开启人机验证

**不用碰 Cloudflare 控制台**。Turnstile 的密钥存在 KV 里，由管理员在应用内维护。

1. 登录应用，点右上角的 **⚙️** 图标（只有管理员能看到）
2. 去 Dashboard → **Turnstile** → **Add widget** 拿两个密钥，粘贴进去保存
3. 下次打开登录页，验证码就生效了

- **谁可以改**：第一个注册的账号自动成为管理员（右上角才会出现 ⚙️ 入口）。
- **Secret Key 永不回显**：接口只返回掩码（`0xSUPE••••••••9999`），保存时留空表示不修改。
- **开关规则**：Site Key 和 Secret Key 两项都填 → 验证码开启；清空 → 自动关闭。
  想彻底关掉就点「关闭验证码（清空密钥）」，需要点两次确认，防误触。
- 没配置时应用完全可用，只是没有机器人防护。

---

## 📁 文件说明

| 文件 | 作用 |
| --- | --- |
| `wrangler.jsonc` | **个人版**部署配置：KV / R2 绑定（不写 id、不写 bucket_name = 触发自动创建 + 自动绑定） |
| `wrangler.multiplayer.jsonc` | **多人注册版**部署配置，写法同上，Worker 名称不同 |
| `index.js` | 个人版入口：路由、鉴权、API、应用内系统设置、内联前端页面、PWA Manifest、Service Worker |
| `Multiplayer.js` | 多人注册版入口：多账号注册 + 安全问题找回密码，无 Turnstile |
| `package.json` | 固定 wrangler 版本，提供两套 `dev` / `deploy` / `tail` / `check` 脚本 |
| `.dev.vars.example` | 本地开发的变量模板（本项目不需要环境变量，留作备用） |
| `.gitignore` | 忽略 `node_modules/`、`.wrangler/`、`.dev.vars` |

### KV 里的数据长这样

| KV Key | 内容 |
| --- | --- |
| `u_<用户名>` | 账号记录：密码盐 + 派生哈希、`userId`、注册时间 |
| `session_<token>` | 登录会话，24 小时过期 |
| `limit_<IP>` | 登录失败计数，15 分钟窗口 |
| `sys_admin` | 管理员账号的 `userId`（第一个注册的用户） |
| `sys_settings` | 系统设置：Turnstile 的 Site Key / Secret Key、更新人、更新时间 |

账单数据不在 KV 里，而是 R2 上的 `transactions_<userId>.json`。

### 自动供给（auto-provisioning）到底是怎么触发的

Cloudflare 的规则是——**绑定里不写资源 ID**，就会在部署时自动创建资源：

```jsonc
// KV：不写 id → 自动创建 + 自动绑定
"kv_namespaces": [
  { "binding": "ACCOUNTING_KV" }
],

// R2：不写 bucket_name → 自动创建 + 自动绑定
"r2_buckets": [
  { "binding": "ACCOUNTING_BUCKET" }
]
```

对比一下「手动创建」的写法，差别就在于多出来的那两个字段：

```jsonc
"kv_namespaces": [{ "binding": "ACCOUNTING_KV", "id": "abcd1234..." }],
"r2_buckets":   [{ "binding": "ACCOUNTING_BUCKET", "bucket_name": "aurora-ledger" }]
```

自动创建的资源会以 **Worker 名称作为前缀**命名，所以把 Worker 叫 `aurora-accounting`
时，KV 会叫 `aurora-accounting-ACCOUNTING_KV` 之类。

> ⚠️ **一个必须知道的坑**：通过 Dashboard（GitHub）部署时，资源会被创建，
> 但资源 ID **不会写回你的仓库**（只在 Dashboard 里能查到）。
> 所以如果你之后想在本地跑 `wrangler deploy`，请先去 Dashboard 复制资源 ID，
> 填回 `wrangler.jsonc`，否则 wrangler 会当成「没有 ID」再创建一套新资源，
> 导致线上数据看起来「丢了」。
>
> 如果一开始就用本地 `wrangler deploy`，wrangler 会自动把 ID 写回配置文件，没有这个问题。

---

## 💻 本地开发

```bash
npm install

# 个人版
npm run dev          # http://localhost:8787
npm run check        # dry-run 构建，验证配置和代码
npm run deploy       # 部署个人版

# 多人注册版
npm run dev:multiplayer
npm run check:multiplayer
npm run deploy:multiplayer

# 线上日志
npm run tail
npm run tail:multiplayer
```

本地模式下 wrangler 会在 `.wrangler/` 下自动创建**本地** KV / R2 模拟资源，
数据落在本地磁盘，不会碰线上数据。两个版本各用各的本地资源，互不干扰。

> 本地起个人版后，第一个注册的账号就是管理员，右上角会出现 ⚙️ 入口，
> 可以直接在本地把系统设置这一套流程跑通。

---

## 🔧 常见问题

**构建日志报 `KV namespace ... not found` / `binding not found`**
配置文件的 `name` 和 Dashboard 里填的 Project name 不一致，改一致即可。
注意多人版的名称是 `aurora-accounting-multi`。

**R2 创建失败 / 报权限错误**
账号还没开通 R2。去 Dashboard → R2 页面点一次开通（同意条款）后重新部署。

**部署成功但打开是 500**
看 Dashboard → Worker → **Logs** 的实时日志。最常见原因是 KV / R2 绑定没生效——
到 **Settings → Bindings** 确认 `ACCOUNTING_KV` 和 `ACCOUNTING_BUCKET` 都在。

**两个版本都部署了，但数据串了 / 找不到账号**
正常情况下不会——两个版本的 Worker 名称不同，KV / R2 是两套独立资源。
除非你把 `wrangler.multiplayer.jsonc` 的 `name` 改成了和个人版一样。

**多人版「查找账号」提示账号不存在**
可能是答案限流触发了。这个接口按 IP 限制 **10 次 / 15 分钟**，
重置密码是 **5 次 / 15 分钟**（答案错误也会计数）。等一会儿再试。

**多人版重置密码后所有设备都被登出了**
这是有意设计——改密会作废该账号的所有旧会话，避免密码泄露后旧会话继续可用。

**注册后一直停在「自动登录失败」**
这是旧版本 `index.js` 的 bug（Turnstile token 一次性，注册后又拿同一个 token 去登录）。
当前版本已改为注册接口直接下发登录 Cookie，不再有这个问题。

**登录页看不到验证码**
正常现象（仅个人版有验证码）——说明「系统设置」里还没配密钥，此时人机验证是关闭的，
不影响使用。配好 Site Key + Secret Key 后，下次打开登录页就会出现验证码。

**保存了密钥但验证码还是不出来**
先确认两项都填了（只填一项接口会直接报 400）。另外密钥是**服务端渲染**进登录页的，
需要重新打开一次登录页才生效，不是即时刷新。

**右上角没有 ⚙️ 系统设置入口**
只有个人版的管理员能看到。规则是「第一个注册的账号」。想换管理员的话，去
Dashboard → Worker → KV 里把 `sys_admin` 的值改成目标账号的 `userId` 即可。
（多人版没有系统设置页。）

**我忘了哪个账号是管理员**
第一个注册的那个。Dashboard → Worker → KV 里看 `sys_admin` 的值，或直接看应用里
哪些账号能打开 ⚙️。

**登录很慢 / 偶尔报 1102（Worker 超时）**
密码哈希是 10 万次 PBKDF2 迭代，属于有意为之的「慢」。如果免费计划下频繁触发
CPU 超时，把 `hashPassword()` 里的 `iterations` 从 `100000` 降到 `50000`
（两个文件都要改），安全性仍可接受。

**手机上装不上 PWA**
PWA 安装要求 HTTPS + 有效 Manifest。`*.workers.dev` 自带 HTTPS，直接用即可；
iOS 需要在 Safari 里「添加到主屏幕」。

**统计数字不对**
所有统计接口按**北京时间（UTC+8）**归集，且不会显示未来的日期。
金额在写入时会四舍五入到分，非法金额（负数、非数字）会被直接拒绝。

---

## 🔐 安全设计

两个版本共用的部分：

- 密码用 **PBKDF2-SHA256 + 随机盐，10 万次迭代**，只存派生结果，不存明文
- 会话 Token 为 **32 字节 CSPRNG 随机值**，存 KV，24 小时过期
- Cookie 带 `HttpOnly` + `SameSite=Strict` + `Secure`
- 所有用户输入经过 HTML 转义；账单字段有长度上限
- 每个用户的数据按 `userId` 隔离在独立 R2 对象中，删除时校验归属
- 响应头包含 CSP、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`
- Service Worker **不缓存任何 `/api/` 响应**，避免同一设备换账号后读到上一个人的账单
- 路由守卫对 API 返回 **401 JSON**、对页面返回 **302 + Location**（不会把 HTML 塞给 fetch）
- 账单入参强校验：类型白名单、金额必须为正数并四舍五入到分

个人版额外：

- 登录失败按 IP 计数，**15 分钟内 5 次**即锁定
- **系统设置仅管理员可读写**，普通账号访问 `/api/settings` 一律 403
- Turnstile 的 **Secret Key 只存服务端 KV，接口只返回掩码**，永不下发到浏览器

多人注册版额外：

- 注册限流 **20 次 / 小时 / IP**
- 「查找账号」限流 **10 次 / 15 分钟 / IP**，且失败文案统一，防止批量枚举已注册用户名
- 「重置密码」限流 **5 次 / 15 分钟 / IP**，**答案错误也计数**，挡住暴力猜安全问题
- 改密后**作废该账号所有旧会话**
- 新密码长度校验（≥6 位）

> ⚠️ 多人版的注册验证码是**前端算术题**，只能挡最粗糙的脚本，挡不住有心人。
> 如果要开放给不受信任的人注册，建议给多人版也接上 Turnstile。
>
> 关于 Secret Key 的存放位置，有个取舍需要知道（仅个人版）：
> Cloudflare 的**环境变量 Secret 是加密存储**的，而**KV 的值不是**（虽然只有你的
> Worker 能读到）。放进 KV 换来的是「部署后不用碰控制台、随时能在应用里改」。
> 如果你更看重静态加密，把 `getSystemSettings()` 改成优先读 `env.TURNSTILE_SECRET_KEY`
> 即可，代码只有几行。
>
> 这是个人/家庭自用项目，安全强度按「一个人自己用」设计。
> 若要多租户对外提供服务，建议补齐：邮箱验证、操作审计、数据导出/注销。


---

## 📄 许可

自用项目，随意取用。
