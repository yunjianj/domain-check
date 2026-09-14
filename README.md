# 域名到期监控系统

基于 Cloudflare Worker 和 Worker KV 构建的域名到期监控仪表盘，支持自动 WHOIS 查询（含 RDAP 回退）、分组管理、到期提醒等功能。

- 界面预览

<img width="1894" height="879" alt="image" src="https://b2qq.24811213.xyz/2025-11/1763455544-image.webp" />

## 功能特性

- ✅ **双模式访问**：`/` 公开页面（只读、域名脱敏）和 `/admin` 管理页面（需密码、完整操作）
- ✅ **域名管理**：支持一级和二级域名的添加、编辑、删除、克隆
- ✅ **批量操作**：复选框多选、全选、批量删除
- 🔍 **WHOIS 自动查询**：一级域名自动获取注册和到期信息（主源 ip.sb 页面解析，兜底直连注册局 RDAP）
- 📊 **可视化仪表盘**：域名状态概览、进度条、分组展示
- 🔐 **会话鉴权**：登录后下发随机 token（HttpOnly Cookie），会话记录存于 KV，默认空闲 7 天过期并自动清除；退出登录立即注销
- 🛡️ **登录防爆破**：可选启用 Cloudflare Turnstile 人机验证，未通过挑战的请求根本不会进入密码校验
- 💾 **KV 存储**：每个域名独立 key 存储，无并发竞态
- 💾 **数据备份**：支持数据的导出和导入
- 📱 **Telegram 通知**：定时检查并推送即将到期提醒；管理页可一键发送测试消息，立即验证通知配置是否生效
- 🎨 **响应式设计**：支持移动端和桌面端访问
- 🖼️ **精美模态框**：替换浏览器原生 alert/confirm，毛玻璃效果

## 🆕 更新日志

### 2025-07-04
- ✨ **新增续期功能**：域名卡片新增「续期」按钮，支持年/月续费，自动更新到期时间并记录续费周期
- 💎 **全面毛玻璃化**：所有模态框（编辑弹窗、续费弹窗、消息弹窗）统一半透明毛玻璃效果，降低透明度
- 🏷️ **分组标签系统**：域名卡片分组显示为彩色标签；编辑弹窗分组改为标签选择器（下拉选择+自定义输入+空格添加+标签删除）
- 🔽 **智能下拉选择**：注册商名称、注册商地址、注册账号 增加基于已有数据的自动补全下拉选择器
- 🔧 其他 UI 细节优化：卡片间距、标签间距、续费弹窗布局等

## 路由架构

| 路径 | 权限 | 说明 |
|------|------|------|
| `/` | 🔓 公开 | 域名/账号脱敏展示，不可操作 |
| `/admin` | 🔒 需密码 | 完整管理页面，所有操作按钮 |
| `/login` | 🔓 公开 | 登录页，成功后跳转 `/admin`（可启用 Turnstile 人机验证） |
| `/logout` | 🔓 公开 | 注销当前会话（删除 KV 记录）并跳转回首页 |
| `/api/domains` | 🔒 全部需鉴权 | 域名 CRUD API |
| `/api/notify-test` | 🔒 全部需鉴权 | 发送一条 Telegram 测试消息，验证通知配置 |
| `/api/whois/<domain>` | 🔓 公开 | WHOIS 查询 |
| `/api/config` | 🔓 公开 | 前端配置（非敏感字段） |

## 公开页 `/` 特性

- 域名用 `*****` 隐藏前缀，只保留后缀（`example.com` → `*****.com`）
- 注册账号用 `***********` 隐藏
- 无任何操作按钮（添加/编辑/删除/导出/导入）
- 右上角「登录」按钮跳转 `/admin`
- 数据由服务端脱敏后直接嵌入 HTML，前端不调用 API

## 管理页 `/admin` 特性

- 域名卡片右上角复选框，支持多选
- 「全选」按钮切换勾选/取消当前页所有卡片
- 「删除」删除所有勾选的域名
- 「克隆」按钮：以该卡片信息预填充添加表单（域名留空），快速添加同注册商域名
- 「导出」「导入」备份域名数据
- 「测试通知」按当前 `TGID` / `TGTOKEN` 发一条 Telegram 测试消息；未配置会直接提示缺哪个变量，发送失败会把 Telegram 返回的原因显示出来
- 「退出」注销当前会话并跳回首页（下次需重新登录）

