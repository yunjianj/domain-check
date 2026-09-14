// src/turnstile.js
//
// Cloudflare Turnstile 人机验证（登录防爆破）
// ----------------------------------------------------------------------------
// 目的：阻断针对 /login 的密码爆破。密码比较本身已经是常量时间比较，但真正能挡住
// 自动化尝试的是「必须在真实浏览器里通过一次挑战」——这正是 Turnstile 的作用。
//
// 配置（两个环境变量，均不提供默认值）：
//   TURNSTILE_SITE_KEY   —— 站点密钥，公开，渲染进登录页（浏览器可见）
//   TURNSTILE_SECRET_KEY —— 私钥，仅服务端用于调用 siteverify，绝不下发到前端
//
// 三种状态（见 turnstileState）：
//   disabled       两个都没配置 → 登录页照常渲染，仅校验密码（向后兼容）
//   enabled        两个都配置了 → 渲染组件，并要求服务端校验通过
//   misconfigured  只配了其中一个 → 拒绝登录并提示补全配置
//                  （安全控制半配等于失效，绝不能静默降级成「不校验」）
//
// 校验要点（依据 Cloudflare 官方文档）：
//   - 令牌有效期 300 秒且只能用一次，重复使用会返回 timeout-or-duplicate；
//     因此校验失败后必须重新渲染/重置组件，登录页每次失败都整页重渲染，天然满足；
//   - 客户端验证毫无意义（令牌可以被伪造），必须调用 siteverify 由服务端判定；
//   - 校验失败一律 fail-closed：网络异常、超时、非 2xx 响应都按「未通过」处理，
//     绝不出现「验证服务不可用所以放行」这种退让。

// 必须使用官方文档给定的确切地址；代理或缓存该文件会导致后续更新后失效
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// 组件会在表单内自动注入该名称的隐藏字段，值为待校验的令牌
export const TURNSTILE_RESPONSE_FIELD = 'cf-turnstile-response';

// 组件上声明的 action，校验时用于确认令牌确实来自本登录表单
export const TURNSTILE_ACTION = 'login';

// 调用 siteverify 的超时上限：宁可判定失败，也不让登录请求长时间挂起
const VERIFY_TIMEOUT_MS = 6000;

// 令牌长度上限（官方文档：最大 2048 字符）
const MAX_TOKEN_LENGTH = 2048;

/**
 * 判定 Turnstile 的启用状态。
 *
 * @returns {'disabled'|'enabled'|'misconfigured'}
 */
export function turnstileState(config) {
    const siteKey = (config && config.turnstileSiteKey) || '';
    const secret = (config && config.turnstileSecret) || '';
    if (!siteKey && !secret) return 'disabled';
    if (siteKey && secret) return 'enabled';
    return 'misconfigured';
}

/** 取访客 IP（仅用于 siteverify 的 remoteip 参数） */
function clientIp(request) {
    if (!request || !request.headers) return '';
    const raw = request.headers.get('CF-Connecting-IP')
        || request.headers.get('X-Forwarded-For')
        || '';
    return raw.split(',')[0].trim();
}

// siteverify 错误码 → 对用户而言的原因分类
//   invalid     用户侧问题：令牌缺失/无效/已用过，重新完成验证即可
//   config      管理员侧问题：密钥填错或缺失，用户无能为力，需给出明确提示
//   unavailable 服务侧临时问题：稍后重试
const CODE_REASON = {
    'missing-input-response': 'invalid',
    'invalid-input-response': 'invalid',
    'timeout-or-duplicate': 'invalid',
    'missing-input-secret': 'config',
    'invalid-input-secret': 'config',
    'bad-request': 'unavailable',
    'internal-error': 'unavailable',
};

/**
 * 服务端校验 Turnstile 令牌。
 *
 * @param {object} config  getConfig() 的返回值（读取 turnstileSecret）
 * @param {Request} request 用于取访客 IP
 * @param {string} token    表单里的 cf-turnstile-response
 * @returns {Promise<{ok: true} | {ok: false, reason: 'invalid'|'config'|'unavailable', codes: string[]}>}
 */
export async function verifyTurnstile(config, request, token) {
    const secret = (config && config.turnstileSecret) || '';
    if (!secret) return { ok: false, reason: 'config', codes: ['missing-input-secret'] };

    // 令牌缺失/类型不对/超长 —— 无需请求 siteverify，直接判定未通过
    if (typeof token !== 'string' || !token) {
        return { ok: false, reason: 'invalid', codes: ['missing-input-response'] };
    }
    if (token.length > MAX_TOKEN_LENGTH) {
        return { ok: false, reason: 'invalid', codes: ['invalid-input-response'] };
    }

    const payload = { secret, response: token };
    const ip = clientIp(request);
    if (ip) payload.remoteip = ip;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    let result;
    try {
        const res = await fetch(SITEVERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        if (!res.ok) {
            console.error('[Turnstile] siteverify 返回非 2xx 状态:', res.status);
            return { ok: false, reason: 'unavailable', codes: [`http-${res.status}`] };
        }
        result = await res.json();
    } catch (error) {
        // 超时（AbortError）或网络异常：不放行，交由用户稍后重试
        console.error('[Turnstile] siteverify 请求失败:', (error && error.message) || error);
        return { ok: false, reason: 'unavailable', codes: ['network-error'] };
    } finally {
        clearTimeout(timer);
    }

    if (!result || result.success !== true) {
        const codes = Array.isArray(result && result['error-codes']) && result['error-codes'].length
            ? result['error-codes']
            : ['invalid-input-response'];
        // 优先级：配置错误 > 服务不可用 > 用户侧未通过
        const reasons = codes.map(c => CODE_REASON[c] || 'invalid');
        const reason = reasons.includes('config') ? 'config'
            : reasons.includes('unavailable') ? 'unavailable'
                : 'invalid';
        console.warn('[Turnstile] 校验未通过:', codes.join(', '));
        return { ok: false, reason, codes };
    }

    // action 校验：仅当 siteverify 返回了 action 时才比对，避免误伤（例如未声明 action 的场景）
    if (result.action && result.action !== TURNSTILE_ACTION) {
        console.warn('[Turnstile] action 不匹配:', result.action);
        return { ok: false, reason: 'invalid', codes: ['action-mismatch'] };
    }

    return { ok: true };
}
