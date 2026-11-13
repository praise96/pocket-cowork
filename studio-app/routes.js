// ═══════════════════════════════════════════════════════════════════════════
//  AGENT STUDIO — HTTP routes  (/api/studio/*  and  /__studio/* assets)
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

function readBody(req, limit = 5 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => { body += c; if (body.length > limit) { reject(new Error('Body too large')); req.destroy(); } });
        req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(new Error('Invalid JSON body')); } });
        req.on('error', reject);
    });
}

function send(res, status, data) {
    if (res.headersSent) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
}

function isLoopback(req) {
    const a = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

function tokenFrom(req) {
    const header = String(req.headers['x-studio-token'] || '').trim() || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (header) return header;
    const cookie = req.headers?.cookie || '';
    const m = cookie.match(/(?:^|;\s*)studio_auth_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1].trim());
    return '';
}

/** Returns true if the request was handled. */
export async function handleStudioRoute(studio, req, res, pathname) {
    // ── Static UI assets ────────────────────────────────────────────────────
    if (pathname === '/__studio/ui.js' || pathname === '/__studio/ui.css') {
        const file = path.join(APP_DIR, pathname.endsWith('.js') ? 'ui.js' : 'ui.css');
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': pathname.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(data);
        });
        return true;
    }

    if (!pathname.startsWith('/api/studio')) return false;

    // ── Access control (Fail-closed: token required even over loopback) ───────
    const sec = studio.getConfig().settings.security;
    const realHookToken = sec.hookToken && sec.hookToken !== '••••••••' ? sec.hookToken : '';
    const masterToken = studio.getMasterToken ? studio.getMasterToken() : '';
    const reqTok = tokenFrom(req);

    const isAuthed = (masterToken && reqTok === masterToken) || (realHookToken && reqTok === realHookToken);
    if (!isAuthed) {
        send(res, 401, { error: { message: 'Studio token required (x-studio-token header).', code: 'UNAUTHORIZED', needsToken: true } });
        return true;
    }

    if (pathname === '/api/studio/hook') {
        const local = isLoopback(req);
        if (!local && !sec.allowRemoteHookCalls) {
            send(res, 403, { error: { message: 'Remote hook calls are disabled. Enable Settings → Security → Allow remote hook calls.' } });
            return true;
        }
    }

    try {
        // Live activity stream (Server-Sent Events)
        if (pathname === '/api/studio/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
            res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
            const off = studio.onEvent(e => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch (err) {} });
            const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (err) {} }, 25000);
            req.on('close', () => { off(); clearInterval(ping); });
            return true;
        }

        if (pathname === '/api/studio/state' && req.method === 'GET') { send(res, 200, studio.state()); return true; }
        if (pathname === '/api/studio/models' && req.method === 'GET') { send(res, 200, { models: studio.listModels() }); return true; }
        if (pathname === '/api/studio/activity' && req.method === 'GET') { send(res, 200, { activity: studio.activity.slice(0, 200), stats: studio.state().stats }); return true; }

        if (pathname === '/api/studio/memory' && req.method === 'GET') {
            send(res, 200, { long: studio.loadLTM().entries, short: studio.loadSTM().entries });
            return true;
        }

        if (req.method !== 'POST') { send(res, 405, { error: { message: 'Use POST' } }); return true; }
        const body = await readBody(req);

        switch (pathname) {
            case '/api/studio/config': {
                const current = studio.getConfig();
                const next = { ...current, ...body };
                // Never let a masked token overwrite the real one
                if (next.settings?.security?.hookToken === '••••••••') next.settings.security.hookToken = current.settings.security.hookToken;
                send(res, 200, { ok: true, config: (studio.saveConfig(next), studio.publicConfig()) });
                return true;
            }
            case '/api/studio/secret': {
                if (!body.providerId) throw new Error('providerId is required');
                studio.setKey(body.providerId, body.apiKey || '');
                send(res, 200, { ok: true, config: studio.publicConfig() });
                return true;
            }
            case '/api/studio/provider/test': { send(res, 200, await studio.testProvider(body.providerId)); return true; }
            case '/api/studio/memory': { send(res, 200, { ok: true, result: studio.memoryOp(body) }); return true; }
            case '/api/studio/memory/consolidate': { send(res, 200, await studio.consolidateMemory(body)); return true; }
            case '/api/studio/context-preview': {
                const ctx = await studio.buildContext({ agentId: body.agent, userText: body.query || '', sessionId: body.sessionId, model: body.model });
                send(res, 200, { block: ctx.block, used: ctx.used, agent: ctx.agent?.id || null });
                return true;
            }
            case '/api/studio/hooks/test': { send(res, 200, { ok: true, injected: await studio.runHooks(body.event || 'beforeChat', { userText: 'Hook test from Agent Studio', model: 'test' }, body.id) }); return true; }
            case '/api/studio/run': { send(res, 200, await studio.runAgent(body)); return true; }
            case '/api/studio/arena': {
                const models = (Array.isArray(body.models) ? body.models : []).slice(0, 4);
                if (!models.length || !body.prompt) throw new Error('prompt and models[] are required');
                const results = await Promise.all(models.map(async m => {
                    try { return { model: m, ok: true, ...(await studio.runAgent({ agent: body.agent, prompt: body.prompt, model: m, withMemory: body.withMemory !== false })) }; }
                    catch (e) { return { model: m, ok: false, error: e.message }; }
                }));
                send(res, 200, { results });
                return true;
            }
            case '/api/studio/reset': { send(res, 200, studio.resetSection(body.what)); return true; }
            case '/api/studio/hook': {
                // Universal agent hook: POST { action, ...params }
                const result = await studio.dispatch(body.action, body);
                send(res, 200, { ok: true, action: body.action, result });
                return true;
            }
            default:
                send(res, 404, { error: { message: `Unknown studio route ${pathname}` } });
                return true;
        }
    } catch (e) {
        send(res, 400, { ok: false, error: { message: e.message } });
        return true;
    }
}

