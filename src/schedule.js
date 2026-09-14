// src/schedule.js
//
// 定时检查
// ----------------------------------------------------------------------------
// 触发完全交给 Cloudflare 的 Cron Trigger。请在控制台添加：
//
//     Worker → 设置 → 触发器 → Cron 触发器 → 添加
//     0 1,13 * * *        # UTC 01:00 / 13:00，即北京时间 9:00 与 21:00
//
// 说明：
//   - Cron 表达式按 UTC 计算，北京时间需减 8 小时。
//   - 本项目不在 wrangler.toml 中声明 [triggers]；未声明时部署不会影响
//     控制台里已有的触发器（参见 Cloudflare Cron Triggers 文档）。
//   - 没有任何环境变量可以配置时间：计划只有一个来源，就是控制台。
//
// 补跑（catch-up）
// ----------------------------------------------------------------------------
// Cloudflare 不会自动重试失败的定时任务。因此这里额外做一层兜底：
//
//   1. 每次 scheduled 触发时，把「本次执行时间」写入 KV；
//   2. 每次 HTTP 请求进来时（不阻塞响应），检查今天最后一个已到点的计划槽位
//      是否已被覆盖，未覆盖则补跑一次。
//
// 计划槽位不是写死在代码里的：首次 scheduled 触发时从 event.cron 解析后记入 KV，
// 所以改时间只需改控制台，代码无需改动。
//
// 由此两条路径共享同一份执行标记，同一次计划只会执行一次，不会重复推送通知。

import { checkDomainsScheduled } from './cron';
import { getKV } from './api/domains';

// 最近一次成功执行的时间戳（毫秒，字符串存储）
const LAST_RUN_KEY = '__meta:cron_last_run';
// 从 Cron Trigger 解析出的计划槽位（UTC 时刻列表）
const SLOTS_KEY = '__meta:cron_slots';

// 槽位缓存存活时间，避免每个请求都读一次 KV
const SLOTS_CACHE_TTL = 5 * 60 * 1000;
const slotsCache = { value: null, at: 0 };

function pad(n) {
    return String(n).padStart(2, '0');
}

/**
 * 展开 cron 的单个字段（支持 *、a-b、a-b/step、a/step、逗号列表）。
 * @returns {number[]|null} 展开后的升序取值，无法解析时返回 null
 */
function expandField(field, min, max) {
    const values = new Set();

    for (const part of field.split(',')) {
        const [range, stepRaw] = part.split('/');
        const step = stepRaw === undefined ? 1 : Number(stepRaw);
        if (!Number.isInteger(step) || step < 1) return null;

        let lo;
        let hi;

        if (range === '*') {
            lo = min;
            hi = max;
        } else if (range.includes('-')) {
            const [a, b] = range.split('-').map(Number);
            if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
            lo = a;
            hi = b;
        } else {
            const v = Number(range);
            if (!Number.isInteger(v)) return null;
            lo = v;
            // 单个值配合步长时，语义为「从该值到字段上限，每隔 step」
            hi = stepRaw === undefined ? v : max;
        }

        if (lo < min || hi > max || lo > hi) return null;
        for (let v = lo; v <= hi; v += step) values.add(v);
    }

    return [...values].sort((a, b) => a - b);
}

/**
 * 把 cron 表达式解析为「每天固定时刻」的 UTC 槽位列表。
 *
 * 只支持日/月/星期三个字段均为 * 的表达式（即每天重复的计划）。其余形式
 * （如每月 1 号）返回 null，表示无法推导槽位、补跑功能关闭——定时检查本身不受影响。
 *
 * @param {string} expr cron 表达式，如 "0 1,13 * * *"
 * @returns {string[]|null} 形如 ['01:00','13:00'] 的 UTC 时刻列表
 */
export function parseCronExpression(expr) {
    const parts = String(expr ?? '').trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minuteField, hourField, dom, month, dow] = parts;
    if (![dom, month, dow].every(f => f === '*')) return null;

    const minutes = expandField(minuteField, 0, 59);
    const hours = expandField(hourField, 0, 23);
    if (!minutes || !hours) return null;

    const slots = new Set();
    for (const h of hours) {
        for (const m of minutes) slots.add(`${pad(h)}:${pad(m)}`);
    }
    return [...slots].sort();
}

/** 今天某个 UTC 时刻（HH:MM）对应的时间戳；该时刻今天已过则为过去的时刻 */
function utcInstantToday(hhmm, now) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m, 0, 0);
}

