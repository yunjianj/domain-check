// src/session.js
//
// 会话（Session）鉴权
// ----------------------------------------------------------------------------
// 登录成功后不再把密码写进 Cookie，而是：
//   1. 生成一个不可猜测的随机 token（crypto.randomUUID，122 位随机性）；
//   2. 以 `session:<token>` 为 key 存入 KV，值为 { createdAt, lastSeen, pv }；
//   3. Cookie 里只放这个 token（HttpOnly + Secure + SameSite=Lax）。
//
// 因此：Cookie 被读取/泄露也不能反推出密码；改密码即可让所有旧会话失效。
//
// 过期策略：空闲过期（滑动过期）
// ----------------------------------------------------------------------------
//   - 每次成功校验都会推进 lastSeen，即「一直使用就一直有效」；
//   - 当 now - lastSeen > SESSION_TTL（环境变量，小时，默认 168 = 7 天）时判定过期：
//     主动删除 KV 记录并拒绝该会话；
//   - 写入时同时设置 KV 的 expirationTtl，KV 侧到点会自动清除记录，
//     不需要额外的清扫任务 —— 这保证了「过期即从 KV 中删除」。
//
// KV 写入量控制：KV 有每日写入配额，因此并非每个请求都重写 lastSeen。
// 只有距上次刷新超过 refreshInterval（默认 1 小时，且不超过 TTL 的 1/24）时才写一次，
// 并在同一次响应里续发 Cookie，使浏览器端的 Max-Age 与会话状态保持一致。
//
// 密码变更即失效：会话记录里存有密码指纹（SHA-256 前 16 位十六进制）。
// 修改 PASSWORD 后，所有旧会话会在下一次校验时被删除并要求重新登录。

import { getKV } from './api/domains';

// Cookie 名沿用 auth（值已由「密码明文」改为「随机 token」）
export const SESSION_COOKIE = 'auth';

const SESSION_KEY_PREFIX = 'session:';

// 空闲有效期：默认 7 天，上限 1 年（防止误配置成近乎永不过期）
const DEFAULT_TTL_HOURS = 168;
const MAX_TTL_HOURS = 8760;

// 滑动刷新间隔的上下限：至少 60 秒（KV 单 key 写入限流为 1 次/秒），至多 1 小时
const MIN_REFRESH_MS = 60 * 1000;
const MAX_REFRESH_MS = 60 * 60 * 1000;

// isolate 内的刷新节流表，避免并发请求对同一个 key 重复写入
const refreshGuard = new Map();

/** 会话空闲有效期（毫秒） */
export function sessionTtlMs(config) {
    const hours = Number(config && config.sessionTtlHours);
    const effective = Number.isFinite(hours) && hours > 0
        ? Math.min(hours, MAX_TTL_HOURS)
        : DEFAULT_TTL_HOURS;
    return Math.round(effective * 3600 * 1000);
}

/** 滑动刷新间隔（毫秒）：TTL 的 1/24，收敛到 [1 分钟, 1 小时] */
function refreshIntervalMs(ttlMs) {
    return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.floor(ttlMs / 24)));
}

/**
 * 密码指纹：用于「改密码后旧会话立即失效」。
 * 只取摘要前 16 位十六进制，不保存密码本身或完整摘要。
 */
async function passwordFingerprint(password) {
    if (!password) return '';
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(password)));
        return [...new Uint8Array(digest).slice(0, 8)]
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    } catch (e) {
        // 环境不支持 WebCrypto 时降级为「不做密码指纹校验」，不影响功能
        console.warn('[会话] 无法计算密码指纹，跳过改密失效检查:', e && e.message);
        return '';
    }
}

/** 读取请求 Cookie 中的指定字段（严格按键名匹配，避免被 xauth= 之类的键欺骗） */
export function readCookie(request, name) {
    const header = request.headers.get('Cookie');
    if (!header) return null;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() !== name) continue;
        return part.slice(idx + 1).trim() || null;
    }
    return null;
}

