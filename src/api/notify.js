// src/api/notify.js
//
// POST /api/notify-test —— 发送一条 Telegram 测试消息，用于验证 TG 通知是否真的生效。
// 需鉴权，路由守卫在 src/index.js 的 `/api/*` 分支统一处理。
//
// 走的是与定时任务完全相同的 sendtgMessage，区别只在于这里把 Telegram 的真实返回
// 透出给前端：成功即说明 chat_id 与 token 可用，失败则直接把原因展示出来，
// 不必再去翻 Worker 日志（`wrangler tail`）猜。

import { getConfig, sendtgMessage } from '../utils';

/** 北京时间字符串：Workers 运行时是 UTC，手动偏移 +8（与 formatDateToBeijing 同一口径） */
function beijingNow() {
    const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
        `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 最小 HTML 转义：消息以 parse_mode=HTML 发送，站点名里的 &<> 会破坏排版 */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json;charset=UTF-8' }
    });
}

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
        return json({ success: false, error: '仅支持 POST 请求' }, 405);
    }

    const config = getConfig(env);

    // 通知目标缺失时明确点名缺哪个变量，
    // 否则用户只会看到「没收到消息」，误以为是推送链路坏了
    const missing = [];
    if (!config.tgid) missing.push('TGID');
    if (!config.tgtoken) missing.push('TGTOKEN');
    if (missing.length > 0) {
        return json({
            success: false,
            error: `未配置 ${missing.join(' 与 ')}，请在 Cloudflare 控制台为本 Worker 添加后重试`
        }, 400);
    }

    const message = `
<b>🔔 Telegram 通知测试</b>
====================
✅ 如果你看到这条消息，说明域名到期提醒通道已打通。
🌐 站点: ${escapeHtml(config.siteName)}
⏰ 发送时间: ${beijingNow()} (UTC+8)
--------------------------`;

    const result = await sendtgMessage(message, config.tgid, config.tgtoken);
    if (!result.ok) {
        return json({ success: false, error: `发送失败：${result.description}` }, 502);
    }

    return json({ success: true, message: '测试消息已发送，请查看 Telegram' });
}