/** 读取已知的计划槽位（带短时缓存；从未学到过则返回 null） */
async function loadSlots(kv) {
    const now = Date.now();
    if (slotsCache.value && now - slotsCache.at < SLOTS_CACHE_TTL) return slotsCache.value;

    const raw = await kv.get(SLOTS_KEY, { type: 'json' });
    const slots = raw && Array.isArray(raw.slots) && raw.slots.length > 0 ? raw.slots : null;
    slotsCache.value = slots;
    slotsCache.at = now;
    return slots;
}

/** 记录本次触发所携带的计划；表达式未变时不产生写操作 */
async function saveSlots(kv, expr, slots) {
    const existing = await kv.get(SLOTS_KEY, { type: 'json' });
    if (!existing || existing.expr !== expr) {
        await kv.put(SLOTS_KEY, JSON.stringify({ expr, slots, updatedAt: Date.now() }));
        console.log(`[定时检查] 已记录 Cron Trigger 计划：${expr} → UTC ${slots.join(', ')}`);
    }
    slotsCache.value = slots;
    slotsCache.at = Date.now();
}

/**
 * 执行一次检查并维护标记：失败时回滚标记，交给补跑重试。
 * @returns {Promise<number>} 命中即将到期的域名数量
 */
async function runCheck(env, kv, previous, source) {
    await kv.put(LAST_RUN_KEY, String(Date.now()));

    try {
        const expiring = await checkDomainsScheduled(env);
        console.log(`[定时检查] ${source}执行完成，命中 ${expiring.length} 个即将到期域名`);
        return expiring.length;
    } catch (error) {
        if (previous > 0) await kv.put(LAST_RUN_KEY, String(previous));
        else await kv.delete(LAST_RUN_KEY).catch(() => {});
        throw error;
    }
}

/**
 * Cloudflare Cron Trigger 的 scheduled 处理器。
 *
 * @param {object} env Worker 环境绑定
 * @param {{cron?: string, scheduledTime?: number}} event 定时事件
 */
export async function handleScheduledEvent(env, event) {
    let kv;
    try {
        kv = getKV(env);
    } catch (e) {
        console.warn('定时检查跳过：', e.message);
        return;
    }

    // 1. 从本次触发学习计划（改控制台的表达式后，下一次触发即生效）
    if (event && event.cron) {
        const slots = parseCronExpression(event.cron);
        if (slots) {
            await saveSlots(kv, event.cron, slots);
        } else {
            console.warn(`[定时检查] Cron 表达式 "${event.cron}" 不是「每天固定时刻」形式，补跑不可用（定时检查本身正常）`);
        }
    }

    const scheduledTime = Number(event && event.scheduledTime) || Date.now();

    // 2. 幂等：若已有不早于本次触发时刻的成功执行，视为重复投递，直接跳过
    const previous = Number(await kv.get(LAST_RUN_KEY)) || 0;
    if (previous >= scheduledTime) {
        console.log('[定时检查] 该时间槽已执行过，跳过重复触发');
        return;
    }

    // 3. 执行；失败回滚标记，由下一次触发或补跑接手
    await runCheck(env, kv, previous, '由 Cron Trigger 触发');
}

/**
 * 补跑检查：由 index.js 在每次请求时通过 ctx.waitUntil 调用，不阻塞响应。
 * 当今天的某个计划槽位尚未被覆盖时（定时任务延迟或失败），补跑一次。
 */
export async function maybeRunCatchUpCheck(env) {
    let kv;
    try {
        kv = getKV(env);
    } catch (e) {
        console.warn('定时检查跳过：', e.message);
        return;
    }

    // 尚未从 Cron Trigger 学到计划（例如触发器刚添加、还没到触发时间）→ 不做事
    const slots = await loadSlots(kv);
    if (!slots) return;

    const now = Date.now();

    // 今天已到点、且最靠后的那个槽位
    let due = 0;
    for (const s of slots) {
        const t = utcInstantToday(s, now);
        if (t <= now && t > due) due = t;
    }
    if (!due) return; // 今天还没到第一个计划时刻

    const previous = Number(await kv.get(LAST_RUN_KEY)) || 0;
    if (previous >= due) return; // 该槽位已被覆盖，无需补跑

    try {
        await runCheck(env, kv, previous, `补跑 ${new Date(due).toISOString()} 的计划槽位`);
    } catch (error) {
        console.error('[定时检查] 补跑失败:', error);
    }
}
