// src/auth.js

import { getConfig } from './utils';
import { createSession, destroySession, validateSession } from './session';
import {
    turnstileState,
    verifyTurnstile,
    TURNSTILE_RESPONSE_FIELD,
} from './turnstile';

// 登录页错误提示（由 handleLogin 传给 generateLoginPage，页面内只做转义渲染）
const LOGIN_ERROR = {
    password: '密码错误，请重试',
    turnstile: '人机验证未通过或已过期，请重新完成验证',
    turnstileUnavailable: '人机验证服务暂时不可用，请稍后重试',
};

/** 最小 HTML 转义，用于把动态内容安全地插入属性或文本 */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 管理入口不可用时的提示响应（HTML 或 JSON）。
 *
 * @param {object} config   getConfig() 的返回值（用于站点名/图标/背景）
 * @param {string} title    提示标题
 * @param {string} message  提示正文
 * @param {boolean} asJson  true 返回 JSON（供 API 使用），false 返回提示页
 */
function blockedResponse(config, title, message, asJson = false) {
    if (asJson) {
        return new Response(JSON.stringify({ success: false, error: message }), {
            status: 503,
            headers: { 'Content-Type': 'application/json;charset=UTF-8' }
        });
    }

    return new Response(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${title} - ${config.siteName}</title>
      <link rel="icon" href="${config.siteIcon}" type="image/png">
      <style>
        body {
          margin: 0;
          padding: 24px;
          min-height: 100vh;
          box-sizing: border-box;
          display: flex;
          justify-content: center;
          align-items: center;
          font-family: Arial, sans-serif;
          color: #333333;
          background-image: url('${config.bgimgURL}');
          background-position: center;
        }
        .card {
          background-color: rgba(255, 255, 255, 0.75);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-radius: 8px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.15);
          padding: 28px;
          max-width: 560px;
          line-height: 1.7;
        }
        h1 {
          color: #186db3;
          font-size: 1.4rem;
          margin: 0 0 12px 0;
        }
        code {
          background-color: rgba(0,0,0,0.06);
          padding: 1px 5px;
          border-radius: 4px;
        }
        a {
          color: #186db3;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>${title}</h1>
        <p>${message}</p>
        <p><a href="/">返回首页</a></p>
      </div>
    </body>
    </html>
    `, {
        status: 503,
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
}

/**
 * 未配置 PASSWORD 环境变量时的统一响应。
 *
 * 采用 fail-closed 策略：管理入口（/admin、/login、受鉴权的 API）整体禁用，
 * 公开首页 `/` 不受影响。绝不能退化为「密码为空即跳过鉴权」，否则管理页会完全敞开。
 *
 * @param {object} config  getConfig() 的返回值（用于站点名/图标/背景）
 * @param {boolean} asJson true 返回 JSON（供 API 使用），false 返回提示页
 */
export function passwordMissingResponse(config, asJson = false) {
    return blockedResponse(
        config,
        '管理入口未启用',
        '本 Worker 未配置 PASSWORD 环境变量，管理功能已禁用。请在 Cloudflare 控制台 → 本 Worker → 设置 → 变量和机密 中添加名为 PASSWORD 的变量后重试。',
        asJson
    );
}

/**
 * 未绑定 KV 时的统一响应。
 *
 * 登录会话记录存放在 KV 中，缺绑定则既无法建立也无法校验会话，
 * 因此管理入口同样不可用（fail-closed，绝不因为存储不可用就放行）。
 */
export function storageMissingResponse(config, asJson = false) {
    return blockedResponse(
        config,
        '存储未就绪',
        '本 Worker 未绑定 KV 命名空间，无法保存登录会话。请在 Cloudflare 控制台 → 本 Worker → 设置 → 绑定 → 添加绑定 → KV 命名空间，变量名（Binding name）填 kv 后重试。',
        asJson
    );
}

/**
 * Turnstile 只配置了一半时的统一响应。
 *
 * 安全控制「半配」等于「失效」：只配站点密钥则服务端无法校验（攻击者可伪造令牌），
 * 只配私钥则页面上根本没有组件。与其静默降级成「不校验」，不如明确拒绝登录并告知补全。
 */
export function turnstileMisconfiguredResponse(config, asJson = false) {
    return blockedResponse(
        config,
        '人机验证配置不完整',
        '本 Worker 的 Turnstile 配置不完整，登录已停用。请在 Cloudflare 控制台 → 本 Worker → 设置 → 变量和机密 中同时配置 TURNSTILE_SITE_KEY 与 TURNSTILE_SECRET_KEY（两个都要有，或两个都不设以关闭人机验证）。',
        asJson
    );
}

/**
 * 常量时间字符串比较，用于校验密码。
 * 长度不等时直接返回 false（长度本身不是秘密）。
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * 鉴权：校验请求 Cookie 中的会话 token 是否有效。
 *
 * @returns {Promise<{ok: true, cookie: string|null} | {ok: false, response: Response}>}
 *   ok 为 true 时 cookie 若不为 null，表示本次发生了滑动续期，需把新 Cookie 续发给浏览器。
 */
export async function authenticate(request, env) {
    const config = getConfig(env);
    // 未配置密码时直接拒绝，绝不放行（fail-closed）
    if (!config.password) return { ok: false, response: passwordMissingResponse(config) };

    const result = await validateSession(env, request, config);
    if (result.valid) return { ok: true, cookie: result.cookie };

    // Cookie 缺失、token 未知、会话过期或密码已变更 —— 一律回到登录页
    return { ok: false, response: Response.redirect(new URL('/login', request.url), 302) };
}

// 登录处理逻辑（支持自定义跳转路径）
export async function handleLogin(request, env, redirectPath = '/') {
    const config = getConfig(env);
    // 未配置密码时登录入口不可用
    if (!config.password) return passwordMissingResponse(config);

    // Turnstile 半配（只设了其中一个变量）：登录整体停用，绝不降级为「不校验」
    const tsState = turnstileState(config);
    if (tsState === 'misconfigured') return turnstileMisconfiguredResponse(config);
    const turnstileOn = tsState === 'enabled';

    if (request.method === 'GET') {
        return new Response(generateLoginPage(config, ''), {
            headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
    }

    if (request.method === 'POST') {
        let formData;
        try {
            formData = await request.formData();
        } catch (error) {
            return new Response('Bad Request', { status: 400 });
        }

        // 1) 人机验证 —— 必须在密码校验之前：爆破工具连一次密码猜测的机会都不该拿到。
        //    失败时整页重渲染（令牌是一次性的，重渲染即等于重置组件）。
        if (turnstileOn) {
            const result = await verifyTurnstile(config, request, formData.get(TURNSTILE_RESPONSE_FIELD));
            if (!result.ok) {
                // 密钥错误属管理员配置问题，用 503 提示页而不是登录页，便于定位
                if (result.reason === 'config') return turnstileMisconfiguredResponse(config);
                const message = result.reason === 'unavailable'
                    ? LOGIN_ERROR.turnstileUnavailable
                    : LOGIN_ERROR.turnstile;
                return new Response(generateLoginPage(config, message), {
                    headers: { 'Content-Type': 'text/html;charset=UTF-8' }
                });
            }
        }

        // 2) 密码校验
        if (!safeEqual(formData.get('password'), config.password)) {
            return new Response(generateLoginPage(config, LOGIN_ERROR.password), {
                headers: { 'Content-Type': 'text/html;charset=UTF-8' }
            });
        }

        // 3) 登录成功：生成随机会话 token，Cookie 里只放 token，不再放密码
        let session;
        try {
            session = await createSession(env, config);
        } catch (error) {
            console.error('创建会话失败:', error);
            return storageMissingResponse(config);
        }
        const headers = new Headers();
        headers.set('Location', redirectPath);
        headers.set('Set-Cookie', session.cookie);
        return new Response(null, { status: 302, headers: headers });
    }

    return new Response('Method Not Allowed', { status: 405 });
}

/** 注销会话并返回清除 Cookie 的值（供 /logout 使用） */
export async function handleLogout(env, request) {
    return destroySession(env, request);
}

// 生成登录页面HTML
//   config        整个站点配置（含 Turnstile 站点密钥与页脚信息）
//   errorMessage  需要显示的错误提示，空串表示不显示
export function generateLoginPage(config, errorMessage = '') {
  const {
    siteName, siteIcon, bgimgURL, githubURL, blogURL, blogName,
  } = config || {};
  const currentYear = new Date().getFullYear();

  // 人机验证只在真启用时渲染组件；disabled / misconfigured 都不会走到这里
  const turnstileOn = turnstileState(config) === 'enabled';
  const siteKey = escapeHtml((config && config.turnstileSiteKey) || '');

  return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>登录 - ${siteName}</title>
      <link rel="icon" href="${siteIcon}" type="image/png">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
${turnstileOn ? `      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
      <script>
        // Turnstile 客户端配合：拿到令牌前禁止提交，避免空白提交（令牌是一次性的，失败即整页重渲染）
        var TS_READY = false;
        function tsUpdate(ready, label) {
          var btn = document.getElementById('submitBtn');
          var hint = document.getElementById('tsHint');
          if (!btn) return;
          TS_READY = !!ready;
          btn.disabled = !TS_READY;
          btn.textContent = label || (TS_READY ? '登录系统' : '请先完成人机验证');
          if (hint) hint.style.display = TS_READY ? 'none' : 'block';
        }
        function onTurnstileSuccess() { tsUpdate(true); }
        function onTurnstileError() { tsUpdate(false, '验证组件加载失败，请刷新页面重试'); }
        function onTurnstileExpired(id) {
          tsUpdate(false, '验证已过期，正在刷新…');
          if (window.turnstile && typeof window.turnstile.reset === 'function') {
            try { window.turnstile.reset(id); } catch (e) {}
          }
        }
        window.addEventListener('DOMContentLoaded', function () {
          if (!TS_READY) tsUpdate(false);
          // 兜底：组件被拦截或长时间不返回时恢复提交能力，让服务端给出确切失败原因，
          // 避免页面永远卡在「不可提交」而无任何提示
          setTimeout(function () {
            if (TS_READY) return;
            var btn = document.getElementById('submitBtn');
            if (btn) { btn.disabled = false; btn.textContent = '登录系统'; }
            var hint = document.getElementById('tsHint');
            if (hint) hint.textContent = '未检测到人机验证组件，可直接提交，服务端仍会校验';
          }, 10000);
        });
      </script>
` : ''}      <style>
        body, html {
          height: 100%;
          margin: 0;
          padding: 10px;
          font-family: Arial, sans-serif;
          background-image: url('${bgimgURL}');
          background-position: center;
          display: flex;
          justify-content: center;
          align-items: center;
        }
        .login-container {
          background-color: rgba(255, 255, 255, 0.3);
          padding: 25px 25px 10px 25px;
          border-radius: 8px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.15);
          width: 400px;
          text-align: center;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          box-shadow: 
            0 4px 15px rgba(0,0,0,0.15),
            inset 0 0 10px rgba(255,255,255,0.1);
        }
        .logo {
          width: 80px;
          height: 80px;
          margin: 0 auto 15px;
          background-image: url('${siteIcon}');
          background-size: contain;
          background-repeat: no-repeat;
          background-position: center;
        }
        h1 {
          color: #186db3;
          margin: 0 0 20px 0;
          font-size: 1.8rem;
        }
        .input-group {
          margin-bottom: 20px;
          text-align: left;
        }
        label {
          display: block;
          margin-bottom: 8px;
          font-weight: bold;
          color: #333;
        }
        input[type="password"] {
          width: 100%;
          padding: 12px;
          background-color: rgba(255, 255, 255, 0.35);
          border: 1px solid #ddd;
          border-radius: 8px;
          box-sizing: border-box;
          font-size: 16px;
          transition: border-color 0.3s;
        }
        input[type="password"]:focus {
          border-color: #186db3;
          outline: none;
          box-shadow: 0 0 0 2px rgba(37, 115, 179, 0.2);
        }
        button {
          width: 100%;
          padding: 12px;
          background-color: #186db3;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 16px;
          font-weight: bold;
          transition: background-color 0.3s;
        }
        button:hover:not(:disabled) {
          background-color: #1c5a8a;
        }
        button:disabled {
          background-color: #9bb8cd;
          cursor: not-allowed;
        }
        .turnstile-box {
          display: flex;
          justify-content: center;
          margin-bottom: 16px;
          min-height: 65px;
        }
        .hint {
          display: none;
          margin: 0 0 12px 0;
          font-size: 0.85rem;
          color: #666;
        }
        .error {
          color: #e74c3c;
          margin-top: 15px;
          padding: 10px;
          background-color: rgba(231, 76, 60, 0.1);
          border-radius: 4px;
          display: ${errorMessage ? 'block' : 'none'};
        }
        .footer {
          background-color: none;
          color: #333333;
          font-size: 0.8rem;
          width: 100%;
          text-align: center;
          padding: 16px 0;
          margin-top: 10px;
        }
        .footer p {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          align-items: center;
          gap: 8px;
          margin: 0;
        }
        .footer a {
          color: #333333;
          text-decoration: none;
          transition: color 0.3s ease;
          white-space: nowrap;
        }
        .footer a:hover {
          color: #186db3;
        }
        @media (max-width: 768px) {
          .footer p {
            line-height: 0.9;
            font-size: 0.75rem;
          }
          .login-container {
            width: 90%;
          }
        }
      </style>
    </head>
    <body>
      <div class="login-container">
        <h1>${siteName}</h1>
        <form id="loginForm" action="/login" method="POST">
          <div class="input-group">
            <label for="password">访问密码</label>
            <input type="password" id="password" name="password" required autocomplete="current-password">
          </div>
${turnstileOn ? `          <div class="turnstile-box">
            <div class="cf-turnstile" data-sitekey="${siteKey}" data-action="login" data-theme="auto" data-callback="onTurnstileSuccess" data-error-callback="onTurnstileError" data-expired-callback="onTurnstileExpired"></div>
          </div>
          <div id="tsHint" class="hint">请完成上方的人机验证后登录</div>
` : ''}${turnstileOn
        ? `          <button type="submit" id="submitBtn" disabled>请先完成人机验证</button>`
        : `          <button type="submit">登录系统</button>`}
          <div id="errorMessage" class="error">${escapeHtml(errorMessage)}</div>
        </form>
        <div class="footer">
          <p>
            <span>Copyright © ${currentYear} Yutian81</span><span>|</span>
            <a href="${githubURL}" target="_blank">
              <i class="fab fa-github"></i> Github</a><span>|</span>
            <a href="${blogURL}" target="_blank">
              <i class="fas fa-blog"></i> ${blogName}</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}
