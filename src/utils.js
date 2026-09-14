// src/utils.js

// 会话空闲有效期默认 7 天（可被 SESSION_TTL 覆盖，单位：小时）
const DEFAULT_SESSION_TTL_HOURS = 168;

/** 读取正数型环境变量，非法或缺省时回退到默认值 */
function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 从环境变量读取配置
export function getConfig(env) {
    return {
        siteName: env.SITENAME || "域名到期监控",
        siteIcon: env.ICON || 'https://pan.811520.xyz/icon/domain-check.png',
        bgimgURL: env.BGIMG || 'https://pan.811520.xyz/icon/bg_light.webp',
        githubURL: env.GITHUB_URL || 'https://github.com/yutian81/domain-check',
        blogURL: env.BLOG_URL || 'https://blog.notett.com/post/2025/11/251118-domain-check/',
        blogName: env.BLOG_NAME || 'QingYun Blog',
        // 必须显式配置：不提供默认值，避免弱默认密码；未配置时管理入口整体禁用
        password: env.PASSWORD || '',
        // 会话空闲有效期（小时），默认 168 = 7 天；同时作用于 Cookie 的 Max-Age 与 KV 的过期时间
        sessionTtlHours: positiveNumber(env.SESSION_TTL, DEFAULT_SESSION_TTL_HOURS),
        // Cloudflare Turnstile 人机验证（登录防爆破）：两项都配置时才启用，详见 src/turnstile.js
        turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
        turnstileSecret: env.TURNSTILE_SECRET_KEY || '',
        days: Number(env.DAYS || 30), // 用于前端即将到期判断
        tgid: env.TGID || env.TG_CHAT_ID,
        tgtoken: env.TGTOKEN || env.TG_BOT_TOKEN
    };
}

// 格式化日期为北京时间 YYYY-MM-DD
export function formatDateToBeijing(dateStr) {
    const date = new Date(dateStr);
    const beijingTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return beijingTime.toISOString().split('T')[0];
}

// 判断是否为一级域名（返回布尔值）
export function isPrimaryDomain(domain) {
    const parts = domain.split('.');
    return parts.length <= 2;
}

// TG通知函数
export async function sendtgMessage(message, tgid, tgtoken) {
    if (!tgid || !tgtoken) return;
    const url = `https://api.telegram.org/bot${tgtoken}/sendMessage`;
    const params = {
        chat_id: tgid,
        text: message,
        parse_mode: "HTML"
    };
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
        });
    } catch (error) {
        console.error('Telegram 消息推送失败:', error);
    }
}
