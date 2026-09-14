// src/cron.js

import { getConfig, sendtgMessage } from './utils';
import { getDomainsFromKV } from './api/domains';

// 封装获取域名列表的函数
export async function getDomainsList(env) {
    try {
        return await getDomainsFromKV(env);
    } catch (e) {
        console.error('从 KV 获取域名列表失败:', e.message);
        return [];
    }
}

// 检查将到期的域名
export async function checkDomainsScheduled(env) {
    const config = getConfig(env);
    const allDomains = await getDomainsList(env);
    const expiringDomains = []; // 收集即将到期的域名

    if (allDomains.length === 0) {
        console.log("KV中没有域名数据，跳过定时检查");
        return expiringDomains;
    }

    const now = new Date();
    const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

    for (const domainInfo of allDomains) {
        const maxDaysForAlert = config.days; // 使用配置中的 DAYS (默认为 30) 来判断
        const expirationUTC = Date.parse(domainInfo.expirationDate);
        if (isNaN(expirationUTC)) {
            console.warn(`跳过无效日期 (${domainInfo.domain}): ${domainInfo.expirationDate}`);
            continue; 
        }
        const timeDiff = expirationUTC - todayUTC;
        const daysRemaining = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
        
        // 只对即将到期 (1 < 剩余天数 <= maxDaysForAlert) 的域名发送通知
        if (daysRemaining > 0 && daysRemaining <= maxDaysForAlert) {
            const message = `
<b>🚨 域名到期提醒 🚨</b>
====================
🌐 域名: <code>${domainInfo.domain}</code>
♻️ 将在 <b>${daysRemaining}天</b> 后过期！
📅 过期日期: ${domainInfo.expirationDate}
🔗 注册商: <a href="${domainInfo.systemURL}">${domainInfo.system}</a>
👤 注册账号: <code>${domainInfo.registerAccount || 'N/A'}</code>
--------------------------`;

            const result = await sendtgMessage(message, config.tgid, config.tgtoken);
            if (result.ok) {
                console.log(`已发送 ${domainInfo.domain} 的到期通知.`);
            } else {
                console.error(`发送 ${domainInfo.domain} 的到期通知失败: ${result.description}`);
            }
            expiringDomains.push({
                domain: domainInfo.domain,
                expirationDate: domainInfo.expirationDate,
                daysRemaining: daysRemaining,
                system: domainInfo.system,
                systemURL: domainInfo.systemURL,
                registerAccount: domainInfo.registerAccount || 'N/A',
                groups: domainInfo.groups || 'N/A'
            });
        }
    }
    return expiringDomains;
}