## KV 存储说明

- 每个域名存储为独立 key：`domain:<域名>`
- 旧版单一 key (`DOMAIN_LIST`) 数据在首次访问时**自动迁移**到新格式
- 添加/删除/编辑均为原子操作，无读写竞态
- 另有内部 key：
  - `__meta:cron_last_run` — 最近一次成功执行的定时检查时间戳，用于幂等判断与失败后的补跑
  - `__meta:cron_slots` — 从 Cron Trigger 表达式解析出的计划时刻（UTC），补跑据此判断该补哪一档
  - `session:<token>` — 登录会话。值为 `{ createdAt, lastSeen, pv }`（`pv` 为密码指纹）。
    每次校验都会推进 `lastSeen`；空闲超过 `SESSION_TTL` 即失效，校验时主动删除，
    同时写入时已设置 KV 过期时间，到点由 KV 自动清除。退出登录会立即删除对应记录。

## 部署平台：Cloudflare Workers

> [!TIP]
> 不要用「CF 网页管理后台直接连接仓库」的方式部署：那种方式下 KV 绑定和定时触发器的设置完全依赖于 wrangler.toml，
> 文件里没写的部分会在重新部署后丢失（这是 CF worker 链接仓库部署一直以来的 bug）。  
> **因此，项目部署方式改为 github action，以确保相关参数配置持久化**  

### 各配置项归谁管

| 配置项 | 在哪里维护 | 重新部署时会不会被覆盖 |
|--------|-----------|----------------------|
| `name` / `main` / `compatibility_date` | `wrangler.toml` | — |
| KV 绑定（`DOMAIN_KV`） | `wrangler.toml`，ID 在部署时注入 | 每次按文件重建，不会丢 |
| Cron 定时触发器 | **Cloudflare 控制台** | **不会**：文件里刻意不写 `[triggers]`，按 Cloudflare 规则，`triggers` 未声明时部署不触碰已有触发器 |
| 环境变量（`PASSWORD`、`TGID`、`TGTOKEN`、站点信息…） | **Cloudflare 控制台** | **不会**：文件里设了 `keep_vars = true`；加密类型的变量 Wrangler 从不删除 |
| 部署凭据 | GitHub 仓库 `Secrets and variables` | — |

这样 GitHub Action 里**只需要 3 项部署凭据**，业务配置全部留在 Cloudflare 后台，改配置不需要改代码、也不需要重新部署。