/** 组装下发 Cookie 的值 */
export function buildCookie(token, maxAgeSeconds) {
    return `${SESSION_COOKIE}=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** 组装清除 Cookie 的值 */
export function clearCookie() {
    return `${SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * 创建会话并写回 KV。
 * @returns {Promise<{token: string, cookie: string}>}
 * @throws 未绑定 KV 时抛错，由调用方给出可读提示
 */
export async function createSession(env, config) {
    const kv = getKV(env);
    const token = crypto.randomUUID().replace(/-/g, '');
    const now = Date.now();
    const ttlSeconds = Math.round(sessionTtlMs(config) / 1000);

    const record = {
        createdAt: now,
        lastSeen: now,
        pv: await passwordFingerprint(config.password),
    };

    await kv.put(SESSION_KEY_PREFIX + token, JSON.stringify(record), { expirationTtl: ttlSeconds });
    return { token, cookie: buildCookie(token, ttlSeconds) };
}

/**
 * 校验请求携带的会话。
 *
 * @returns {Promise<
 *   {valid: true, token: string, cookie: string|null} |
 *   {valid: false, reason: 'no-cookie'|'no-kv'|'unknown'|'expired'|'password-changed'}
 * >}
 *   valid 时 cookie 不为 null 表示本次发生了滑动续期，需要把新 Cookie 续发给浏览器。
 */
export async function validateSession(env, request, config) {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return { valid: false, reason: 'no-cookie' };

    let kv;
    try {
        kv = getKV(env);
    } catch (e) {
        // 缺绑定时一律按未登录处理（fail-closed），绝不因为配置缺失就放行
        return { valid: false, reason: 'no-kv' };
    }

    const key = SESSION_KEY_PREFIX + token;
    const record = await kv.get(key, { type: 'json' });
    if (!record || typeof record.lastSeen !== 'number') return { valid: false, reason: 'unknown' };

    const now = Date.now();
    const ttlMs = sessionTtlMs(config);
    const ttlSeconds = Math.round(ttlMs / 1000);

    // 空闲超时：删除记录并要求重新登录
    if (now - record.lastSeen > ttlMs) {
        await kv.delete(key).catch(() => {});
        console.log('[会话] 会话已空闲超时，已从 KV 删除');
        return { valid: false, reason: 'expired' };
    }

    // 密码已变更：旧会话立即失效
    const pv = await passwordFingerprint(config.password);
    if (record.pv && pv && record.pv !== pv) {
        await kv.delete(key).catch(() => {});
        console.log('[会话] PASSWORD 已变更，旧会话已从 KV 删除');
        return { valid: false, reason: 'password-changed' };
    }

    // 滑动续期：距上次刷新足够久才写一次，控制 KV 写入量
    const refreshMs = refreshIntervalMs(ttlMs);
    if (now - record.lastSeen >= refreshMs && shouldRefresh(token, now, refreshMs)) {
        await kv.put(key, JSON.stringify({ ...record, lastSeen: now }), { expirationTtl: ttlSeconds });
        return { valid: true, token, cookie: buildCookie(token, ttlSeconds) };
    }

    return { valid: true, token, cookie: null };
}

/** 同 isolate 内对同一 token 的刷新节流 */
function shouldRefresh(token, now, refreshMs) {
    const last = refreshGuard.get(token);
    if (last && now - last < refreshMs) return false;
    if (refreshGuard.size > 200) refreshGuard.clear();
    refreshGuard.set(token, now);
    return true;
}

/**
 * 注销会话：删除 KV 中的会话记录。
 * 无论记录是否存在都返回清除 Cookie 的值，保证客户端状态一定被清掉。
 *
 * @returns {Promise<string>} 用于 Set-Cookie 的清除值
 */
export async function destroySession(env, request) {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) {
        try {
            await getKV(env).delete(SESSION_KEY_PREFIX + token);
        } catch (e) {
            console.warn('[会话] 注销时删除 KV 记录失败:', e && e.message);
        }
    }
    return clearCookie();
}
