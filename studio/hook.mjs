#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  AGENT STUDIO — Universal Hook SDK & CLI  (studio/hook.mjs)
//
//  1) Import from any Node script:
//       import studio from './studio/hook.mjs';
//       await studio.remember('Auth tokens expire in 15m', { tags: ['auth'], pinned: true });
//       await studio.note('Investigating kyc-webhook.php 400 error');
//       const mem = await studio.recall('auth tokens');
//       const res = await studio.ask('sentinel', 'Audit kyc.php for signature bypass');
//
//  2) Run from any terminal / git hook / task runner:
//       node studio/hook.mjs ping
//       node studio/hook.mjs remember "Use prepared statements in all PHP queries" --pin --tags=php,security
//       node studio/hook.mjs note "Refactoring contributor/dashboard.php"
//       node studio/hook.mjs recall "prepared statements"
//       node studio/hook.mjs list long
//       node studio/hook.mjs ask reviewer "Review contributor/includes/payouts.php"
//       node studio/hook.mjs agents
//       node studio/hook.mjs models
//       node studio/hook.mjs set editor.fontSize 14
//       node studio/hook.mjs emit deploy.done '{"branch":"main"}'
//
//  3) Or call over HTTP from PHP / Python / curl:
//       POST http://localhost:3300/api/studio/hook
//       { "action": "memory.remember", "text": "...", "pinned": true }
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_URL = process.env.AGENT_STUDIO_URL || 'http://localhost:3300';

function resolveDefaultToken() {
    if (process.env.AGENT_STUDIO_TOKEN) return process.env.AGENT_STUDIO_TOKEN;
    try {
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const candidate = path.join(root, '.agents', '.studio_auth_token');
        if (fs.existsSync(candidate)) {
            const t = fs.readFileSync(candidate, 'utf8').trim();
            if (t) return t;
        }
    } catch {}
    return '';
}
const DEFAULT_TOKEN = resolveDefaultToken();

export function createHookClient({ baseUrl = DEFAULT_URL, token = DEFAULT_TOKEN } = {}) {
    const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/api/studio/hook`;

    async function call(action, params = {}) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['x-studio-token'] = token;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ action, ...params })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
            throw new Error(data?.error?.message || `Studio hook HTTP ${res.status}`);
        }
        return data.result;
    }

    return {
        call,
        ping: () => call('ping'),
        remember: (text, opts = {}) => call('memory.remember', { text, ...opts }),
        note: (text, opts = {}) => call('memory.note', { text, ...opts }),
        recall: (query, limit = 8, agent = null) => call('memory.recall', { query, limit, agent }),
        listMemory: (tier = 'long') => call('memory.list', { tier }),
        forget: (id, tier = 'long') => call('memory.forget', { id, tier }),
        ask: (agent, prompt, opts = {}) => call('agent.run', { agent, prompt, ...opts }),
        agents: () => call('agents.list'),
        models: () => call('models.list'),
        getConfig: () => call('config.get'),
        getSettings: () => call('settings.get'),
        setSetting: (path, value) => call('settings.set', { path, value }),
        emit: (event, data = {}) => call('event.emit', { event, data }),
        log: (message) => call('log', { message })
    };
}

const studio = createHookClient();
export default studio;

// ─── CLI runner when invoked directly ───────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const [, , cmd, ...rest] = process.argv;
    const flags = {};
    const pos = [];
    for (const arg of rest) {
        if (arg.startsWith('--')) {
            const [k, v] = arg.slice(2).split('=');
            flags[k] = v === undefined ? true : v;
        } else {
            pos.push(arg);
        }
    }

    (async () => {
        try {
            switch (cmd) {
                case 'ping':
                    console.log(JSON.stringify(await studio.ping(), null, 2));
                    break;
                case 'remember':
                    console.log(JSON.stringify(await studio.remember(pos.join(' '), {
                        pinned: !!flags.pin || !!flags.pinned,
                        tags: flags.tags ? String(flags.tags).split(',') : [],
                        importance: flags.importance ? Number(flags.importance) : 3,
                        agent: flags.agent || '*'
                    }), null, 2));
                    break;
                case 'note':
                    console.log(JSON.stringify(await studio.note(pos.join(' '), {
                        kind: flags.kind || 'cli',
                        ttlHours: flags.ttl ? Number(flags.ttl) : undefined,
                        agent: flags.agent || '*'
                    }), null, 2));
                    break;
                case 'recall':
                    console.log(JSON.stringify(await studio.recall(pos.join(' '), Number(flags.limit) || 8, flags.agent || null), null, 2));
                    break;
                case 'list':
                    console.log(JSON.stringify(await studio.listMemory(pos[0] || 'long'), null, 2));
                    break;
                case 'forget':
                    console.log(JSON.stringify(await studio.forget(pos[0], pos[1] || 'long'), null, 2));
                    break;
                case 'ask':
                case 'run': {
                    const [agent, ...promptParts] = pos;
                    const res = await studio.ask(agent, promptParts.join(' '), { model: flags.model });
                    console.log(res.text);
                    break;
                }
                case 'agents':
                    console.table(await studio.agents());
                    break;
                case 'models':
                    console.table(await studio.models());
                    break;
                case 'settings':
                    console.log(JSON.stringify(await studio.getSettings(), null, 2));
                    break;
                case 'set': {
                    const [p, rawVal] = pos;
                    let val = rawVal;
                    if (rawVal === 'true') val = true;
                    else if (rawVal === 'false') val = false;
                    else if (!Number.isNaN(Number(rawVal))) val = Number(rawVal);
                    console.log(JSON.stringify(await studio.setSetting(p, val), null, 2));
                    break;
                }
                case 'emit': {
                    const [evt, json] = pos;
                    const data = json ? JSON.parse(json) : {};
                    console.log(JSON.stringify(await studio.emit(evt, data), null, 2));
                    break;
                }
                default:
                    console.log(`Agent Studio Hook CLI
Usage:
  node studio/hook.mjs ping
  node studio/hook.mjs remember "<fact>" [--pin] [--tags=a,b] [--importance=1..5]
  node studio/hook.mjs note "<working note>" [--ttl=48]
  node studio/hook.mjs recall "<query>" [--limit=8]
  node studio/hook.mjs list [long|short]
  node studio/hook.mjs forget <id> [long|short]
  node studio/hook.mjs ask <agentId> "<prompt>" [--model=...]
  node studio/hook.mjs agents | models | settings
  node studio/hook.mjs set <path> <value>
  node studio/hook.mjs emit <eventName> ['{"key":"val"}']`);
            }
        } catch (err) {
            console.error('[Studio Hook Error]:', err.message);
            process.exit(1);
        }
    })();
}

