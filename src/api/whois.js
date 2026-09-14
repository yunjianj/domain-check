// src/api/whois.js
//
// 域名注册信息查询。两条链路：
//
//   主源：ip.sb 的 WHOIS/RDAP 页面（https://ip.sb/whois/<域名>）
//     ip.sb 的页面结构会改版，所以按「优先级从高到低」依次尝试三种解析方式，
//     最后做字段级合并（谁先取到非空值就用谁的）：
//       1. 页面内嵌的 RDAP JSON 块（<pre data-lang="json">）。用块前面最近的
//          <summary> 标签区分 registry / registrar，注册局的数据优先级更高
//       2. 新版渲染后的字段行（<span class="lbl">X</span><span class="val">Y</span>）
//       3. 旧版原始 WHOIS 文本块（<pre data-lang="whois">）的经典 key: value 格式
//
//   兜底：直连注册局 RDAP（RFC 7480）
//     TLD → RDAP 服务地址取自 IANA 官方 bootstrap（data.iana.org/rdap/dns.json，
//     isolate 内缓存 24 小时）。bootstrap 未收录的 TLD（如 .de）退回使用 ip.sb
//     页面上给出的 "Registry RDAP" 地址。已移除原先经 rdap.org 第三方代理的回退。
//
// 注意事项：
//   - ip.sb 会把 Cloudflare 邮件保护的 HTML 片段直接拼进 RDAP JSON 字符串里，
//     且不转义其中的引号，导致该 JSON 非法，须先经 repairBrokenJson() 修复。
//   - 日期统一裁成 YYYY-MM-DD 输出，因为前端的 <input type="date"> 只认这个格式。
//   - 只有拿到到期日（expiryDate）才视为查询成功；否则 fetchDomainFromAPI 返回
//     null，由调用方（src/api/domains.js）决定是否提示用户手动输入。

import { isPrimaryDomain } from '../utils';

const IPSB_TIMEOUT_MS = 8000;
const RDAP_TIMEOUT_MS = 10000;
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

// ====== 通用工具 ======

/** 还原 HTML 实体（ip.sb 会把内嵌数据整体做 HTML 转义） */
function decodeEntities(text) {
    return text
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&');
}

/** 去掉 HTML 标签，并把 <br> 变成换行（供 Nameservers 这类多值字段拆分） */
function stripTags(html) {
    return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim();
}

/** 统一成 YYYY-MM-DD；拿不到合法日期时返回 null */
function toDateOnly(value) {
    if (!value) return null;
    const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 规范化域名与 NS 记录（去空格、转小写、去结尾的点） */
function normalizeName(value) {
    if (!value) return null;
    return String(value).trim().toLowerCase().replace(/\.$/, '') || null;
}

/** 带超时的 fetch，可选返回 JSON 或文本 */
async function fetchWithTimeout(url, { headers, timeoutMs, as = 'text' } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal, headers });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return as === 'json' ? await response.json() : await response.text();
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('请求超时');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

// ====== 主源：ip.sb 页面 ======

