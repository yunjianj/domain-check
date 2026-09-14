// src/index.js
//
// 路由架构：
//   /         → 公开页面（只读展示，服务端脱敏注入，无 API 调用）
//   /admin    → 管理页面（需密码鉴权，可操作）
//   /login    → 登录页（POST 成功后跳转 /admin）
//   /logout   → 清除 Cookie，跳转回 /
//   /api/*    → 全部 API 均需鉴权（公开页不调用 API）
//
// 定时检查：由 Cloudflare 控制台的 Cron Trigger 触发（如 0 1,13 * * *，UTC），
// 不提供环境变量配置时间，也不提供手动触发端点，详见 src/schedule.js。

import { getConfig } from './utils';
import { HTML_TEMPLATE } from '../frontend/index';
import { onRequest as configApi } from './api/config';
import { onRequest as domainsApi } from './api/domains';
import { onRequest as whoisApi } from './api/whois';
import { handleScheduledEvent, maybeRunCatchUpCheck } from './schedule';
import { authenticate, handleLogin } from './auth';
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
            return handleLogin(request, env, '/admin');
        }

        // 退出登录：清除登录 Cookie，跳转回首页
        if (pathname === '/logout') {
            const headers = new Headers();
            headers.set('Location', '/');
            headers.set('Set-Cookie', 'auth=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Path=/; Secure; SameSite=Lax');
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
            if (config.password) {
                const authResponse = await authenticate(request, env);
                if (authResponse) return authResponse;
            }
            const context = { request, env, ctx, next: () => {} };
            if (pathname === '/api/domains') { return domainsApi(context); }
            return new Response('API Not Found', { status: 404 });
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
            if (config.password) {
                const authResponse = await authenticate(request, env);
                if (authResponse) return authResponse;
            }
            return new Response(HTML_TEMPLATE(
                config.siteName, config.siteIcon, config.bgimgURL,
                config.githubURL, config.blogURL, config.blogName,
                true // isAdmin = true
            ), {
                headers: { 
                    'Content-Type': 'text/html;charset=UTF-8',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                }
            });
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