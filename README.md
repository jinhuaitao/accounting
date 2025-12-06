# 通过 Cloudflare Workers 面板部署记账应用

本指南将教如何完全通过网页界面部署记账应用，无需使用命令行工具。

## 🚀 部署步骤

### 第一步：登录 Cloudflare Dashboard

1. 访问 [https://dash.cloudflare.com](https://dash.cloudflare.com)
2. 使用你的 Cloudflare 账号登录

### 第二步：创建 Workers 服务

1. 在左侧菜单中点击 **"Workers & Pages"**
2. 点击 **"Create Application"** 按钮
3. 选择 **"Create Worker"**
4. 输入应用名称，例如：`accounting-app`
5. 点击 **"Deploy"**
6. Cloudflare KV (ACCOUNTING_KV)：专门用于存储用户会话 (Session) 和系统配置（如密码）。KV 的读取速度极快，非常适合高频的权限验证。
7. Cloudflare R2 (ACCOUNTING_BUCKET)：专门用于存储账单数据 (JSON)。R2 成本更低，且更适合存储“文件”性质的数据。

### 第三步：创建 KV 命名空间

1. 在左侧菜单中点击 **"Workers & Pages"**
2. 在你的应用名称下点击 **"KV"**
3. 点击 **"Create a namespace"**
4. 输入命名空间名称：`ACCOUNTING_KV`
5. 点击 **"Add"**

**重要：** 记下生成的 **Namespace ID**，稍后会用到。

### 第四步：配置 KV 绑定

1. 返回你的 Worker 应用页面
2. 点击 **"Settings"** 标签
3. 在左侧菜单中点击 **"Variables"**
4. 向下滚动到 **"KV namespace bindings"** 部分
5. 点击 **"Add binding"**
6. 填写以下信息：
   - **Variable name**: `ACCOUNTING_KV`
   - **KV namespace**: 选择刚才创建的 `ACCOUNTING_KV` 命名空间
7. 点击 **"Save"**

### 第五步：配置 R2 绑定

创建 R2 存储桶：创建一个新的 Bucket（例如命名为 aurora-ledger）。
绑定 R2 到 Worker：
进入 Worker 的 Settings -> Variables -> R2 Bucket Bindings。
变量名 (Variable name) 填写：ACCOUNTING_BUCKET (必须完全一致)。
选择您刚才创建的 Bucket。

### 第六步：上传代码

Cloudflare Turnstile 验证的具体指南。

这一修改涉及前端（显示验证码）和后端（验证 Token）两个部分。

准备工作
在开始代码修改前，请前往 Cloudflare Dashboard > Turnstile：
创建一个新的 Widget。
获取 Site Key (用于前端 HTML)。
获取 Secret Key (用于后端 Worker 验证)。
在 Worker 的设置 (Settings) > 变量 (Variables) 中，添加一个名为 TURNSTILE_SECRET 的环境变量，填入你的 Secret Key。
修改第742行里找到 data-sitekey="REPLACE_WITH_YOUR_SITE_KEY"，将其替换为你自己的 Site Key

### 第七步：上传代码

1. 点击 **"Quick edit"** 或返回 Worker 主页面点击 **"Edit code"**
2. 删除默认的代码（类似 `export default { ... }` 的内容）
3. 复制我们项目中的 `index.js` 文件的全部内容
4. 粘贴到编辑器中
5. 点击 **"Save and Deploy"**

### 第八步：设置密码（可选）

1. 部署后，访问你的应用 URL
2. 注册账号和密码
3. 登录

### 第九步：测试应用

1. 部署成功后，你会看到一个 Workers URL，类似：
   ```
   https://accounting-app.your-subdomain.workers.dev
   ```
2. 在浏览器中打开这个 URL
3. 输入密码 `自定义` 登录
4. 开始使用记账应用

## 📝 代码内容

需要复制到 Cloudflare Workers 编辑器的完整代码位于：
```
index.js
```

这个文件包含了：
- 注册页面和主应用页面
- 密码认证逻辑
- 每日/每月统计切换
- HTML 页面（包含所有样式和 JavaScript）
- API 路由处理
- KV 数据存储逻辑
- CORS 配置

## 🎯 应用特性

- **简化分类**: 仅保留"现金"分类，简化记账流程
- **默认选择**: 分类自动选择"现金"
- **收入优先**: 收入按钮放在前面，默认选中
- **默认描述**: 描述字段默认值为"微信"
- **每日统计**: 显示当天的收支情况
- **每月统计**: 显示当月的收支汇总
- **实时切换**: 点击顶部标签切换统计周期

## 🚀 PWA 功能

- **可安装**: 支持安装到手机主屏幕和桌面
- **离线使用**: 基本功能支持离线访问
- **原生体验**: 全屏显示，无浏览器界面
- **快速启动**: 预缓存资源，启动迅速
- **智能提示**: 自动显示安装按钮，5秒后隐藏

## 📱 现代化移动端优化

### 🎨 视觉设计
- **玻璃态界面**: 毛玻璃效果，半透明背景
- **动态渐变**: 浮动动画，视觉层次丰富
- **现代卡片**: 圆角设计，阴影效果
- **色彩系统**: 协调的色彩搭配

### ✨ 交互动画
- **微交互**: 按钮悬停、点击反馈
- **页面转场**: 平滑的动画过渡
- **加载动画**: 登录页面弹跳效果
- **状态反馈**: 实时的视觉响应

### 📱 用户体验
- **触摸优化**: 按钮大小适合手指操作
- **手势友好**: 支持滑动、点击等手势
- **防iOS缩放**: 输入框16px字体
- **智能布局**: 自适应不同屏幕尺寸
- **色彩编码**: 收入绿色，支出红色边框

### 🔧 技术特性
- **CSS动画**: cubic-bezier缓动函数
- **响应式设计**: 多断点适配
- **性能优化**: GPU加速动画
- **无障碍**: 语义化HTML结构

## 🔐 安全特性

- **密码保护**: 通过 KV 自定义
- **会话管理**: 24小时自动过期
- **安全Cookie**: HttpOnly 和 SameSite 保护
- **CSRF防护**: 同站 Cookie 策略


## 📱 移动端使用

应用已经优化了移动端体验，可以在手机浏览器中正常使用所有功能。

## 🔄 更新应用

如果需要更新代码：

1. 进入 Workers Dashboard
2. 选择你的应用
3. 点击 **"Edit code"**
4. 修改代码
5. 点击 **"Save and Deploy"**

## 🐛 故障排除

### 常见问题

1. **KV 读写失败**
   - 检查 KV 绑定是否正确配置
   - 确认 Variable name 是 `ACCOUNTING_KV`

2. **CORS 错误**
   - 确保代码中有正确的 CORS 头部设置
   - 检查 API 请求路径是否正确

3. **页面无法加载**
   - 检查 Workers URL 是否正确
   - 查看实时日志（点击 **"View logs"**）

### 查看日志

1. 在 Worker 应用页面点击 **"Logs"**
2. 可以看到实时的请求和错误信息
3. 对于调试 API 问题非常有帮助

## 📊 监控使用情况

在 **"Analytics"** 标签页中可以查看：
- 请求量统计
- 错误率
- 响应时间
- 地理分布

这样你就完全通过网页界面成功部署了记账应用！🎉