async function fetchIpSbPage(domain) {
    return fetchWithTimeout(`https://ip.sb/whois/${encodeURIComponent(domain)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (WHOIS API Service)' },
        timeoutMs: IPSB_TIMEOUT_MS
    });
}

/**
 * 取出页面里所有数据块，并记住每块前面最近的 <summary> 文本。
 * 返回 [{ label, lang, body }]，lang 为 whois 或 json。
 */
function readIpSbBlocks(html) {
    const blocks = [];
    const pattern = /<summary>([\s\S]*?)<\/summary>|<pre class="whois-raw" data-lang="([a-z]+)">([\s\S]*?)<\/pre>/g;
    let match;
    let label = '';
    while ((match = pattern.exec(html)) !== null) {
        if (match[1] !== undefined) {
            label = decodeEntities(match[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
        } else {
            blocks.push({ label, lang: match[2], body: decodeEntities(match[3]) });
        }
    }
    return blocks;
}

/**
 * ip.sb 把 Cloudflare 邮件保护片段原样拼进了 RDAP JSON 字符串且不转义引号，
 * 这里把整段 <a ...>...</a> 替换成一个合法的 JSON 字符串。
 */
function repairBrokenJson(text) {
    return text.replace(/"<a href="[^"]*"[^>]*>[\s\S]*?<\/a>"/g, '"REDACTED"');
}

/** 新版渲染后的字段行，返回部分字段 */
function extractFromStructuredRows(html) {
    const rows = new Map();
    const pattern = /<span class="lbl">([\s\S]*?)<\/span><span class="val[^"]*">([\s\S]*?)<\/span>/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
        const key = stripTags(match[1]);
        if (key && !rows.has(key)) rows.set(key, match[2]);
    }

    const pick = (key) => {
        const raw = rows.get(key);
        return raw === undefined ? null : stripTags(raw);
    };

    const nsRaw = pick('Nameservers');
    const registrarRaw = pick('Registrar');

    return {
        domain: pick('Domain'),
        creationDate: toDateOnly(pick('Registered')),
        updatedDate: toDateOnly(pick('Updated')),
        expiryDate: toDateOnly(pick('Expires')),
        // 形如 "Spaceship, Inc. (IANA #3862)"，去掉括号里的 IANA 编号
        registrar: registrarRaw ? registrarRaw.replace(/\s*\(IANA\s*#\d+\)\s*$/i, '').trim() || null : null,
        // 该行是注册商的 RDAP 服务地址，只在其它来源都拿不到时兜底
        registrarUrl: pick('Registrar RDAP'),
        nameServers: nsRaw
            ? [...new Set(nsRaw.split('\n').map(normalizeName).filter(Boolean))]
            : null
    };
}

/** 旧版原始 WHOIS 文本块（经典 key: value 格式），返回部分字段 */
function extractFromLegacyWhois(text) {
    const grab = (patterns) => {
        for (const re of patterns) {
            const m = text.match(re);
            if (m && m[1]) return m[1].trim();
        }
        return null;
    };

    const nameServers = (text.match(/^Name Server:\s*(.+)$/gim) || [])
        .map((line) => normalizeName(line.replace(/^Name Server:\s*/i, '')))
        .filter(Boolean);

    return {
        domain: grab([/^Domain Name:\s*(.+)$/im]),
        creationDate: toDateOnly(grab([
            /^Creation Date:\s*(.+)$/im,
            /^Registered On:\s*(.+)$/im,
            /^Registration Time:\s*(.+)$/im
        ])),
        updatedDate: toDateOnly(grab([
            /^Updated Date:\s*(.+)$/im,
            /^Last Updated On:\s*(.+)$/im
        ])),
        expiryDate: toDateOnly(grab([
            /^Registry Expiry Date:\s*(.+)$/im,
            /^Registrar Registration Expiration Date:\s*(.+)$/im,
            /^Expiry Date:\s*(.+)$/im,
            /^Expiration Date:\s*(.+)$/im
        ])),
        registrar: grab([/^Registrar:\s*(.+)$/im]),
        registrarUrl: grab([/^Registrar URL:\s*(\S+)$/im]),
        nameServers
    };
}

// ====== RDAP 数据解析（内嵌 JSON 与直连注册局共用）======

/** 按事件类型取日期；actions 按优先级排列 */
function pickEvent(events, actions) {
    for (const action of actions) {
        const hit = events.find((e) => String(e.eventAction || '').toLowerCase() === action);
        if (hit && hit.eventDate) return hit.eventDate;
    }
    return null;
}

/** 注册商实体：优先顶层 roles 含 registrar，其次看一层子实体 */
function findRegistrarEntity(json) {
    const entities = json.entities || [];
    const isRegistrar = (e) => (e.roles || []).includes('registrar');
    for (const entity of entities) {
        if (isRegistrar(entity)) return entity;
    }
    for (const entity of entities) {
        for (const child of entity.entities || []) {
            if (isRegistrar(child)) return child;
        }
    }
    return null;
}

/** RDAP JSON → 部分字段。registry 与 registrar 两份数据都用这个函数解析 */
function extractFromRdap(json) {
    const events = json.events || [];
    const registrarEntity = findRegistrarEntity(json);

    let registrar = null;
    if (Array.isArray(registrarEntity?.vcardArray) && Array.isArray(registrarEntity.vcardArray[1])) {
        const fn = registrarEntity.vcardArray[1].find((f) => Array.isArray(f) && f[0] === 'fn');
        registrar = fn && fn[3] ? String(fn[3]).trim() || null : null;
    }

    // 注册商链接：about 通常是其官网，related 多为注册商 RDAP，self 是注册局内的实体记录
    let registrarUrl = null;
    const entityLinks = registrarEntity?.links || [];
    for (const rel of ['about', 'related', 'self']) {
        const hit = entityLinks.find((l) => l.rel === rel && l.href);
        if (hit) { registrarUrl = hit.href; break; }
    }
    if (!registrarUrl) {
        const topLink = (json.links || []).find((l) => l.rel === 'related' && l.href);
        if (topLink) registrarUrl = topLink.href;
    }

    const nameServers = [...new Set((json.nameservers || [])
        .map((ns) => normalizeName(ns.ldhName))
        .filter(Boolean))];

    return {
        domain: normalizeName(json.ldhName),
        creationDate: toDateOnly(pickEvent(events, ['registration'])),
        updatedDate: toDateOnly(pickEvent(events, ['last changed'])),
        expiryDate: toDateOnly(pickEvent(events, ['expiration', 'registrar expiration'])),
        registrar,
        registrarUrl,
        nameServers
    };
}

// ====== ip.sb 页面 → 数据（三种解析方式合并）======

/** 从字段行里取 "Registry RDAP" 地址，作为 bootstrap 缺失时的兜底 */
function extractRegistryRdapHint(html) {
    const m = html.match(/<span class="lbl">Registry RDAP<\/span><span class="val[^"]*">([\s\S]*?)<\/span>/);
    return m ? stripTags(m[1]) : null;
}

/**
 * 解析 ip.sb 页面。按 registry RDAP → registrar RDAP → 旧版 WHOIS 文本 →
 * 新版字段行的优先级做字段级合并。
 * @returns {{ data: object|null, registryRdapHint: string|null }}
 */
function parseIpSbPage(html, domain) {
    const blocks = readIpSbBlocks(html);
    const jsonBlocks = blocks.filter((b) => b.lang === 'json');
    const registryBlock = jsonBlocks.find((b) => /registry/i.test(b.label)) || jsonBlocks[0] || null;
    const registrarBlock = jsonBlocks.find((b) => /registrar/i.test(b.label)) || null;

    const parts = [];
    for (const block of [registryBlock, registrarBlock]) {
        if (!block) continue;
        try {
            parts.push(extractFromRdap(JSON.parse(repairBrokenJson(block.body))));
        } catch (error) {
            console.warn(`ip.sb 内嵌 RDAP JSON 解析失败 (${block.label || '未标注'}): ${error.message}`);
        }
    }
    for (const block of blocks.filter((b) => b.lang === 'whois')) {
        parts.push(extractFromLegacyWhois(block.body));
    }
    parts.push(extractFromStructuredRows(html));

    const firstOf = (key) => {
        for (const part of parts) {
            const value = part[key];
            if (Array.isArray(value)) {
                if (value.length) return value;
            } else if (value) {
                return value;
            }
        }
        return null;
    };

    const data = {
        domain: null,
        creationDate: null,
        updatedDate: null,
        expiryDate: null,
        registrar: null,
        registrarUrl: null,
        nameServers: []
    };
    for (const key of Object.keys(data)) {
        data[key] = firstOf(key);
    }
    data.domain = data.domain || domain;
    data.nameServers = data.nameServers || [];

    return { data, registryRdapHint: extractRegistryRdapHint(html) };
}

// ====== 兜底：直连注册局 RDAP ======

// IANA bootstrap 缓存（isolate 级）。拉取失败时保留旧缓存，避免网络抖动导致整体失效。
let bootstrapCache = { at: 0, map: null };

function normalizeRdapBase(value) {
    if (!value) return null;
    const base = String(value).trim();
    if (!/^https?:\/\//i.test(base)) return null;
    return base.endsWith('/') ? base : `${base}/`;
}

/** 查 TLD 对应的 RDAP 服务地址（IANA 官方 bootstrap） */
async function lookupBootstrapBase(domain) {
    const tld = domain.split('.').pop().toLowerCase();
    if (!bootstrapCache.map || Date.now() - bootstrapCache.at > BOOTSTRAP_TTL_MS) {
        try {
            const json = await fetchWithTimeout(BOOTSTRAP_URL, { timeoutMs: 8000, as: 'json' });
            const map = new Map();
            for (const service of json.services || []) {
                const base = service[1] && service[1][0];
                if (!base) continue;
                for (const t of service[0] || []) {
                    const key = String(t).toLowerCase();
                    if (!map.has(key)) map.set(key, base);
                }
            }
            if (map.size) bootstrapCache = { at: Date.now(), map };
        } catch (error) {
            console.warn(`IANA RDAP bootstrap 拉取失败: ${error.message}`);
        }
    }
    if (!bootstrapCache.map) return null;
    return bootstrapCache.map.get(tld) || null;
}

/** 直连注册局 RDAP；bootstrap 优先，缺失时用 ip.sb 页面给的地址兜底 */
async function fetchRegistryRdap(domain, hintBase) {
    const candidates = [];
    const pushBase = (value) => {
        const base = normalizeRdapBase(value);
        if (base && !candidates.includes(base)) candidates.push(base);
    };

    pushBase(await lookupBootstrapBase(domain));
    pushBase(hintBase);

    for (const base of candidates) {
        const url = `${base}domain/${encodeURIComponent(domain)}`;
        try {
            const json = await fetchWithTimeout(url, {
                headers: { Accept: 'application/rdap+json' },
                timeoutMs: RDAP_TIMEOUT_MS,
                as: 'json'
            });
            return extractFromRdap(json);
        } catch (error) {
            console.warn(`注册局 RDAP 直连失败 (${base}): ${error.message}`);
        }
    }
    return null;
}

// ====== 主入口 ======

/**
 * 查询域名的注册信息。
 * @returns 成功（拿到到期日）时返回 {domain, creationDate, updatedDate, expiryDate,
 *          registrar, registrarUrl, nameServers}，否则返回 null。
 */
export async function fetchDomainFromAPI(env, domain) {
    let registryRdapHint = null;

    // 主源：ip.sb 页面（内部已合并三种解析方式）
    try {
        const html = await fetchIpSbPage(domain);
        const { data, registryRdapHint: hint } = parseIpSbPage(html, domain);
        registryRdapHint = hint;
        if (data.expiryDate) {
            console.log(`ip.sb 页面解析成功: ${domain}`);
            return data;
        }
        console.warn(`ip.sb 未返回到期日 (${domain})，尝试直连注册局 RDAP...`);
    } catch (error) {
        console.warn(`ip.sb 查询失败 (${domain}): ${error.message}，尝试直连注册局 RDAP...`);
    }

    // 兜底：直连注册局 RDAP
    try {
        const data = await fetchRegistryRdap(domain, registryRdapHint);
        if (data && data.expiryDate) {
            console.log(`注册局 RDAP 查询成功: ${domain}`);
            return data;
        }
        console.warn(`注册局 RDAP 未返回到期日 (${domain})`);
    } catch (error) {
        console.warn(`注册局 RDAP 查询失败 (${domain}): ${error.message}`);
    }

    return null;
}

// WHOIS API 路由处理函数 /api/whois/<domain>
export async function onRequest(context, domain) {
    const { request, env } = context;

    if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    if (!domain) {
        return new Response(JSON.stringify({ error: '路径格式应为 /api/whois/<域名>' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 仅允许查询一级域名
    if (!isPrimaryDomain(domain)) {
        return new Response(JSON.stringify({ error: '仅支持查询一级域名。' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const whoisData = await fetchDomainFromAPI(env, domain);

        if (whoisData) {
            return new Response(JSON.stringify({ success: true, data: whoisData }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=86400'
                }
            });
        } else {
            return new Response(JSON.stringify({ error: '无法查询到该域名的 WHOIS 信息或信息不完整。' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

    } catch (error) {
        console.error('WHOIS API 错误:', error);
        return new Response(JSON.stringify({ error: 'WHOIS 查询服务出错。', details: error.message }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
