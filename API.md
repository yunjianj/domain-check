# API 接口

## BASE_URL

```
https://your-domain-check.workers.dev
```

> 鉴权说明：除 `/api/config` 与 `/api/whois/<域名>` 外，其余接口均需在 Cookie 中携带 `auth=<会话 token>`。
> **`PASSWORD` 不会写入 Cookie**：调用 `POST /login` 登录后，由服务端下发一个随机会话 token，
> 会话记录存放在 KV 的 `session:<token>`，默认空闲 7 天过期并自动删除（可用 `SESSION_TTL` 调整）。
> 若 Worker 未配置 `PASSWORD` 环境变量，这些接口一律返回 `503`（fail-closed，不会跳过鉴权）。

## POST /login —— 登录并获取会话 token

- 请求示例（无需鉴权；把服务端下发的 Cookie 保存下来即可复用）

```bash
curl -i -X POST https://your-domain-check.workers.dev/login \
     -d 'password=你的密码' \
     -c cookies.txt
```

- 若启用了人机验证（同时配置 `TURNSTILE_SITE_KEY` 与 `TURNSTILE_SECRET_KEY`），必须额外提交
  Turnstile 令牌，否则一律拒绝（连密码都不会比对）：

```bash
curl -i -X POST https://your-domain-check.workers.dev/login \
     -d 'password=你的密码' \
     -d 'cf-turnstile-response=客户端组件返回的令牌' \
     -c cookies.txt
```

> 令牌只能使用一次且 5 分钟内有效，脚本化调用需每次重新获取。

- 返回示例（密码正确时 302 跳转，并下发 HttpOnly 会话 Cookie）

```
HTTP/1.1 302 Found
Location: /admin
Set-Cookie: auth=<随机 token>; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
```

- 登录失败时返回 `200` + 登录页（页面内显示具体原因：密码错误 / 人机验证未通过或已过期 /
  人机验证服务暂时不可用），不会下发 Cookie、也不会建立会话记录
- 若只配置了 `TURNSTILE_SITE_KEY` 与 `TURNSTILE_SECRET_KEY` 中的一个，返回 `503`（配置不完整）

> 后续请求用 `-b cookies.txt` 携带该 Cookie。
> 退出登录调用 `GET /logout`，会删除 KV 中的会话记录并清除 Cookie。

## GET /api/config —— 获取项目全局配置

- 请求示例（无需鉴权）

```bash
curl -X GET https://your-domain-check.workers.dev/api/config
```

- 返回示例

```json
{
  "siteName": "域名到期监控",
  "siteIcon": "https://pan.811520.xyz/icon/domain-check.png",
  "bgimgURL": "https://pan.811520.xyz/icon/bg_light.webp",
  "githubURL": "https://github.com/yutian81/domain-check",
  "blogURL": "https://blog.811520.xyz/post/2025/04/domain-autocheck/",
  "blogName": "QingYun Blog",
  "days": 30
}
```

> 定时检查由 Cloudflare 的 Cron Trigger 触发，不提供手动触发端点；
> 计划表达式在 `Worker → 设置 → 触发器 → Cron 触发器` 维护，详见 `src/schedule.js`。

## GET /api/domains —— 获取所有域名列表

- 请求示例（需要鉴权）

```bash
curl -X GET https://your-domain-check.workers/api/domains \
     -b cookies.txt
```

- 返回示例

```json
[
  {
    "domain": "site-a.com",
    "registrationDate": "2022-10-01",
    "expirationDate": "2025-10-01",
    "system": "Cloudflare",
    "systemURL": "https://cloudflare.com",
    "registerAccount": "admin@site-a.com",
    "groups": "主要"
  },
  {
    "domain": "backup-b.net",
    "registrationDate": "2023-01-15",
    "expirationDate": "2026-01-15",
    "system": "Aliyun",
    "systemURL": "https://aliyun.com",
    "registerAccount": "backup@b.net",
    "groups": "备份, 测试"
  }
]
```

## POST /api/domains —— 添加或编辑域名

- 请求示例（需要鉴权）

```bash
curl -X POST https://your-domain-check.workers.dev/api/domains \
     -H "Content-Type: application/json" \
     -b cookies.txt \
     -d '{
            "domain": "new-domain.com",
            "registrationDate": "2023-08-08",
            "expirationDate": "2026-08-08",
            "system": "GoDaddy",
            "systemURL": "https://godaddy.com",
            "registerAccount": "contact@new-domain.com",
            "groups": "新购"
          }'
```

- 返回示例

```json
{
  "success": true, 
  "domain": "example.com"
}
```

## PUT /api/domains —— 批量更新域名列表（用于编辑）

- 请求示例

```bash
curl -X PUT https://your-domain-check.workers.dev/api/domains \
     -H "Content-Type: application/json" \
     -b cookies.txt \
     -d '[
            { "domain": "site-a.com", "expirationDate": "2025-10-01", "groups": "主要" },
            { "domain": "site-c-new.net", "expirationDate": "2026-08-08", "groups": "次要" }
         ]'
```


- 返回示例

```json
{
  "success": true, 
  "count": 2
}
```

## DELETE /api/domains —— 删除域名

- 请求示例：删除单个域名

```bash
curl -X DELETE https://your-domain-check.workers.dev/api/domains \
     -H "Content-Type: application/json" \
     -b cookies.txt \
     -d '{ "domain": "domain-to-delete.com" }'
```

- 返回示例：删除单个域名

```json
{
  "success": true, 
  "message": "域名 domain-to-delete.com 已删除"
}
```

- 请求示例：删除多个域名

```bash
curl -X DELETE https://your-domain-check.workers.dev/api/domains \
     -H "Content-Type: application/json" \
     -b cookies.txt \
     -d '["domain-to-delete-1.com", "domain-to-delete-2.net", "domain-to-delete-3.io"]'
```

- 返回示例：删除多个域名

```json
{
  "success": true,
  "message": "成功删除 2 个域名。",
  "deletedCount": 2
}
```

## GET /api/whois —— whois查询（仅支持一级域名）

- 请求示例（无需鉴权）

```bash
curl -X GET https://your-domain-check.workers/api/whois/<要查询的域名>
```

- 返回示例

```json
{
  "success": true,
  "data": {
    "domain": "github.com",
    "creationDate": "2007-10-09T18:20:50Z",
    "updatedDate": "2024-09-07T09:16:32Z",
    "expiryDate": "2026-10-09T18:20:50Z",
    "registrar": "MarkMonitor",
    "registrarUrl": "http://www.markmonitor.com",
    "nameServers": [
      "dns1.p08.nsone.net",
      "dns2.p08.nsone.net",
      "dns3.p08.nsone.net",
      "dns4.p08.nsone.net",
      "ns-1283.awsdns-32.org",
      "ns-1707.awsdns-21.co.uk",
      "ns-421.awsdns-52.com",
      "ns-520.awsdns-01.net"
    ]
  }
}
```
