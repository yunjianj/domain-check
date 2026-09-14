// src/index.js
//
// 路由架构：
//   /         → 公开页面（只读展示，服务端脱敏注入，无 API 调用）
//   /admin    → 管理页面（需会话鉴权，可操作）
//   /login    → 登录页（POST 成功后下发会话 Cookie 并跳转 /admin）
//   /logout   → 注销当前会话（从 KV 删除记录）并跳转回 /
//   /api/*    → 全部 API 均需鉴权（公开页不调用 API）
//
// 鉴权：必须显式配置 PASSWORD 环境变量（无默认值）。未配置时管理入口
// （/admin、/login、受鉴权 API）一律返回 503 并提示去控制台配置，
// 采用 fail-closed —— 绝不因为密码为空而跳过鉴权。公开首页 / 不受影响。
//
// 会话：登录成功后 Cookie 中只存放随机 token（不再是密码本身），会话记录存于
// KV 的 `session:<token>`，空闲超过 SESSION_TTL（默认 7 天）即过期并从 KV 删除，
// 详见 src/session.js。
//
// 防爆破：登录页可启用 Cloudflare Turnstile 人机验证。同时配置 TURNSTILE_SITE_KEY
// 与 TURNSTILE_SECRET_KEY 即生效，登录前必须先通过服务端校验；详见 src/turnstile.js。
//
// 定时检查：由 Cloudflare 控制台的 Cron Trigger 触发（如 0 1,13 * * *，UTC），
// 不提供环境变量配置时间，也不提供手动触发端点，详见 src/schedule.js。

import { getConfig } from './utils';
import { HTML_TEMPLATE } from '../frontend/index';
import { onRequest as configApi } from './api/config';
import { onRequest as domainsApi } from './api/domains';
import { onRequest as notifyApi } from './api/notify';
import { onRequest as whoisApi } from './api/whois';
import { handleScheduledEvent, maybeRunCatchUpCheck } from './schedule';
import { authenticate, handleLogin, handleLogout, passwordMissingResponse } from './auth';
import { getDomainsFromKV } from './api/domains';

/** 脱敏域名：只保留 TLD，其余用 ***** 替换 */
function maskDomain(domain) {
    const parts = domain.split('.');
    if (parts.length < 2) return domain;
    const tld = parts.pop();
    const masked = parts.map(() => '*****');
    return [...masked, tld].join('.');
}

/** 脱敏注册账号 */
function maskAccount(account) {
    return account ? '***********' : '';
}

/** 为公开页生成脱敏后的域名列表 */
async function getMaskedDomains(env) {
    const domains = await getDomainsFromKV(env);
    return domains.map(d => ({
        ...d,
        domain: maskDomain(d.domain),
        registerAccount: maskAccount(d.registerAccount),
    }));
}

/**
 * 把会话滑动续期的 Set-Cookie 附加到响应上（未续期时原样返回）。
 * 让浏览器端的 Cookie 有效期跟随服务端会话一起滑动。
 */
function withSessionCookie(response, cookie) {
    if (!cookie) return response;
    const headers = new Headers(response.headers);
    headers.append('Set-Cookie', cookie);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;
        const config = getConfig(env);

        // 定时检查补跑：正常由 Cloudflare Cron Trigger 触发，这里只在今天的计划
        // 槽位尚未被覆盖时（定时任务延迟或失败）补跑一次。后台执行，不阻塞本次请求。
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(maybeRunCatchUpCheck(env).catch(err => {
                console.error('定时检查补跑异常:', err);
            }));
        }
        
        // ----- 公开端点（无需鉴权） -----
        
        // 登录页
        if (pathname === '/login') {
            // PASSWORD 未配置：登录入口不可用（handleLogin 内部同样有守卫，此处显式挡一层）
            if (!config.password) return passwordMissingResponse(config);
            return handleLogin(request, env, '/admin');
        }

        // 退出登录：删除 KV 中的会话记录并清除 Cookie，跳转回首页
        if (pathname === '/logout') {
            const clearedCookie = await handleLogout(env, request);
            const headers = new Headers();
            headers.set('Location', '/');
            headers.set('Set-Cookie', clearedCookie);
            return new Response(null, { status: 302, headers });
        }

        // 前端配置 API（公开，仅暴露非敏感字段）
        if (pathname === '/api/config') {
            const context = { request, env, ctx, next: () => {} }; 
            return configApi(context);
        }

        // WHOIS 查询（公开，用于管理页添加域名）
        if (pathname.startsWith('/api/whois/')) {
            const context = { request, env, ctx, next: () => {} };
            const domain = pathname.replace('/api/whois/', '');
            return whoisApi(context, domain);
        }

        // ----- API 路由（全部需鉴权） -----
        if (pathname.startsWith('/api/')) {
            // PASSWORD 未配置：受鉴权 API 一律拒绝（fail-closed，绝不跳过鉴权）
            if (!config.password) return passwordMissingResponse(config, true);
            const auth = await authenticate(request, env);
            if (!auth.ok) return auth.response;
            const context = { request, env, ctx, next: () => {} };
            let response;
            if (pathname === '/api/domains') {
                response = await domainsApi(context);
            } else if (pathname === '/api/notify-test') {
                // 发送一条 Telegram 测试消息，用于在管理页验证通知是否生效
                response = await notifyApi(context);
            } else {
                response = new Response('API Not Found', { status: 404 });
            }
            return withSessionCookie(response, auth.cookie);
        }

        // ----- 公开首页：服务端脱敏注入，无需 API 调用 -----
        if (pathname === '/') {
            const maskedDomains = await getMaskedDomains(env);
            return new Response(HTML_TEMPLATE(
                config.siteName, config.siteIcon, config.bgimgURL,
                config.githubURL, config.blogURL, config.blogName,
                false, // isAdmin = false
                maskedDomains // 服务端已脱敏的域名列表
            ), {
                headers: { 
                    'Content-Type': 'text/html;charset=UTF-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                }
            });
        }

        // ----- 管理页面（需鉴权） -----
        if (pathname === '/admin') {
            // PASSWORD 未配置：管理页不可访问（fail-closed，绝不跳过鉴权）
            if (!config.password) return passwordMissingResponse(config);
            const auth = await authenticate(request, env);
            if (!auth.ok) return auth.response;
            return withSessionCookie(new Response(HTML_TEMPLATE(
                config.siteName, config.siteIcon, config.bgimgURL,
                config.githubURL, config.blogURL, config.blogName,
                true // isAdmin = true
            ), {
                headers: { 
                    'Content-Type': 'text/html;charset=UTF-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                }
            }), auth.cookie);
        }

        return new Response('Not Found', { status: 404 });
    },

    // Cloudflare Cron Trigger 处理器。
    // 在控制台「Worker → 设置 → 触发器 → Cron 触发器」添加表达式（如 0 1,13 * * *，UTC）
    // 后由此触发；执行标记、幂等与失败回滚见 src/schedule.js。
    async scheduled(event, env, ctx) {
        ctx.waitUntil(handleScheduledEvent(env, event).catch(err => {
            console.error('定时任务执行失败:', err);
        }));
    }
};