### 前置条件
- 先给把本项目点个⭐，再 Fork，[点击直达](https://github.com/yutian81/domain-check/fork)
- 在 [Cloudflare](https://dash.cloudflare.com) 创建一个 KV 空间，名称随意，例如：`DOMAIN_KV`
- 创建完KV后，KV名称右侧有一串字符，就是KV的ID值，保存下来备用

### 设置仓库 action

点开仓库 `settings` → `Secrets and variables` → `Actions`，只需 3 项凭据（放在 `secrets` 或 `variables` 里都能识别，优先读 `secrets`）：

| 名称 | 建议位置 | 说明 |
|------|----------|------|
| `CF_API_TOKEN` | `secrets` | 必须，需要 worker 和 kv 权限 |
| `CF_KV_ID` | `secrets` | 必须，创建 KV 得到的 ID 值 |
| `CF_ACCOUNT_ID` | `variables` | 必须，CF 的账户 ID，**是 ID 不是邮箱账号** |

> [!IMPORTANT]
> **`PASSWORD`、`TGID`、`TGTOKEN`、`CF_CRONS` 都不要放在这里**，它们改在 Cloudflare 控制台维护（见下一节）。
> 旧仓库里若还留着这几项，可以直接删掉，不影响部署。

### 运行 action

- 点击仓库 `actions` → `all workerflows` → `自动部署到 CF worker`
- 点击 `run workflow`
- 等待 action 运行，查看运行日志，点击输出的 `worker 管理后台` 链接
- 日志里还有一项 **「检查 Worker 变量是否就绪」**，它会在部署后列出 Worker 上现有的变量与绑定：
  - 缺少必填的 `PASSWORD` → **这一步会失败**（部署已完成，但管理功能不可用，这正是 fail-closed 的设计），
    日志会给出控制台配置入口，补上后重跑一次 workflow 即可
  - `TGID`/`TGTOKEN`、Turnstile 两个密钥若只配了一个 → 提示「必须成对配置」
  - 万一读取不到变量清单（例如令牌权限不足），只提示、不失败，避免误报

### 在 Cloudflare 控制台配置环境变量

- 进入 CF worker 管理后台，给项目绑定一个自定义域名
- 打开 `设置` → `变量和机密`（旧版叫「变量」），在这里维护**全部**环境变量（`PASSWORD` 必填，其余可选）

| 变量名 | 说明 | 建议类型 | 默认值/示例值 | 必填 |
|--------|------|--------|--------|------|
| `PASSWORD` | 管理页访问密码，**无默认值，必须自行设置** | 加密 | 请设置一个强密码 | ✅ |
| `TGID` | Telegram 机器人 ID（或群/频道 ID） | 加密 | `123456789` | ❌ |
| `TGTOKEN` | Telegram 机器人 token | 加密 | `123456:ABC-...` | ❌ |
| `TURNSTILE_SECRET_KEY` | Turnstile 私钥（机密），服务端校验令牌用 | 加密 | Turnstile 控制台里的 Secret Key | ❌ |
| `TURNSTILE_SITE_KEY` | Turnstile 站点密钥（公开），启用登录人机验证 | 文本 | Turnstile 控制台里的 Site Key | ❌ |
| `SESSION_TTL` | 登录会话的空闲有效期（单位：小时），超时需重新登录 | 文本 | `168`（即 7 天） | ❌ |
| `DAYS` | 到期提醒天数 | 文本 | `30` | ❌ |
| `SITENAME` | 网站名称 | 文本 | `域名到期监控` | ❌ |
| `ICON` | 网站图标 | 文本 | `https://example.com/icon.png` | ❌ |
| `BGIMG` | 背景图片 | 文本 | `https://example.com/bg.png` | ❌ |
| `GITHUB_URL` | GitHub 链接 | 文本 | `https://github.com/yutian81/domain-check` | ❌ |
| `BLOG_URL` | 博客链接 | 文本 | `https://blog.notett.com` | ❌ |
| `BLOG_NAME` | 博客名称 | 文本 | `QingYun Blog` | ❌ |

> [!NOTE]
> **控制台里的变量不会因为后续部署而丢失**，两条保障各管一类：
> - **「加密」类型**（Secrets）由 Cloudflare 单独存储，`wrangler deploy` 从不会删除它们，只有手动删除才会消失；
> - **「文本」类型**（Variables）靠 `wrangler.toml` 里的 `keep_vars = true` 保留——它告诉 Wrangler 不要用配置文件去覆盖控制台里已有的变量。
>
> 因此建议：密码、各类 token 一律选**加密**，其余展示类配置用**文本**即可。
> 想在代码仓库里复现同一份配置时，可以把 TOML 片段贴进 `wrangler.toml` 的 `[vars]`，但那样就又变成「文件是唯一事实来源」了，本项目不采用这种写法。

**关于 `PASSWORD`（安全设计）**

`PASSWORD` 是唯一必填变量，项目**不提供默认密码**。未配置时的行为是 **fail-closed**：

| 路径 | 未配置 `PASSWORD` 时的行为 |
|------|---------------------------|
| `/`（公开首页） | 正常访问，不受影响 |
| `/admin`、`/login` | 返回 `503`，提示去控制台配置密码 |
| 受鉴权的 API（如 `/api/domains`） | 返回 `503`（JSON 错误信息） |
| `/api/config`、`/api/whois/<域名>` | 正常访问（本就公开） |

即「没配密码 = 管理功能不可用」，而不是「没配密码 = 谁都能进」。切勿把 `PASSWORD` 设为空值。

**关于登录会话（Cookie 里存的是什么）**

登录成功后，服务器**不会**把密码写进 Cookie，而是生成一个不可猜测的随机 token：

- Cookie 只携带 `auth=<随机 token>`，并带 `HttpOnly` + `Secure` + `SameSite=Lax`（前端脚本读不到）；
- 会话记录存放在 KV 的 `session:<token>`，值为 `{ createdAt, lastSeen, pv }`，其中 `pv` 为密码指纹；
- **滑动过期**：每次访问都会推进 `lastSeen`，即「一直用就一直有效」；默认**空闲超过 7 天**才失效；
- **过期即删除**：校验发现超时会立刻删除 KV 记录，写入时也设置了 KV 过期时间，到点由 KV 自动清除，
  不需要额外的清扫任务；
- **改密码即全体下线**：`PASSWORD` 变更后，所有旧会话会在下一次校验时被删除并要求重新登录；
- 退出登录会立即删除当前会话记录，而不是只清掉浏览器里的 Cookie。

空闲时长可用 `SESSION_TTL` 调整。为控制 KV 写入量（KV 有每日写入配额），`lastSeen` 并非每次请求都写：
只有距上次刷新超过约 1 小时才写一次，并在同一次响应里续发 Cookie。

**关于登录防爆破（Cloudflare Turnstile，可选）**

`/login` 是唯一可以提交密码的入口，本项目支持给它加一层 Cloudflare Turnstile 人机验证：
自动化工具必须先通过挑战，才有资格让服务端比对一次密码。

启用步骤：

1. 在 [Cloudflare 控制台](https://dash.cloudflare.com) → `Turnstile` → `添加站点`，域名填你给这个 Worker 绑定的自定义域（`*.workers.dev` 也可以）
2. 小组件模式选 `托管`（Managed），拿到 **Site Key** 与 **Secret Key**
3. 回到 Worker → `设置` → `变量和机密`，添加 `TURNSTILE_SITE_KEY`（Site Key）与 `TURNSTILE_SECRET_KEY`（Secret Key）——**两个都要加，或两个都不加**

行为说明：

| 配置情况 | 登录页表现 | 登录结果 |
|----------|-----------|----------|
| 两个都不配 | 与启用前完全一致：无组件、无额外请求 | 仅校验密码（向后兼容） |
| 两个都配 | 显示人机验证组件，未拿到令牌时提交按钮不可点 | **必须先通过服务端校验**，未通过连密码都不比对 |
| 只配其中一个 | 不渲染组件 | 一律 `503` 并提示补全配置（半配 = 失效，绝不静默降级为「不校验」） |

设计要点：

- **服务端校验才是关键**：客户端组件只负责拿令牌，而令牌可以被伪造，因此真正判定的是服务端调用
  `siteverify` 的结果；私钥只存在于 Worker 环境变量里，绝不下发到页面。
- **令牌一次性、5 分钟内有效**：校验失败后页面会整页重渲染，等于自动重置了组件，用户直接重试即可。
- **校验失败一律不放行**：网络异常、超时（6 秒）、非 2xx 响应、密钥错误都按「未通过」处理，
  不会出现「验证服务不可用所以放行」。
- **顺手省掉无意义请求**：未通过人机验证时不会去比对密码，也不会建立会话记录。

> 补充建议：Turnstile 挡的是「自动化程序」，但一个能通过挑战的脚本仍可反复尝试密码。
> 如需更强的兜底，可在 Cloudflare 控制台 → `安全性` → `WAF` → `速率限制规则`
> 给 `POST /login` 加一条限流（例如「同一 IP 每分钟超过 10 次即拦截」）。
> 这部分完全在控制台配置，项目代码不需要改动。

## 定时到期提醒（Cron Trigger）

定时检查**完全由 Cloudflare 的 Cron Trigger 负责**：项目不提供任何环境变量来配置时间，没有手动触发端点，
**也不在 `wrangler.toml` 里声明 `[triggers]`**。

配置方法：`Worker → 设置 → 触发器 → Cron 触发器 → 添加`，填入表达式，例如

```
0 1,13 * * *
```

- 表达式按 **UTC** 计算，北京时间要减 8 小时；上面这条即北京时间 9:00 与 21:00。
- 改时间只需改控制台，**不用改代码、不用重新部署**：程序在每次触发时会从事件自带的 `cron` 字段学习计划，
  并据此判断该补跑哪一档。
- 为什么不在文件里声明？按 Cloudflare 的规则，`triggers` / `crons` 为 `undefined` 时部署会**保留**控制台里已有的触发器；
  而一旦在文件里写了 `crons`，每次部署就会用文件内容**覆盖**控制台配置。
  所以把触发器放在控制台，才能做到「改时间不动代码」。（只有需要彻底清空全部触发器时，才要显式写 `crons = []`。）

Cloudflare 不会自动重试失败的定时任务，因此每次 HTTP 请求时会顺带检查今天已到点但未被覆盖的计划槽位并补跑一次，
详见 `src/schedule.js`。

## 从 9f4d47e 及更早版本升级

旧版本把 `PASSWORD` / `TGID` / `TGTOKEN` 放在 GitHub Actions 的 secrets 里、把 Cron 触发器写在 `wrangler.toml` 的 `[triggers]` 里；
新版本把这两样都搬到 Cloudflare 控制台。**升级不需要迁移数据、不需要重建 KV、也不会中断服务。**

升级步骤：

1. 正常拉取/合并新代码（此时 `wrangler.toml` 已不再声明 `[triggers]`）；
2. 触发一次部署。这一步不会造成任何配置丢失，原因见下表；
3. 打开 `Worker → 设置 → 变量和机密`，把 `PASSWORD` / `TGID` / `TGTOKEN` 改成在控制台维护
   （值可以直接沿用现有的，建议类型选「加密」）；
4. 删除 GitHub 仓库里已不再使用的 `PASSWORD` / `TGID` / `TGTOKEN` secrets 和 `CF_CRONS` variable；
5. 打开 `Worker → 设置 → 触发器 → Cron 触发器`，确认表达式与升级前一致（如 `0 1,13 * * *`）。

升级前后对照：

| 项目 | 9f4d47e | 现在 | 升级时会丢吗 |
|------|---------|------|--------------|
| KV 数据（域名列表、会话） | 绑定名 `DOMAIN_KV` | 同左，仍由 `CF_KV_ID` 注入 | ❌ 不会，绑定名与 key 格式都没变 |
| Cron 触发器 | `wrangler.toml` 的 `[triggers]` | 控制台 | ❌ 不会，未声明 `triggers` 时部署**不触碰**已有触发器 |
| `PASSWORD` / `TGID` / `TGTOKEN` | Actions secrets → `--var` | 控制台变量 | ❌ 不会，`keep_vars = true` 会保留已经部署上去的值 |
| `CF_KV_ID` / `CF_API_TOKEN` / `CF_ACCOUNT_ID` | Actions 凭据 | 同左（三项仍在 Actions 里） | ❌ 不会 |
| 手动触发端点 `/cron` | 有 | 已移除 | — 改为由控制台 Cron 触发，定时检查本身不受影响 |

**升级后第一次部署是「零配置」的**：`keep_vars = true` 会把之前通过 `--var` 推上去的变量原样保留下来，
所以登录和通知不会中断，你可以从容地在控制台里把它们的值改成「控制台维护」。

唯一会消失的是 `/cron` 这个手动触发端点（探活用），它原本就不是定时检查的必要入口。

如果部署日志里「检查 Worker 变量是否就绪」提示缺少 `PASSWORD`，说明控制台里还没配上，按第 3 步补上后重跑即可。

## 前端开发

前端代码模块化在 `frontend/src/` 目录下：

```
frontend/
├── build.js        ← 构建脚本
├── index.js        ← HTML 模板
├── style.js        ← CSS 样式
├── script.js       ← 构建产物（不手动编辑）
└── src/
    ├── 00-config.js   — 常量和全局状态
    ├── 01-utils.js    — 工具函数（含脱敏函数）
    ├── 07-modal.js    — 自定义模态框
    ├── 02-api.js      — 数据操作
    ├── 03-ui.js       — 渲染函数
    ├── 04-form.js     — 表单逻辑
    ├── 05-filters.js  — 筛选搜索
    └── 06-init.js     — 初始化事件绑定
```

修改后运行 `node frontend/build.js` 重新生成 `script.js`。

## 本项目 API 接口

https://github.com/yutian81/domain-check/blob/main/API.md

---

## 感谢 YXVM 与 ZMTO 赞助免费服务器

<a href="https://yxvm.com/aff.php?aff=891">
  <img src="https://github.com/user-attachments/assets/33ad6d6e-e159-4840-b6a3-f1ea3faa9df9" width="48%">
</a>
<a href="https://console.zmto.com/?affid=1598">
  <img src="https://github.com/user-attachments/assets/02a0d439-0283-43fe-a028-1212412b324e" width="48%">
</a>
 
## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！

## ⭐ Star 星星走起
[![Star History Chart](https://api.star-history.com/svg?repos=yutian81/domain-check&type=date&legend=top-left)](https://www.star-history.com/#yutian81/domain-check&type=date&legend=top-left)
