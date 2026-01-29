import htmlContent from './index.html';

const DEFAULT_CONFIG = {
    urls: [
        { id: "google", name: "Google", url: "https://www.google.com", categoryId: "general" },
        { id: "github", name: "GitHub", url: "https://github.com", categoryId: "general" },
        { id: "dezso.hu", name: "dezso.hu", url: "https://www.dezso.hu", categoryId: "internal" }
    ],
    categories: [
        { id: "general", name: "Általános", defaultOpen: true },
        { id: "internal", name: "Belső rendszerek", defaultOpen: true }
    ],
    successCodes: [200, 201, 202, 203, 204, 301, 302, 307, 308]
};

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export default {
    async scheduled(event, env, ctx) {
        const [dataRaw, configRaw] = await Promise.all([
            env.STATUS_KV.get("uptime_data"),
            env.STATUS_KV.get("config")
        ]);

        let data = dataRaw ? JSON.parse(dataRaw) : {};
        const config = configRaw ? JSON.parse(configRaw) : DEFAULT_CONFIG;
        const now = Date.now();
        const limit = now - THIRTY_DAYS;
        const successSet = new Set(config.successCodes);

        const fetchPromises = config.urls.map(async (target) => {
            if (!data[target.id]) {
                data[target.id] = {
                    name: target.name, url: target.url,
                    detailedLogs: [], incidents: [], lastStatus: null,
                    categoryId: target.categoryId || 'none'
                };
            }

            const monitor = data[target.id];
            monitor.name = target.name;
            monitor.url = target.url;
            monitor.categoryId = target.categoryId || 'none';

            const startTime = Date.now();
            let result = { status: 0, ok: false, responseTime: 0, time: now };

            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);

                const response = await fetch(target.url, {
                    method: 'HEAD',
                    headers: { 'User-Agent': 'DEZSO-Status/1.2' },
                    signal: controller.signal,
                    redirect: 'follow'
                });

                clearTimeout(timeoutId);
                result.status = response.status;
                result.ok = successSet.has(response.status);
                result.responseTime = Date.now() - startTime;
            } catch (e) {
                result.status = 0;
                result.ok = false;
                result.responseTime = 0;
            }

            const wasOk = monitor.lastStatus?.ok ?? true;
            if (wasOk && !result.ok) {
                monitor.incidents.push({ start: now, end: null, code: result.status });
            } else if (!wasOk && result.ok) {
                const lastInc = monitor.incidents[monitor.incidents.length - 1];
                if (lastInc && !lastInc.end) lastInc.end = now;
            }

            monitor.lastStatus = result;
            monitor.detailedLogs.push(result);

            if (monitor.detailedLogs.length > 8640) {
                monitor.detailedLogs = monitor.detailedLogs.filter(l => l.time > limit);
            }
            if (monitor.incidents.length > 50) {
                monitor.incidents = monitor.incidents.slice(-50);
            }
        });

        await Promise.all(fetchPromises);

        const activeIds = new Set(config.urls.map(u => u.id));
        for (const key of Object.keys(data)) {
            if (!activeIds.has(key)) delete data[key];
        }

        await env.STATUS_KV.put("uptime_data", JSON.stringify(data));
    },

    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.searchParams.get("api") === "true") {
            const data = await env.STATUS_KV.get("uptime_data");
            const config = await env.STATUS_KV.get("config") || JSON.stringify(DEFAULT_CONFIG);
            return new Response(JSON.stringify({
                metrics: JSON.parse(data || "{}"),
                config: JSON.parse(config)
            }), {
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
            });
        }

        if (request.method === "POST" && url.searchParams.get("admin") === "true") {
            const body = await request.json();
            const { password, config } = body;

            const msgUint8 = new TextEncoder().encode(password);
            const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

            if (hashHex !== env.ADMIN_PASSWORD_HASH) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
            }

            if (config) {
                await env.STATUS_KV.put("config", JSON.stringify(config));
                return new Response(JSON.stringify({ success: true }));
            }
        }

        return new Response(htmlContent, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
        });
    }
};