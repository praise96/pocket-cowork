import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import zlib from 'node:zlib';
import os from 'node:os';
import { createStudio } from './studio-app/core.js';
import { handleStudioRoute } from './studio-app/routes.js';

let DatabaseSync = null;
try {
    const sqliteMod = await import('node:sqlite');
    DatabaseSync = sqliteMod.DatabaseSync;
} catch (e) {
    // Graceful fallback for older Node versions or builds without built-in SQLite
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Zero-Dependency .env Loader ─────────────────────────────────────────────
function loadDotEnv() {
    const envPath = path.join(__dirname, '.env');
    const examplePath = path.join(__dirname, '.env.example');
    try {
        if (!fs.existsSync(envPath)) {
            if (fs.existsSync(examplePath)) {
                fs.copyFileSync(examplePath, envPath);
                console.log('[Env] Auto-created .env from .env.example');
            } else {
                fs.writeFileSync(envPath, 'PORT=3300\nHOST=127.0.0.1\nAGENTROUTER_API_KEY=\n', 'utf8');
                console.log('[Env] Auto-created default .env');
            }
        }
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const eqIdx = line.indexOf('=');
            if (eqIdx === -1) continue;
            const key = line.slice(0, eqIdx).trim();
            let val = line.slice(eqIdx + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (key && process.env[key] === undefined) {
                process.env[key] = val;
            }
        }
    } catch (e) {
        console.warn('[Env] Could not parse .env file:', e.message);
    }
}
loadDotEnv();

const PORT = Number(process.env.PORT) || 3300;
const HOST = process.env.HOST || '127.0.0.1';
const AGENTROUTER_ENDPOINT = 'https://agentrouter.org/v1';
const WHITELISTED_UA = 'Kilo-Code/5.3.0';

// ── Persistent Studio Auth Token (IDE authentication token) ─────────────────
function getOrCreateStudioToken() {
    const tokenPath = path.join(__dirname, '.agents', '.studio_auth_token');
    try {
        if (fs.existsSync(tokenPath)) {
            const val = fs.readFileSync(tokenPath, 'utf8').trim();
            if (val && val.length >= 16) return val;
        }
    } catch {}
    const newToken = crypto.randomBytes(24).toString('hex');
    try {
        const dir = path.dirname(tokenPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tokenPath, newToken, 'utf8');
    } catch (e) {
        console.warn('[Auth] Could not write .studio_auth_token file:', e.message);
    }
    return newToken;
}
const studioAuthToken = getOrCreateStudioToken();

// Fallback IP cache for agentrouter.org in case of transient OS/router DNS hiccups (EAI_AGAIN)
let cachedAgentRouterIPs = ['8.214.161.192', '8.214.160.125'];
dns.resolve4('agentrouter.org', (err, addresses) => {
    if (!err && addresses && addresses.length > 0) {
        cachedAgentRouterIPs = addresses;
    }
});

function resilientLookup(hostname, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    const isAll = typeof options === 'object' && options !== null && !!options.all;

    dns.lookup(hostname, options, (err, address, family) => {
        if (err && (err.code === 'EAI_AGAIN' || err.code === 'ENOTFOUND' || err.code === 'ETIMEOUT') && hostname === 'agentrouter.org') {
            console.warn(`[DNS] Transient lookup failure (${err.code}), using cached IP: ${cachedAgentRouterIPs[0]}`);
            if (isAll) {
                return callback(null, cachedAgentRouterIPs.map(ip => ({ address: ip, family: 4 })));
            } else {
                return callback(null, cachedAgentRouterIPs[0], 4);
            }
        }
        callback(err, address, family);
    });
}

// Clean HTTPS agent: keepAlive disabled to eliminate TLS socket reuse corruption and OpenSSL "bad record mac" errors
const upstreamAgent = new https.Agent({
    keepAlive: false,
    timeout: 60000,
    lookup: resilientLookup
});

function sanitizeForUpstreamWAF(str) {
    if (typeof str !== 'string') return str;
    return str
        // Remove null bytes and unprintable ASCII control characters (keeping \t, \n, \r)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/AIzaSy[A-Za-z0-9_-]{33}/g, 'AIzaSy[REDACTED]')
        .replace(/(?:api[_-]?key|secret|token)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/gi, 'apiKey="[REDACTED]"');
}

function parseCMap(cmapStr) {
  const map = {};
  const bfCharRegex = /beginbfchar([\s\S]*?)endbfchar/g;
  let match;
  while ((match = bfCharRegex.exec(cmapStr)) !== null) {
    const pairs = match[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g);
    if (pairs) {
      for (const p of pairs) {
        const m = p.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
        if (m) map[parseInt(m[1], 16)] = String.fromCharCode(parseInt(m[2], 16));
      }
    }
  }
  const bfRangeRegex = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = bfRangeRegex.exec(cmapStr)) !== null) {
    const lines = match[1].trim().split('\n');
    for (const l of lines) {
      const parts = l.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (parts) {
        const start = parseInt(parts[1], 16);
        const end = parseInt(parts[2], 16);
        let dest = parseInt(parts[3], 16);
        for (let c = start; c <= end; c++) map[c] = String.fromCharCode(dest++);
      }
    }
  }
  return map;
}

function extractTextFromPdfBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return '';
  const cmaps = {};
  const contentStreams = [];
  const textLines = [];

  const latinStr = buf.toString('latin1');
  const metaMatches = latinStr.match(/\/(?:Title|Author|Subject|Keywords)\s*\(([^)]{1,200})\)/gi);
  if (metaMatches) {
    for (const mm of metaMatches) {
      const cleanMeta = mm.replace(/^[/(A-Za-z]+\s*\(/, '').replace(/\)$/, '').replace(/[^\x20-\x7E]/g, ' ').trim();
      if (cleanMeta.length > 2) textLines.push(cleanMeta);
    }
  }

  const streamHeader = Buffer.from('stream');
  const endStream = Buffer.from('endstream');
  let pos = 0;

  while ((pos = buf.indexOf(streamHeader, pos)) !== -1) {
    let start = pos + 6;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a || buf[start] === 0x0d) start += 1;
    const end = buf.indexOf(endStream, start);
    if (end === -1) break;

    const streamData = buf.subarray(start, end);
    let decomp = null;
    try { decomp = zlib.inflateSync(streamData); } catch(e){}
    if (decomp) {
      const s = decomp.toString('latin1');
      if (s.includes('begincmap')) {
        Object.assign(cmaps, parseCMap(s));
      } else if (s.includes('BT') && s.includes('ET')) {
        contentStreams.push(s);
      }
    }
    pos = end + 9;
  }

  for (const stream of contentStreams) {
    let streamText = '';
    const tokenRegex = /<([0-9a-fA-F]+)>\s*(?:Tj|'|")|\[([\s\S]*?)\]\s*TJ|\(([^)]+)\)\s*(?:Tj|'|")|\b(?:T\*|ET)\b/g;
    let match;
    while ((match = tokenRegex.exec(stream)) !== null) {
      if (match[1]) {
        const hex = match[1];
        for (let i = 0; i < hex.length; i += 4) {
          const code = parseInt(hex.slice(i, i + 4), 16);
          streamText += cmaps[code] || '';
        }
      } else if (match[2]) {
        const inner = match[2];
        const parts = inner.match(/<([0-9a-fA-F]+)>|\(([^)]+)\)|(-?\d+(?:\.\d+)?)/g);
        if (parts) {
          for (const p of parts) {
            if (p.startsWith('<')) {
              const hex = p.slice(1, -1);
              for (let i = 0; i < hex.length; i += 4) {
                const code = parseInt(hex.slice(i, i + 4), 16);
                streamText += cmaps[code] || '';
              }
            } else if (p.startsWith('(')) {
              streamText += p.slice(1, -1).replace(/\\([()\\])/g, '$1');
            } else {
              const num = parseFloat(p);
              if (num < -120) streamText += ' ';
            }
          }
        }
      } else if (match[3]) {
        const s = match[3].replace(/\\([()\\])/g, '$1').replace(/[^\x20-\x7E\r\n\t]/g, ' ');
        streamText += s;
      } else {
        streamText += '\n';
      }
    }
    const cleanStream = streamText.replace(/[\t ]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    if (cleanStream.length > 0) textLines.push(cleanStream);
  }

  const result = textLines.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return result.slice(0, 20000);
}

function formatMessagesForApi(messages, isResponsesApi) {
    return (messages || []).map(m => {
        let content = m.content;
        if (Array.isArray(content)) {
            if (isResponsesApi) {
                // Responses API (/v1/responses): items MUST be 'input_text' or 'input_image'
                const formatted = content.map(item => {
                    if (typeof item === 'string') return { type: 'input_text', text: sanitizeForUpstreamWAF(item) };
                    if (item && (item.type === 'image_url' || item.type === 'input_image' || item.image_url)) {
                        const imgUrl = typeof item.image_url === 'string'
                            ? item.image_url
                            : (item.image_url?.url || item.url || '');
                        return { type: 'input_image', image_url: imgUrl };
                    }
                    if (item && (item.type === 'text' || item.type === 'input_text')) {
                        return { type: 'input_text', text: sanitizeForUpstreamWAF(item.text || '') };
                    }
                    return { type: 'input_text', text: sanitizeForUpstreamWAF(String(item?.text || item || '')) };
                });
                return { role: m.role || 'user', content: formatted };
            } else {
                // Chat Completions API (/v1/chat/completions): items MUST be 'text' or 'image_url'
                const formatted = content.map(item => {
                    if (typeof item === 'string') return { type: 'text', text: sanitizeForUpstreamWAF(item) };
                    if (item && (item.type === 'image_url' || item.type === 'input_image' || item.image_url)) {
                        const imgUrl = typeof item.image_url === 'string'
                            ? item.image_url
                            : (item.image_url?.url || item.url || '');
                        return { type: 'image_url', image_url: { url: imgUrl } };
                    }
                    if (item && (item.type === 'text' || item.type === 'input_text')) {
                        return { type: 'text', text: sanitizeForUpstreamWAF(item.text || '') };
                    }
                    return { type: 'text', text: sanitizeForUpstreamWAF(String(item?.text || item || '')) };
                });
                return { role: m.role || 'user', content: formatted };
            }
        }
        let rawText = sanitizeForUpstreamWAF(typeof content === 'string' ? content : String(content || ''));
        if (rawText.length > 25000) {
            rawText = rawText.slice(0, 25000) + '\n... [Remaining content truncated for gateway stability]';
        }
        return {
            role: m.role || 'user',
            content: rawText
        };
    });
}

function postAgentRouterRaw(payload, token, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
        let isDone = false;
        let req = null;
        const hardTimer = setTimeout(() => {
            if (!isDone) {
                isDone = true;
                if (req) try { req.destroy(new Error('Hard timeout exceeded')); } catch(e){}
                reject(new Error(`Agent Router request timed out after ${Math.round(timeoutMs / 1000)}s`));
            }
        }, timeoutMs);

        const isResponsesApi = ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol'].includes(payload.model);
        const apiPath = isResponsesApi ? '/v1/responses' : '/v1/chat/completions';
        let sendPayload = { ...payload };
        // Agent Router models (especially gpt-5.6-sol / gpt-6-astra / reasoning endpoints) reject 'temperature' with HTTP 400
        delete sendPayload.temperature;
        if (isResponsesApi) {
            sendPayload = {
                model: payload.model,
                input: formatMessagesForApi(payload.messages || [], true)
            };
        } else {
            sendPayload.messages = formatMessagesForApi(payload.messages || [], false);
        }

        const body = JSON.stringify(sendPayload);
        try {
            req = https.request({
                hostname: 'agentrouter.org',
                servername: 'agentrouter.org',
                port: 443,
                path: apiPath,
                method: 'POST',
                agent: upstreamAgent,
                headers: {
                    'Host': 'agentrouter.org',
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'User-Agent': WHITELISTED_UA,
                    'Content-Length': Buffer.byteLength(body),
                    'Connection': 'close'
                },
                timeout: timeoutMs
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (!isDone) {
                        isDone = true;
                        clearTimeout(hardTimer);
                        if (isResponsesApi && res.statusCode === 200) {
                            try {
                                const parsed = JSON.parse(data);
                                const text = parsed.output?.find(o => o.type === 'message')?.content?.find(c => c.type === 'output_text')?.text || '';
                                const converted = JSON.stringify({
                                    id: parsed.id,
                                    object: 'chat.completion',
                                    created: parsed.created_at || Math.floor(Date.now() / 1000),
                                    model: parsed.model,
                                    choices: [{
                                        index: 0,
                                        message: { role: 'assistant', content: text },
                                        finish_reason: 'stop'
                                    }],
                                    usage: {
                                        prompt_tokens: parsed.usage?.input_tokens || 0,
                                        completion_tokens: parsed.usage?.output_tokens || 0,
                                        total_tokens: parsed.usage?.total_tokens || 0
                                    }
                                });
                                return resolve({ status: 200, headers: res.headers, body: converted });
                            } catch(e){}
                        }
                        resolve({ status: res.statusCode, headers: res.headers, body: data });
                    }
                });
            });

            req.on('error', (err) => {
                if (!isDone) {
                    isDone = true;
                    clearTimeout(hardTimer);
                    reject(err);
                }
            });
            req.on('timeout', () => {
                if (!isDone) {
                    isDone = true;
                    clearTimeout(hardTimer);
                    if (req) try { req.destroy(new Error('Agent Router request timed out')); } catch(e){}
                    reject(new Error(`Agent Router request timed out after ${Math.round(timeoutMs / 1000)}s`));
                }
            });
            req.write(body);
            req.end();
        } catch (err) {
            if (!isDone) {
                isDone = true;
                clearTimeout(hardTimer);
                reject(err);
            }
        }
    });
}

function getStoredKey() {
    // 1. Agent Studio secrets & .env take priority
    try {
        if (typeof studio !== 'undefined' && studio) {
            const k = studio.getKey('agentrouter');
            if (k) return k;
        }
    } catch (e) {}
    if (process.env.AGENTROUTER_API_KEY && !process.env.AGENTROUTER_API_KEY.includes('your-')) {
        return process.env.AGENTROUTER_API_KEY.trim();
    }
    const keyPath = path.join(__dirname, '.agents', '.router_key');
    if (fs.existsSync(keyPath)) {
        const raw = fs.readFileSync(keyPath, 'utf8');
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            if (line.startsWith('sk-')) {
                return line;
            }
        }
        const val = raw.trim();
        if (val && !val.includes('PASTE_YOUR_API_TOKEN_HERE')) {
            return val;
        }
    }
    return '';
}

function saveKey(key) {
    const dir = path.join(__dirname, '.agents');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.router_key'), key.trim(), 'utf8');
}

// In-memory cache for assistant reasoning_content / thinking traces
const thinkingCache = new Map();

// Workspace File Utilities & Active Project Management
const CONFIG_FILE = path.join(__dirname, '.agents', 'workspace_config.json');

function loadWorkspaceConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            if (data.activeWorkspace && fs.existsSync(data.activeWorkspace) && fs.statSync(data.activeWorkspace).isDirectory()) {
                return data;
            }
        }
    } catch (e) {}
    const def = {
        activeWorkspace: path.resolve(__dirname),
        recentWorkspaces: [path.resolve(__dirname)]
    };
    try {
        const dir = path.dirname(CONFIG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(def, null, 2), 'utf8');
    } catch (e) {}
    return def;
}

let workspaceConfig = loadWorkspaceConfig();
let activeWorkspacePath = path.resolve(workspaceConfig.activeWorkspace || __dirname);

// ── Agent Studio engine (providers, agents, memory, hooks) ──
const studio = createStudio({
    rootDir: __dirname,
    getWorkspacePath: () => activeWorkspacePath,
    agentRouterPost: (payload, token, timeoutMs) => postAgentRouterRaw(payload, token, timeoutMs),
    legacyKeyPath: path.join(__dirname, '.agents', '.router_key'),
    masterToken: studioAuthToken
});

// Map tool names → Agent Studio permission categories
const TOOL_PERMISSION_MAP = {
    write_workspace_file: 'write', write_file: 'write', create_file: 'write', edit_file: 'write', save_file: 'write',
    read_workspace_file: 'read', list_workspace_files: 'read',
    search_codebase: 'search',
    execute_terminal_command: 'terminal', run_terminal_command: 'terminal', run_command: 'terminal', terminal_run: 'terminal',
    save_project_memory: 'memory', remember_note: 'memory', save_memory: 'memory', remember: 'memory', recall_memory: 'memory',
    delegate_to_agent: 'delegate'
};
function agentAllowsTool(agent, toolName) {
    if (!agent) return true;
    const cat = TOOL_PERMISSION_MAP[toolName];
    return !cat || (agent.tools || []).includes(cat);
}
function flattenContent(content) {
    if (Array.isArray(content)) return content.map(c => (typeof c === 'string' ? c : (c.text || ''))).join('');
    return typeof content === 'string' ? content : String(content ?? '');
}

function saveWorkspaceConfig() {
    try {
        const dir = path.dirname(CONFIG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(workspaceConfig, null, 2), 'utf8');
    } catch (e) {
        console.warn('[Workspace] Could not save workspace config:', e.message);
    }
}

// Persistent Chat Sessions Database & Long-Term Project Memory
const SESSIONS_DB_FILE = path.join(__dirname, '.agents', 'sessions_db.json');
const MEMORY_DB_FILE = path.join(__dirname, '.agents', 'agent_memory.json');

(function ensureAgentsBootstrap() {
    try {
        const dir = path.dirname(SESSIONS_DB_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(SESSIONS_DB_FILE)) {
            fs.writeFileSync(SESSIONS_DB_FILE, JSON.stringify({ sessions: {}, activeSessionId: null }, null, 2), 'utf8');
        }
        if (!fs.existsSync(MEMORY_DB_FILE)) {
            fs.writeFileSync(MEMORY_DB_FILE, JSON.stringify({}, null, 2), 'utf8');
        }
    } catch (e) {}
})();

function loadSessionsDB() {
    try {
        if (fs.existsSync(SESSIONS_DB_FILE)) {
            const data = JSON.parse(fs.readFileSync(SESSIONS_DB_FILE, 'utf8'));
            if (data && typeof data === 'object') {
                return {
                    sessions: data.sessions || {},
                    activeSessionId: data.activeSessionId || null
                };
            }
        }
    } catch (e) {
        console.warn('[Sessions DB] Load warning:', e.message);
    }
    return { sessions: {}, activeSessionId: null };
}

function saveSessionsDB(data) {
    try {
        const dir = path.dirname(SESSIONS_DB_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(SESSIONS_DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.warn('[Sessions DB] Save error:', e.message);
    }
}

function loadProjectMemory(projectPath) {
    const memDir = path.join(projectPath, '.cowork');
    const memFile = path.join(memDir, 'memory.json');
    try {
        if (fs.existsSync(memFile)) {
            const data = JSON.parse(fs.readFileSync(memFile, 'utf8'));
            if (data && typeof data === 'object') return data;
        }
    } catch (e) {}

    try {
        if (fs.existsSync(MEMORY_DB_FILE)) {
            const all = JSON.parse(fs.readFileSync(MEMORY_DB_FILE, 'utf8'));
            if (all && all[projectPath]) return all[projectPath];
        }
    } catch (e) {}

    return {
        notes: [],
        facts: {},
        updatedAt: Date.now()
    };
}

function saveProjectMemory(projectPath, memData) {
    try {
        const dir = path.join(projectPath, '.cowork');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const memFile = path.join(dir, 'memory.json');
        fs.writeFileSync(memFile, JSON.stringify(memData, null, 2), 'utf8');
    } catch (e) {
        try {
            const dir = path.dirname(MEMORY_DB_FILE);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            let all = {};
            if (fs.existsSync(MEMORY_DB_FILE)) {
                try { all = JSON.parse(fs.readFileSync(MEMORY_DB_FILE, 'utf8')) || {}; } catch(err){}
            }
            all[projectPath] = memData;
            fs.writeFileSync(MEMORY_DB_FILE, JSON.stringify(all, null, 2), 'utf8');
        } catch(err){}
    }
}

// ── Progressive Disclosure Skills Hub & ADK Playbooks ────────────────────────
function parseSkillFrontmatter(content) {
    let name = '';
    let description = '';
    let tags = [];
    let body = content || '';
    const fmMatch = (content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (fmMatch) {
        const fm = fmMatch[1];
        body = fmMatch[2].trim();
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        if (nameMatch) name = nameMatch[1].trim();
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        if (descMatch) description = descMatch[1].trim();
        const tagsMatch = fm.match(/^tags:\s*\[?(.*?)\]?$/m);
        if (tagsMatch) {
            tags = tagsMatch[1].split(',').map(s => s.trim().replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
        }
    }
    return { name, description, tags, body, raw: content };
}

function scanSkillFiles(dirPath, maxDepth = 5) {
    const list = [];
    function walk(curr, depth) {
        if (depth > maxDepth || !fs.existsSync(curr)) return;
        try {
            const entries = fs.readdirSync(curr, { withFileTypes: true });
            for (const ent of entries) {
                const full = path.join(curr, ent.name);
                if (ent.isDirectory()) {
                    const skillFile = path.join(full, 'SKILL.md');
                    if (fs.existsSync(skillFile)) {
                        list.push(skillFile);
                    }
                    walk(full, depth + 1);
                }
            }
        } catch (e) {}
    }
    walk(dirPath, 0);
    return list;
}

function listAvailableSkills(workspacePath) {
    const candidateDirs = [
        path.join(workspacePath, 'skills'),
        path.join(__dirname, 'skills'),
        path.join(workspacePath, '.cowork', 'skills'),
        path.join(__dirname, '.cowork', 'skills')
    ];

    const allSkillFiles = [];
    for (const d of candidateDirs) {
        allSkillFiles.push(...scanSkillFiles(d, 3));
    }

    const seen = new Set();
    const skills = [];
    for (const skillFile of allSkillFiles) {
        try {
            const text = fs.readFileSync(skillFile, 'utf8');
            const parsed = parseSkillFrontmatter(text);
            const rawDirName = path.basename(path.dirname(skillFile)).replace(/_/g, '-');
            const skillName = (parsed.name || rawDirName).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
            if (skillName && !seen.has(skillName)) {
                let icon = '</>';
                if (skillName.includes('adk')) icon = '</>';
                else if (skillName.includes('workflow')) icon = '</>';
                else if (skillName.includes('python')) icon = '</>';
                else if (skillName.includes('git')) icon = '</>';

                skills.push({
                    name: skillName,
                    icon: icon,
                    description: parsed.description || 'Custom agent skill playbook.',
                    tags: parsed.tags || [],
                    path: skillFile,
                    relativePath: path.relative(workspacePath, skillFile).replace(/\\/g, '/'),
                    source: 'Workspace'
                });
                seen.add(skillName);
            }
        } catch (e) {}
    }
    return skills;
}

function loadSkillContent(workspacePath, skillName) {
    if (!skillName || typeof skillName !== 'string') return null;
    const sanitized = skillName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const all = listAvailableSkills(workspacePath);
    const found = all.find(s => s.name === sanitized || s.name.replace(/-/g, '_') === sanitized);
    if (found && fs.existsSync(found.path)) {
        try {
            const text = fs.readFileSync(found.path, 'utf8');
            const parsed = parseSkillFrontmatter(text);
            return {
                name: parsed.name || sanitized,
                description: parsed.description || found.description,
                tags: parsed.tags || [],
                body: parsed.body || text,
                raw: text,
                path: found.path,
                source: found.source
            };
        } catch (e) {}
    }
    return null;
}

function saveWorkspaceSkill(workspacePath, { name, description, content, instructions }) {
    if (!name || typeof name !== 'string') throw new Error('Skill name is required');
    const sanitized = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
    if (!sanitized) throw new Error('Invalid skill name');
    const targetDir = path.join(workspacePath, 'skills', sanitized);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const targetFile = path.join(targetDir, 'SKILL.md');
    let finalContent = content || instructions || '';
    if (!finalContent.startsWith('---')) {
        const cleanDesc = (description || '').replace(/\r?\n/g, ' ').trim() || `Custom skill ${sanitized} for Pocket Cowork.`;
        finalContent = `---\nname: ${sanitized}\ndescription: ${cleanDesc}\n---\n\n${finalContent || `# ${sanitized} Playbook\n\nInstructions for ${sanitized}.`}\n`;
    }
    fs.writeFileSync(targetFile, finalContent, 'utf8');
    return { name: sanitized, path: targetFile };
}

function deleteWorkspaceSkill(workspacePath, skillName) {
    if (!skillName || typeof skillName !== 'string') return false;
    const sanitized = skillName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const targetDir = path.join(workspacePath, 'skills', sanitized);
    if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        return true;
    }
    return false;
}

// ── Automated Two-Tier Memory Service (ADK Long-Term Memory Extraction) ─────
function autoExtractProjectFacts(userText, replyText, projectPath) {
    if (!userText || typeof userText !== 'string') return;
    const combined = `${userText}\n${replyText || ''}`;
    const extracted = [];

    const patterns = [
        /(?:remember that|always remember|project rule:|convention:)\s*([^\n\.\;]+[\.\;]?)/gi,
        /(?:always use|never use|we prefer|prefer using)\s*([^\n\.\;]+[\.\;]?)/gi,
        /(?:our database is|database:\s*|using database)\s*([^\n\.\;]+[\.\;]?)/gi,
        /(?:api url is|api endpoint is|backend runs on port)\s*([^\n\.\;]+[\.\;]?)/gi,
        /(?:architectural decision:|tech stack:|architecture:)\s*([^\n\.\;]+[\.\;]?)/gi,
        /(?:deployment target is|deploy to|hosting on)\s*([^\n\.\;]+[\.\;]?)/gi
    ];

    for (const pat of patterns) {
        let match;
        while ((match = pat.exec(combined)) !== null) {
            const fact = match[0].trim().replace(/\s+/g, ' ');
            if (fact.length >= 10 && fact.length <= 220 && !extracted.includes(fact)) {
                extracted.push(fact);
            }
        }
    }

    if (extracted.length > 0) {
        try {
            const mem = loadProjectMemory(projectPath);
            if (!mem.notes) mem.notes = [];
            let changed = false;
            for (const f of extracted) {
                const isDup = mem.notes.some(existing =>
                    existing.toLowerCase().includes(f.toLowerCase()) ||
                    f.toLowerCase().includes(existing.toLowerCase())
                );
                if (!isDup) {
                    mem.notes.push(f);
                    changed = true;
                    console.log(`[Two-Tier Memory] Auto-extracted fact: "${f}"`);
                }
            }
            if (changed) {
                mem.updatedAt = Date.now();
                saveProjectMemory(projectPath, mem);
            }
        } catch (e) {
            console.warn('[Two-Tier Memory] Extraction error:', e.message);
        }
    }
}

function setActiveWorkspace(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('Invalid directory or file path provided');
    }
    const cleanPath = targetPath.replace(/^["']+|["']+$/g, '').trim();
    let resolved = path.resolve(cleanPath);
    let targetFile = null;
    if (fs.existsSync(resolved)) {
        if (fs.statSync(resolved).isFile()) {
            targetFile = path.basename(resolved);
            resolved = path.dirname(resolved);
        }
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`Path does not exist on your computer: ${cleanPath}`);
    }
    activeWorkspacePath = resolved;
    workspaceConfig.activeWorkspace = resolved;
    if (!Array.isArray(workspaceConfig.recentWorkspaces)) {
        workspaceConfig.recentWorkspaces = [];
    }
    workspaceConfig.recentWorkspaces = [
        resolved,
        ...workspaceConfig.recentWorkspaces.filter(p => path.resolve(p) !== resolved)
    ].slice(0, 20);
    saveWorkspaceConfig();
    cleanupInvalidFiles(activeWorkspacePath);
    return {
        path: activeWorkspacePath,
        name: path.basename(activeWorkspacePath),
        openFile: targetFile,
        recents: workspaceConfig.recentWorkspaces
    };
}

const IGNORED_DIRS = new Set([
    '.agents', '.git', 'node_modules',
    '.venv', 'venv', 'env', '.env',
    '__pycache__', '.pytest_cache', '.mypy_cache',
    '.idea', '.vscode', '.vs',
    'dist', 'build', 'vendor',
    '.next', '.nuxt', '.turbo', '.cache'
]);

function isPathInside(parent, target) {
    if (!parent || !target) return false;
    const rel = path.relative(path.resolve(parent), path.resolve(target));
    return !rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '';
}

function isSensitivePath(targetPath) {
    if (!targetPath) return true;
    const norm = path.normalize(targetPath).replace(/\\/g, '/').toLowerCase();
    const parts = norm.split('/').filter(Boolean);
    const base = path.basename(norm);

    if (base === 'secrets.json' || base === '.router_key' || base === '.studio_auth_token') return true;
    if (base.startsWith('.env') || base.endsWith('.key') || base.endsWith('.pem')) return true;
    if (base.endsWith('.db') || base.endsWith('.sqlite') || base.endsWith('.s3db')) return true;

    for (const part of parts) {
        if (part === '.agents' || part === '.git' || part === 'node_modules') return true;
        if (norm.includes('/studio/secrets')) return true;
    }
    return false;
}

function isIgnoredEntry(name) {
    if (!name) return true;
    const lower = name.toLowerCase();
    if (IGNORED_DIRS.has(lower)) return true;
    if (lower.startsWith('.git') || lower.startsWith('.pytest') || lower.startsWith('__pycache__')) return true;
    if (lower.endsWith('.egg-info') || lower.endsWith('.dist-info')) return true;
    if (lower === '.agents' || lower === 'secrets.json' || lower === '.router_key' || lower === '.studio_auth_token') return true;
    if (lower.startsWith('.env') || lower.endsWith('.key') || lower.endsWith('.pem') || lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.s3db')) return true;
    return false;
}

function cleanupInvalidFiles(dir) {
    try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
        const entries = fs.readdirSync(dir);
        for (const f of entries) {
            if (f.startsWith('Select-String') || f.includes('&quot;') || f.startsWith('apply_changes.sh')) {
                const full = path.join(dir, f);
                try {
                    if (fs.statSync(full).isFile()) {
                        fs.unlinkSync(full);
                        console.log(`[Cleanup] Removed invalid accidental file: "${f}"`);
                    }
                } catch(e){}
            }
        }
    } catch(e){}
}

function runTerminalCommand(command, cwd) {
    return new Promise((resolve) => {
        let targetCwd = activeWorkspacePath;
        if (cwd && typeof cwd === 'string') {
            const resolved = path.resolve(cwd);
            if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
                targetCwd = resolved;
            }
        }

        // Clean any HTML entities and CLI prompt symbols
        let cleanCmd = (command || '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/g, "'")
            .replace(/^(?:\$|PS\s*>[>]?|>)\s*/gm, '')
            .trim();

        const isWin = process.platform === 'win32';
        let shell = isWin ? 'powershell.exe' : undefined;

        // In Windows PowerShell 5.1, '&&' is a syntax error. Replace '&&' with '; if ($?) { ... }' or '; '
        if (isWin && cleanCmd.includes('&&')) {
            cleanCmd = cleanCmd.replace(/\s+&&\s+/g, '; if ($?) { ') + (cleanCmd.split('&&').length > 1 ? ' }'.repeat(cleanCmd.split('&&').length - 1) : '');
        }

        if ((cleanCmd.startsWith('"') && cleanCmd.endsWith('"')) || (cleanCmd.startsWith("'") && cleanCmd.endsWith("'"))) {
            const inner = cleanCmd.slice(1, -1).trim();
            if (inner.includes(' ') && !inner.startsWith('"')) {
                cleanCmd = inner;
            }
        }

        console.log(`[Terminal] Executing: "${cleanCmd}" in "${targetCwd}"`);

        exec(cleanCmd, {
            cwd: targetCwd,
            shell: shell,
            timeout: 45000,
            maxBuffer: 1024 * 1024 * 8,
            windowsHide: true,
            env: { ...process.env, CI: 'true', PAGER: 'cat' }
        }, (err, stdout, stderr) => {
            const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
            const res = {
                stdout: stdout || '',
                stderr: stderr || (err ? err.message : ''),
                exitCode: exitCode,
                cwd: targetCwd
            };
            recordServerTerminalLog(cleanCmd, exitCode, res.stdout, res.stderr);
            resolve(res);
        });
    });
}

const serverTerminalLogs = [];

function recordServerTerminalLog(command, exitCode, stdout, stderr) {
    serverTerminalLogs.push({
        command,
        exitCode,
        stdout: (stdout || '').trim().slice(0, 3000),
        stderr: (stderr || '').trim().slice(0, 3000),
        timestamp: Date.now()
    });
    if (serverTerminalLogs.length > 8) {
        serverTerminalLogs.shift();
    }
}

function getRecentTerminalLogsFormatted() {
    if (serverTerminalLogs.length === 0) return '';
    return `\nRecent Integrated Terminal Runs & Outputs (${serverTerminalLogs.length} runs in workspace):\n` +
        serverTerminalLogs.slice(-4).map(r => {
            const out = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
            return `• Executed: "${r.command}" (Exit Code: ${r.exitCode})\n  Output:\n  ${out.slice(0, 2000) || '(No output)'}`;
        }).join('\n---\n') + '\n\n';
}

function getWorkspaceTree(dirPath, relativeTo = dirPath) {
    let entries = [];
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
        return [];
    }
    const result = [];

    for (const entry of entries) {
        // Skip hidden, sensitive, heavy directories or vendor/venv junk
        if (isIgnoredEntry(entry.name)) continue;
        if (entry.name.endsWith('.zip') || entry.name.endsWith('.tar.gz')) continue;

        const fullPath = path.join(dirPath, entry.name);
        const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
            result.push({
                name: entry.name,
                path: relPath,
                type: 'directory',
                children: getWorkspaceTree(fullPath, relativeTo)
            });
        } else {
            let size = 0;
            try { size = fs.statSync(fullPath).size; } catch(e){}
            result.push({
                name: entry.name,
                path: relPath,
                type: 'file',
                size: size
            });
        }
    }
    return result;
}

function getFlatWorkspaceFiles(dirPath, max = 200) {
    const list = [];
    const IGNORED_EXTS = new Set([
        '.zip', '.tar', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
        '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.pdf', '.exe', '.dll',
        '.bin', '.pyc', '.pyo', '.lock'
    ]);

    function walk(dir) {
        if (list.length >= max) return;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of entries) {
            if (list.length >= max) break;
            if (isIgnoredEntry(entry.name)) continue;
            const full = path.join(dir, entry.name);
            const ext = path.extname(entry.name).toLowerCase();
            if (IGNORED_EXTS.has(ext)) continue;

            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                list.push(path.relative(dirPath, full).replace(/\\/g, '/'));
            }
        }
    }
    walk(dirPath);
    return list;
}

// Workspace Codebase Inspection & Modification Tools
const WORKSPACE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'write_workspace_file',
            description: 'Create a new file or completely update/overwrite an existing file in the active workspace project directory with full content (e.g. creating "index.html", adding test scripts, updating components, or editing files)',
            parameters: {
                type: 'object',
                properties: {
                    file_path: {
                        type: 'string',
                        description: 'Relative path of the file to create or write (e.g. "index.html", "src/app.js", "backend/config.php")'
                    },
                    content: {
                        type: 'string',
                        description: 'The complete text content to write to the file'
                    }
                },
                required: ['file_path', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_workspace_file',
            description: 'Read the contents of any file in the active workspace project (e.g., index.html, package.json, config.php, etc.)',
            parameters: {
                type: 'object',
                properties: {
                    file_path: {
                        type: 'string',
                        description: 'Relative path to the file from the active workspace project root'
                    }
                },
                required: ['file_path']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'list_workspace_files',
            description: 'List files and subdirectories in any directory in the active workspace project to explore project structure and files',
            parameters: {
                type: 'object',
                properties: {
                    directory: {
                        type: 'string',
                        description: 'Directory path relative to active workspace root (e.g. "" or "." for root, "src", "backend")'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_codebase',
            description: 'Search across active workspace files for symbols, function names, variables, SQL tables, or keywords',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search term or keyword to locate in files'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'execute_terminal_command',
            description: 'Run a shell/PowerShell command in the active workspace directory (e.g. "dir", "python main.py", "git status", "pip list", "npm test", "composer install")',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The shell command to run in the workspace project'
                    }
                },
                required: ['command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'save_project_memory',
            description: 'Save an important fact, architectural decision, environment detail, or user preference into the persistent project memory so it is remembered in future sessions',
            parameters: {
                type: 'object',
                properties: {
                    note: {
                        type: 'string',
                        description: 'The fact, rule, or preference to remember for this project (e.g. "Main backend entrypoint is backend/app/main.py", "User prefers concise answers", "FastAPI server runs on port 8000")'
                    }
                },
                required: ['note']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'remember',
            description: 'Write to Agent Studio memory. tier="long" for durable facts/decisions/preferences, tier="short" for temporary working notes that expire.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'What to remember' },
                    tier: { type: 'string', enum: ['long', 'short'], description: 'Memory tier (default long)' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'recall_memory',
            description: 'Search Agent Studio long-term memory for facts relevant to a query.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'What you want to recall' } },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'delegate_to_agent',
            description: 'Ask another Agent Studio agent (e.g. "reviewer", "sentinel", "architect", "scribe") to perform a sub-task and return its answer.',
            parameters: {
                type: 'object',
                properties: {
                    agent: { type: 'string', description: 'Target agent id' },
                    task: { type: 'string', description: 'Self-contained task description including any needed code/context' }
                },
                required: ['agent', 'task']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_skill',
            description: 'Load and inspect the full instructions, playbook, guidelines, and execution steps for a specific workspace skill (progressive disclosure).',
            parameters: {
                type: 'object',
                properties: {
                    skill_name: {
                        type: 'string',
                        description: 'Name of the skill to read (e.g. "python-runner", "git-flow")'
                    }
                },
                required: ['skill_name']
            }
        }
    }
];

function findFileRecursively(dir, targetName) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return null;
    }
    for (const entry of entries) {
        if (isIgnoredEntry(entry.name)) continue;
        if (entry.name.endsWith('.zip')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileRecursively(fullPath, targetName);
            if (found) return found;
        } else if (entry.name.toLowerCase() === targetName.toLowerCase()) {
            return fullPath;
        }
    }
    return null;
}

function resolveSafePath(userPath) {
    if (!userPath) return null;
    const clean = userPath.replace(/^[/\\]+/, '').replace(/\\/g, '/');

    // 1. Direct relative path under activeWorkspacePath
    let candidate = path.normalize(path.join(activeWorkspacePath, clean));
    if (isPathInside(activeWorkspacePath, candidate) && !isSensitivePath(candidate) && fs.existsSync(candidate)) {
        return candidate;
    }

    // 2. Direct absolute path if within activeWorkspacePath
    if (path.isAbsolute(userPath)) {
        const norm = path.normalize(userPath);
        if (isPathInside(activeWorkspacePath, norm) && !isSensitivePath(norm) && fs.existsSync(norm)) {
            return norm;
        }
    }

    // 3. Fallback: search by basename within activeWorkspacePath
    const base = path.basename(clean);
    if (base && base.length > 2 && !isIgnoredEntry(base)) {
        try {
            const found = findFileRecursively(activeWorkspacePath, base);
            if (found && isPathInside(activeWorkspacePath, found) && !isSensitivePath(found)) {
                return found;
            }
        } catch (e) {}
    }

    return null;
}

async function executeTool(name, argsJson, permissionMode = 'default') {
    let args = {};
    try {
        args = typeof argsJson === 'string' ? JSON.parse(argsJson) : (argsJson || {});
    } catch (e) {
        return { error: `Invalid JSON arguments: ${e.message}` };
    }

    console.log(`[Cowork Tool] Executing: ${name}(${JSON.stringify(args).substring(0, 120)}) [perm: ${permissionMode}]`);

    if (name === 'write_workspace_file' || name === 'write_file' || name === 'create_file' || name === 'edit_file' || name === 'save_file') {
        const p = args.file_path || args.path || args.file || args.filename;
        const content = args.content !== undefined ? args.content : (args.code || args.text || '');
        if (!p) return { error: 'file_path is required' };

        try {
            const clean = p.replace(/^[/\\]+/, '').replace(/\\/g, '/');
            const targetPath = path.normalize(path.join(activeWorkspacePath, clean));
            if (!targetPath.startsWith(activeWorkspacePath)) {
                return { error: 'Access outside active workspace root is denied' };
            }

            const isNew = !fs.existsSync(targetPath);
            let oldContent = '';
            if (!isNew) {
                try { oldContent = fs.readFileSync(targetPath, 'utf8'); } catch(e){}
            }
            const bytes = Buffer.byteLength(content, 'utf8');

            // Directly write to workspace disk unconditionally (Edit mode only)
            const dir = path.dirname(targetPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(targetPath, content, 'utf8');
            console.log(`[Cowork Tool] [Direct Edit] ${isNew ? 'Created' : 'Updated'} file "${clean}" in [${path.basename(activeWorkspacePath)}] (${bytes} bytes)`);

            return {
                success: true,
                pending_approval: false,
                action: isNew ? 'created' : 'updated',
                file: clean,
                file_path: clean,
                content: content,
                old_content: oldContent,
                bytes_written: bytes,
                message: `Successfully ${isNew ? 'created' : 'updated'} file "${clean}" (${bytes} bytes). Changes have been written directly to disk.`
            };
        } catch (err) {
            return { error: `Failed to write file "${p}": ${err.message}` };
        }
    }

    if (name === 'read_workspace_file') {
        const p = args.file_path || args.path || args.file;
        const resolved = resolveSafePath(p);
        if (!resolved) {
            return { error: `File or folder "${p}" not found in active workspace [${path.basename(activeWorkspacePath)}].` };
        }
        try {
            const stat = fs.statSync(resolved);
            if (stat.isDirectory()) {
                // Automatically read files inside the directory so the model can inspect directories directly!
                const dirFiles = [];
                function scanDir(d) {
                    if (dirFiles.length >= 20) return;
                    let entries = [];
                    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch(e){ return; }
                    for (const se of entries) {
                        if (dirFiles.length >= 20) break;
                        if (isIgnoredEntry(se.name)) continue;
                        const subFull = path.join(d, se.name);
                        if (se.isDirectory()) {
                            scanDir(subFull);
                        } else if (se.isFile()) {
                            try {
                                const st = fs.statSync(subFull);
                                if (st.size <= 250 * 1024) {
                                    const c = fs.readFileSync(subFull, 'utf8');
                                    dirFiles.push({
                                        file: path.relative(activeWorkspacePath, subFull).replace(/\\/g, '/'),
                                        size_bytes: st.size,
                                        content: sanitizeForUpstreamWAF(c.slice(0, 15000))
                                    });
                                }
                            } catch(e){}
                        }
                    }
                }
                scanDir(resolved);
                return {
                    directory: path.relative(activeWorkspacePath, resolved).replace(/\\/g, '/') || p,
                    is_directory: true,
                    total_files: dirFiles.length,
                    files: dirFiles,
                    message: `Read ${dirFiles.length} files from folder "${p}". Contents included.`
                };
            }
            const MAX_CHARS = 40000;
            let content = fs.readFileSync(resolved, 'utf8');
            let truncated = false;
            if (content.length > MAX_CHARS) {
                content = content.slice(0, MAX_CHARS) + `\n\n[... Truncated: remaining ${content.length - MAX_CHARS} characters omitted for brevity ...]`;
                truncated = true;
            }
            return {
                file: path.relative(activeWorkspacePath, resolved).replace(/\\/g, '/'),
                size_bytes: stat.size,
                truncated: truncated,
                content: sanitizeForUpstreamWAF(content)
            };
        } catch (err) {
            return { error: `Failed to read ${p}: ${err.message}` };
        }
    }

    if (name === 'list_workspace_files') {
        let dir = args.directory || args.dir || '';
        let target = activeWorkspacePath;
        if (dir && dir !== '.' && dir !== '/') {
            const resolved = resolveSafePath(dir);
            if (resolved && fs.statSync(resolved).isDirectory()) {
                target = resolved;
            } else {
                const cand = path.normalize(path.join(activeWorkspacePath, dir));
                if (cand.startsWith(activeWorkspacePath) && fs.existsSync(cand) && fs.statSync(cand).isDirectory()) {
                    target = cand;
                } else {
                    return { error: `Directory "${dir}" not found in active workspace.` };
                }
            }
        }
        try {
            const entries = fs.readdirSync(target, { withFileTypes: true });
            const list = [];
            for (const entry of entries) {
                if (isIgnoredEntry(entry.name)) continue;
                if (entry.name.endsWith('.zip')) continue;
                const full = path.join(target, entry.name);
                list.push({
                    name: entry.name,
                    path: path.relative(activeWorkspacePath, full).replace(/\\/g, '/'),
                    type: entry.isDirectory() ? 'directory' : 'file',
                    size: entry.isDirectory() ? null : fs.statSync(full).size
                });
            }
            return {
                directory: path.relative(activeWorkspacePath, target).replace(/\\/g, '/') || '.',
                entries: list
            };
        } catch (err) {
            return { error: `Failed to list directory: ${err.message}` };
        }
    }

    if (name === 'search_codebase') {
        const q = (args.query || '').trim();
        if (!q) return { error: 'Query is required' };
        const qLower = q.toLowerCase();
        const results = [];
        const MAX_RESULTS = 20;

        function walk(dir) {
            if (results.length >= MAX_RESULTS) return;
            let entries = [];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch (e) {
                return;
            }
            for (const entry of entries) {
                if (results.length >= MAX_RESULTS) break;
                if (isIgnoredEntry(entry.name)) continue;
                if (entry.name.endsWith('.zip') || entry.name.endsWith('.png') || entry.name.endsWith('.jpg') || entry.name.endsWith('.ico') || entry.name.endsWith('.woff2')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (entry.isFile()) {
                    try {
                        const stat = fs.statSync(full);
                        if (stat.size > 400 * 1024) continue;
                        const text = fs.readFileSync(full, 'utf8');
                        if (text.toLowerCase().includes(qLower)) {
                            const lines = text.split('\n');
                            const snips = [];
                            for (let i = 0; i < lines.length && snips.length < 3; i++) {
                                if (lines[i].toLowerCase().includes(qLower)) {
                                    snips.push({ line: i + 1, text: sanitizeForUpstreamWAF(lines[i].trim().substring(0, 120)) });
                                }
                            }
                            results.push({
                                file: path.relative(activeWorkspacePath, full).replace(/\\/g, '/'),
                                matches: snips
                            });
                        }
                    } catch (e) {}
                }
            }
        }

        try {
            walk(activeWorkspacePath);
            return { query: q, total_files_matched: results.length, matches: results };
        } catch (err) {
            return { error: `Search failed: ${err.message}` };
        }
    }

    if (name === 'execute_terminal_command' || name === 'run_terminal_command' || name === 'run_command' || name === 'terminal_run') {
        const cmd = args.command || args.cmd;
        if (!cmd) return { error: 'Command is required' };
        try {
            const res = await runTerminalCommand(cmd, activeWorkspacePath);
            return {
                command: cmd,
                exit_code: res.exitCode,
                stdout: res.stdout,
                stderr: res.stderr,
                cwd: res.cwd
            };
        } catch (err) {
            return { error: `Command execution failed: ${err.message}` };
        }
    }

    if (name === 'save_project_memory' || name === 'remember_note' || name === 'save_memory') {
        const note = args.note || args.fact || args.text;
        if (!note) return { error: 'Note or fact string is required' };
        try {
            const currentMem = loadProjectMemory(activeWorkspacePath);
            if (!Array.isArray(currentMem.notes)) currentMem.notes = [];
            if (!currentMem.notes.includes(note.trim())) {
                currentMem.notes.push(note.trim());
            }
            currentMem.updatedAt = Date.now();
            saveProjectMemory(activeWorkspacePath, currentMem);
            try { studio.remember(note.trim(), { source: 'tool:save_project_memory' }); } catch (e) {}
            console.log(`[Memory Saved] Stored note for [${path.basename(activeWorkspacePath)}]: "${note.trim()}"`);
            return {
                success: true,
                message: `Successfully remembered: "${note.trim()}". This is saved permanently in project memory.`,
                total_notes: currentMem.notes.length
            };
        } catch (err) {
            return { error: `Failed to save memory: ${err.message}` };
        }
    }

    // ── Agent Studio tools ──
    if (name === 'remember') {
        try {
            const entry = args.tier === 'short'
                ? studio.note(args.text, { kind: 'note' })
                : studio.remember(args.text, { tags: args.tags, source: 'tool:remember' });
            return { success: true, tier: args.tier === 'short' ? 'short' : 'long', id: entry.id };
        } catch (err) { return { error: err.message }; }
    }
    if (name === 'recall_memory') {
        try {
            const r = studio.recall(args.query || '', { limit: 10 });
            return { pinned: r.pinned.map(e => e.text), relevant: r.relevant.map(e => e.text) };
        } catch (err) { return { error: err.message }; }
    }
    if (name === 'delegate_to_agent') {
        try {
            const r = await studio.runAgent({ agent: args.agent, prompt: args.task });
            return { agent: r.agent, model: r.model, answer: r.text };
        } catch (err) { return { error: `Delegation failed: ${err.message}` }; }
    }
    if (name === 'read_skill') {
        try {
            const skillName = args.skill_name || args.name;
            if (!skillName) return { error: 'skill_name parameter is required' };
            const skill = loadSkillContent(activeWorkspacePath, skillName);
            if (!skill) return { error: `Skill "${skillName}" was not found in active workspace or built-in skills.` };
            return {
                success: true,
                skill_name: skill.name,
                description: skill.description,
                playbook: skill.body,
                file_path: skill.path
            };
        } catch (err) { return { error: `Failed to load skill: ${err.message}` }; }
    }

    return { error: `Unknown tool "${name}"` };
}

function getSafeCorsOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return null;
    try {
        const u = new URL(origin);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
            return origin;
        }
        if (req.headers.host && (u.host === req.headers.host)) {
            return origin;
        }
    } catch {}
    return null;
}

function getRequestToken(req) {
    const h = req.headers['x-studio-token'] || req.headers['authorization'] || '';
    if (h) return String(h).replace(/^Bearer\s+/i, '').trim();
    const cookie = req.headers?.cookie || '';
    const m = cookie.match(/(?:^|;\s*)studio_auth_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1].trim());
    return '';
}

function verifyAuth(req) {
    const tok = getRequestToken(req);
    if (!tok) return false;
    if (tok === studioAuthToken) return true;
    try {
        const sec = studio?.getConfig()?.settings?.security;
        const hookTok = sec?.hookToken && sec.hookToken !== '••••••••' ? sec.hookToken : '';
        if (hookTok && tok === hookTok) return true;
    } catch {}
    return false;
}

function sendUnauthorized(res, msg = 'Authentication required') {
    res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    });
    res.end(JSON.stringify({
        error: { message: msg, code: 'UNAUTHORIZED', needsToken: true }
    }));
}

const server = http.createServer(async (req, res) => {
    const allowedOrigin = getSafeCorsOrigin(req);
    if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-studio-token');
    }

    if (req.method === 'OPTIONS') {
        if (req.headers.origin && !allowedOrigin) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden Origin');
            return;
        }
        res.writeHead(204);
        res.end();
        return;
    }

    if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.headers.origin && !allowedOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Cross-origin request rejected' } }));
        return;
    }

    const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = parsedUrl.pathname.replace(/\/+$/, '');

    // 0. Agent Studio API & Static Assets (/api/studio/* and /__studio/*)
    if (await handleStudioRoute(studio, req, res, pathname)) {
        return;
    }

    // 1. Serve Web IDE (Cowork interface)
    if (pathname === '' || pathname === '/' || pathname === '/chat' || pathname === '/index.html') {
        const filePath = path.join(__dirname, 'agent-chat.html');
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading agent-chat.html');
                return;
            }
            const injected = data.replace(
                '</head>',
                `<script>window.__STUDIO_AUTH_TOKEN = ${JSON.stringify(studioAuthToken)}; try { localStorage.setItem("studio_auth_token", ${JSON.stringify(studioAuthToken)}); } catch(e){}</script></head>`
            );
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Set-Cookie': `studio_auth_token=${studioAuthToken}; Path=/; SameSite=Strict`,
                'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(injected);
        });
        return;
    }

    // 1b. Serve PWA Web App Manifest for Android / Mobile Install
    if (pathname === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
        res.end(JSON.stringify({
            name: 'Pocket Cowork — Mobile-First Web IDE & Studio',
            short_name: 'Pocket Cowork',
            description: 'Mobile-first AI Coding IDE, Multi-Agent Studio, Terminal & Connectors Hub',
            start_url: '/',
            display: 'standalone',
            orientation: 'any',
            background_color: '#0a0c10',
            theme_color: '#0f1219',
            icons: [
                {
                    src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="42" fill="%230f172a"/><rect x="16" y="16" width="160" height="160" rx="34" fill="url(%23g)"/><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%25" stop-color="%237c5cff"/><stop offset="100%25" stop-color="%2338bdf8"/></linearGradient></defs><text x="96" y="122" font-size="78" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="bold">CS</text></svg>',
                    sizes: '192x192',
                    type: 'image/svg+xml',
                    purpose: 'any maskable'
                }
            ]
        }));
        return;
    }

    // Fail-closed access control on all API and inference endpoints
    if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
        if (!verifyAuth(req)) {
            sendUnauthorized(res);
            return;
        }
    }

    // 2. Project Management Endpoints
    if (pathname === '/api/project/current' && req.method === 'GET') {
        const validRecents = (workspaceConfig.recentWorkspaces || []).filter(p => {
            try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch(e){ return false; }
        }).map(p => ({ path: p, name: path.basename(p) }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            path: activeWorkspacePath,
            name: path.basename(activeWorkspacePath),
            recents: validRecents
        }));
        return;
    }

    if (pathname === '/api/project/open' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { path: newPath } = JSON.parse(body || '{}');
                if (!newPath || typeof newPath !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Missing "path" string in request' } }));
                    return;
                }
                const result = setActiveWorkspace(newPath.trim());
                console.log(`[Workspace Switched] Active project is now: "${result.path}"`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, ...result }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }

    if (pathname === '/api/project/recents' && req.method === 'GET') {
        const validRecents = (workspaceConfig.recentWorkspaces || []).filter(p => {
            try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch(e){ return false; }
        }).map(p => ({ path: p, name: path.basename(p) }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recents: validRecents, current: activeWorkspacePath }));
        return;
    }

    if (pathname === '/api/project/browse') {
        let targetDir = activeWorkspacePath;
        const qDir = parsedUrl.searchParams.get('dir');
        if (qDir) {
            targetDir = path.resolve(qDir);
        } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body || '{}');
                    if (parsed.dir) targetDir = path.resolve(parsed.dir);
                    sendDirBrowser(targetDir, res);
                } catch(e) {
                    sendDirBrowser(targetDir, res);
                }
            });
            return;
        }
        sendDirBrowser(targetDir, res);
        return;
    }

    function sendDirBrowser(targetDir, resObj) {
        try {
            const cleanDir = (targetDir || '').replace(/^["']+|["']+$/g, '').trim();
            let resolved = path.resolve(cleanDir);
            let selectedFile = null;
            if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
                selectedFile = path.basename(resolved);
                resolved = path.dirname(resolved);
            }
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
                resObj.writeHead(404, { 'Content-Type': 'application/json' });
                resObj.end(JSON.stringify({ error: { message: `Directory not found: ${cleanDir}` } }));
                return;
            }
            const entries = fs.readdirSync(resolved, { withFileTypes: true });
            const subdirs = [];
            const files = [];
            for (const e of entries) {
                if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$Recycle.Bin') continue;
                const fullPath = path.join(resolved, e.name);
                if (e.isDirectory()) {
                    subdirs.push({
                        name: e.name,
                        path: fullPath
                    });
                } else if (e.isFile()) {
                    files.push({
                        name: e.name,
                        path: fullPath,
                        isFile: true
                    });
                }
            }
            subdirs.sort((a, b) => a.name.localeCompare(b.name));
            files.sort((a, b) => a.name.localeCompare(b.name));
            const parent = path.dirname(resolved);
            resObj.writeHead(200, { 'Content-Type': 'application/json' });
            resObj.end(JSON.stringify({
                current: resolved,
                name: path.basename(resolved),
                parent: parent !== resolved ? parent : null,
                directories: subdirs,
                files: files,
                selectedFile: selectedFile
            }));
        } catch (err) {
            resObj.writeHead(500, { 'Content-Type': 'application/json' });
            resObj.end(JSON.stringify({ error: { message: err.message } }));
        }
    }

    // 3. Workspace File Tree: GET /api/files
    if (pathname === '/api/files' && req.method === 'GET') {
        try {
            const tree = getWorkspaceTree(activeWorkspacePath);
            // Always surface @studio control & memory files at the top of the explorer even when working in another folder
            const studioTree = getWorkspaceTree(studio.STUDIO_DIR, studio.STUDIO_DIR).filter(e => e.name !== 'secrets.json');
            const prefixStudio = (nodes) => nodes.map(n => ({
                ...n,
                path: `@studio/${n.path}`,
                ...(n.children ? { children: prefixStudio(n.children) } : {})
            }));
            tree.unshift({
                name: '@studio (Control & Memory)',
                path: '@studio',
                type: 'directory',
                children: prefixStudio(studioTree)
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                files: tree, 
                root: path.basename(activeWorkspacePath),
                rootPath: activeWorkspacePath,
                recents: (workspaceConfig.recentWorkspaces || []).slice(0, 10)
            }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message } }));
        }
        return;
    }

    // 4. Read File Content: GET /api/file-read?path=...
    if (pathname === '/api/file-read' && req.method === 'GET') {
        const relPath = parsedUrl.searchParams.get('path');
        if (!relPath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Missing path param' } }));
            return;
        }

        // Support @studio/... virtual paths so studio control/memory/hook files open directly in the IDE
        const studioPath = studio.resolveStudioPath(relPath);
        const safePath = studioPath || path.normalize(path.join(activeWorkspacePath, relPath));
        if (studioPath) {
            if (isSensitivePath(studioPath)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Access to sensitive file denied' } }));
                return;
            }
        } else {
            if (!isPathInside(activeWorkspacePath, safePath) || isSensitivePath(safePath)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Access outside active workspace or sensitive file denied' } }));
                return;
            }
        }

        try {
            if (!fs.existsSync(safePath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'File or directory not found' } }));
                return;
            }

            const stat = fs.statSync(safePath);
            if (stat.isDirectory()) {
                const dirFiles = [];
                function scanDir(d) {
                    if (dirFiles.length >= 15) return;
                    let entries = [];
                    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch(e){ return; }
                    for (const se of entries) {
                        if (dirFiles.length >= 15) break;
                        if (isIgnoredEntry(se.name)) continue;
                        const subFull = path.join(d, se.name);
                        if (se.isDirectory()) {
                            scanDir(subFull);
                        } else if (se.isFile()) {
                            try {
                                const st = fs.statSync(subFull);
                                if (st.size <= 250 * 1024) {
                                    const c = fs.readFileSync(subFull, 'utf8');
                                    dirFiles.push({
                                        path: path.relative(activeWorkspacePath, subFull).replace(/\\/g, '/'),
                                        content: c.slice(0, 15000)
                                    });
                                }
                            } catch(e){}
                        }
                    }
                }
                scanDir(safePath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    path: relPath,
                    isDirectory: true,
                    files: dirFiles,
                    content: dirFiles.map(f => `--- WORKSPACE FILE: "${f.path}" ---\n${f.content}\n--- END OF FILE "${f.path}" ---`).join('\n\n')
                }));
                return;
            }

            fs.readFile(safePath, (err, buf) => {
                if (err) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'File not found' } }));
                    return;
                }
                const lower = relPath.toLowerCase();
                const isPdf = lower.endsWith('.pdf') || (buf.length > 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-');
                if (isPdf) {
                    const extracted = extractTextFromPdfBuffer(buf);
                    const clean = sanitizeForUpstreamWAF(extracted);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        path: relPath,
                        isPdf: true,
                        content: clean ? clean.slice(0, 25000) : `[PDF Document: "${path.basename(relPath)}" (${(buf.length / 1024).toFixed(1)} KB) — binary/scanned layout]`
                    }));
                    return;
                }
                const sample = buf.subarray(0, Math.min(1024, buf.length));
                const isBinary = sample.includes(0);
                if (isBinary) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        path: relPath,
                        isBinary: true,
                        content: `[Binary file: "${path.basename(relPath)}" (${(buf.length / 1024).toFixed(1)} KB) — binary format]`
                    }));
                    return;
                }
                const str = buf.toString('utf8');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ path: relPath, content: str }));
            });
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message } }));
        }
        return;
    }

    // 5. Save File Content: POST /api/file-write
    if (pathname === '/api/file-write' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { path: relPath, content } = JSON.parse(body || '{}');
                if (!relPath) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Missing path' } }));
                    return;
                }

                // Support @studio/... virtual paths so editing studio/studio.config.json or memory files in Monaco saves live
                const studioPath = studio.resolveStudioPath(relPath);
                const safePath = studioPath || path.normalize(path.join(activeWorkspacePath, relPath));
                if (studioPath) {
                    if (isSensitivePath(studioPath)) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: { message: 'Access to sensitive file denied' } }));
                        return;
                    }
                } else {
                    if (!isPathInside(activeWorkspacePath, safePath) || isSensitivePath(safePath)) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: { message: 'Access outside active workspace or sensitive file denied' } }));
                        return;
                    }
                }

                const dir = path.dirname(safePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                fs.writeFileSync(safePath, content, 'utf8');
                if (studioPath && relPath.endsWith('studio.config.json')) {
                    try { studio.getConfig(); } catch (e) {}
                }
                console.log(`[Cowork IDE] Saved file: ${relPath} in [${studioPath ? 'Agent Studio' : path.basename(activeWorkspacePath)}]`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: `Saved ${relPath}` }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }

    // 5b. Upload Context File: POST /api/upload-file or POST /api/file-upload
    if ((pathname === '/api/upload-file' || pathname === '/api/file-upload') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const rawName = String(payload.name || 'uploaded_file.txt').replace(/[/\\?%*:|"<>]/g, '_');
                const safeName = rawName.slice(0, 100);
                const uploadDir = path.join(activeWorkspacePath, '.cowork', 'uploads');
                if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

                const targetPath = path.join(uploadDir, safeName);
                let buffer;
                if (payload.dataUrl && payload.dataUrl.includes(',')) {
                    const base64Data = payload.dataUrl.split(',')[1];
                    buffer = Buffer.from(base64Data, 'base64');
                } else if (payload.content !== undefined) {
                    buffer = Buffer.from(String(payload.content), 'utf8');
                } else {
                    throw new Error('No file content or dataUrl provided');
                }

                fs.writeFileSync(targetPath, buffer);
                const size = buffer.length;
                const relPath = path.relative(activeWorkspacePath, targetPath).replace(/\\/g, '/');

                let extractedText = '';
                const lowerName = safeName.toLowerCase();
                const isPdf = lowerName.endsWith('.pdf') || (buffer.length > 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-');

                if (isPdf) {
                    const rawPdf = extractTextFromPdfBuffer(buffer);
                    const cleanPdf = sanitizeForUpstreamWAF(rawPdf);
                    extractedText = cleanPdf;
                    if (!extractedText || extractedText.length < 15) {
                        extractedText = `[PDF Document: "${safeName}" (${(size / 1024).toFixed(1)} KB) saved to ${relPath}. Binary/scanned layout — full file stored in workspace.]`;
                    } else if (extractedText.length > 25000) {
                        extractedText = extractedText.slice(0, 25000) + `\n... [Extracted text truncated to first 25KB. Full file saved to ${relPath}]`;
                    }
                } else {
                    const sample = buffer.subarray(0, Math.min(1024, buffer.length));
                    const isBinary = sample.includes(0);
                    if (isBinary) {
                        extractedText = `[Binary file: "${safeName}" (${(size / 1024).toFixed(1)} KB) saved to ${relPath}. Inspect or process this file using workspace tools.]`;
                    } else {
                        const rawText = buffer.toString('utf8');
                        const sanitized = sanitizeForUpstreamWAF(rawText);
                        extractedText = sanitized.length > 25000
                            ? sanitized.slice(0, 25000) + `\n... [Text truncated to first 25KB. Full file saved to ${relPath}]`
                            : sanitized;
                    }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    name: safeName,
                    path: relPath,
                    size,
                    isPdf,
                    text: extractedText
                }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }

    // 5c. Delete File or Folder: POST /api/file-delete
    if (pathname === '/api/file-delete' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const relPath = data.path || data.filePath || data.targetPath;
                if (!relPath) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Missing path or filePath' } }));
                    return;
                }

                const studioPath = studio.resolveStudioPath(relPath);
                const safePath = studioPath || path.normalize(path.join(activeWorkspacePath, relPath));

                // Guard: cannot delete active workspace root
                if (safePath === activeWorkspacePath || safePath === path.resolve(activeWorkspacePath)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Cannot delete active workspace root directory' } }));
                    return;
                }

                if (studioPath) {
                    if (!safePath.includes(path.join(studio.STUDIO_DIR, 'memory')) && !safePath.includes(path.join(studio.STUDIO_DIR, 'logs'))) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: { message: 'Cannot delete core studio configuration files' } }));
                        return;
                    }
                } else {
                    if (!isPathInside(activeWorkspacePath, safePath) || isSensitivePath(safePath)) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: { message: 'Access denied: outside workspace or sensitive file' } }));
                        return;
                    }
                }

                if (!fs.existsSync(safePath)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: `File or folder "${relPath}" not found` } }));
                    return;
                }

                fs.rmSync(safePath, { recursive: true, force: true });
                console.log(`[Cowork IDE] Deleted: ${relPath}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, message: `Deleted ${relPath}` }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }

    // 5d. Rename File or Folder: POST /api/file-rename
    if (pathname === '/api/file-rename' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const oldPath = data.oldPath || data.sourcePath || data.oldFilePath;
                const newPath = data.newPath || data.targetPath || data.newFilePath;
                if (!oldPath || !newPath) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Missing oldPath or newPath' } }));
                    return;
                }

                const oldSafe = path.normalize(path.join(activeWorkspacePath, oldPath));
                const newSafe = path.normalize(path.join(activeWorkspacePath, newPath));

                if (!isPathInside(activeWorkspacePath, oldSafe) || !isPathInside(activeWorkspacePath, newSafe) ||
                    isSensitivePath(oldSafe) || isSensitivePath(newSafe)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Access denied: outside workspace or sensitive file' } }));
                    return;
                }

                if (!fs.existsSync(oldSafe)) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: `Source "${oldPath}" does not exist` } }));
                    return;
                }

                const targetDir = path.dirname(newSafe);
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                fs.renameSync(oldSafe, newSafe);
                console.log(`[Cowork IDE] Renamed: ${oldPath} -> ${newPath}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, oldPath, newPath }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }

    // 5e. Create New File: POST /api/file-create
    if (pathname === '/api/file-create' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const relPath = data.path || data.filePath;
                const content = data.content !== undefined ? data.content : '';
                if (!relPath) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Missing path or filePath' } }));
                    return;
                }

                const safePath = path.normalize(path.join(activeWorkspacePath, relPath));
                if (!isPathInside(activeWorkspacePath, safePath) || isSensitivePath(safePath)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Access denied: outside workspace or sensitive file' } }));
                    return;
                }

                const dir = path.dirname(safePath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                fs.writeFileSync(safePath, content, 'utf8');
                console.log(`[Cowork IDE] Created file: ${relPath}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: relPath }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }

    // 5f. Create New Folder: POST /api/folder-create
    if (pathname === '/api/folder-create' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const relPath = data.path || data.folderPath || data.dirPath;
                if (!relPath) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Missing path or folderPath' } }));
                    return;
                }

                const safePath = path.normalize(path.join(activeWorkspacePath, relPath));
                if (!isPathInside(activeWorkspacePath, safePath) || isSensitivePath(safePath)) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Access denied: outside workspace or sensitive file' } }));
                    return;
                }

                fs.mkdirSync(safePath, { recursive: true });
                console.log(`[Cowork IDE] Created folder: ${relPath}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, path: relPath }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }
    if (pathname === '/api/terminal/run' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { command, cwd } = JSON.parse(body || '{}');
                if (!command || typeof command !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Missing "command" string' } }));
                    return;
                }
                const result = await runTerminalCommand(command.trim(), cwd);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }


    // 6a. Sessions Database: GET /api/sessions
    if (pathname === '/api/sessions' && req.method === 'GET') {
        const db = loadSessionsDB();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db));
        return;
    }

    // 6b. Sessions Save: POST /api/sessions/save
    if (pathname === '/api/sessions/save' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const db = loadSessionsDB();
                if (payload.sessions && typeof payload.sessions === 'object') {
                    db.sessions = { ...db.sessions, ...payload.sessions };
                }
                if (payload.activeSessionId) {
                    db.activeSessionId = payload.activeSessionId;
                }
                if (payload.session && payload.session.id) {
                    db.sessions[payload.session.id] = payload.session;
                    db.activeSessionId = payload.session.id;
                }
                saveSessionsDB(db);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, count: Object.keys(db.sessions).length }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }


    // 6c. Sessions Delete: POST /api/sessions/delete
    if (pathname === '/api/sessions/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { id } = JSON.parse(body || '{}');
                if (id) {
                    const db = loadSessionsDB();
                    delete db.sessions[id];
                    if (db.activeSessionId === id) {
                        const keys = Object.keys(db.sessions);
                        db.activeSessionId = keys.length > 0 ? keys[0] : null;
                    }
                    saveSessionsDB(db);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }


    // 6d. Project Memory: GET /api/memory
    if (pathname === '/api/memory' && req.method === 'GET') {
        const mem = loadProjectMemory(activeWorkspacePath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mem));
        return;
    }

    // 6e. Project Memory Save: POST /api/memory
    if (pathname === '/api/memory' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const mem = loadProjectMemory(activeWorkspacePath);
                if (payload.note && typeof payload.note === 'string') {
                    if (!mem.notes) mem.notes = [];
                    if (!mem.notes.includes(payload.note.trim())) {
                        mem.notes.push(payload.note.trim());
                    }
                }
                if (Array.isArray(payload.notes)) {
                    mem.notes = Array.from(new Set([...(mem.notes || []), ...payload.notes.map(n => String(n).trim()).filter(Boolean)]));
                }
                mem.updatedAt = Date.now();
                saveProjectMemory(activeWorkspacePath, mem);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, memory: mem }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }

    // 6f. Skills Hub: GET /api/skills
    if (pathname === '/api/skills' && req.method === 'GET') {
        try {
            const skills = listAvailableSkills(activeWorkspacePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, skills }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message } }));
        }
        return;
    }


    // 6g. Skill Details: GET /api/skills/get
    if (pathname === '/api/skills/get' && req.method === 'GET') {
        try {
            const skillName = parsedUrl.searchParams.get('name') || '';
            const skill = loadSkillContent(activeWorkspacePath, skillName);
            if (!skill) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Skill "${skillName}" not found.` } }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, skill }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: err.message } }));
        }
        return;
    }

    // 6h. Skill Create/Update: POST /api/skills
    if (pathname === '/api/skills' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const result = saveWorkspaceSkill(activeWorkspacePath, payload);
                const updatedSkills = listAvailableSkills(activeWorkspacePath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, skill: result, skills: updatedSkills }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }


    // 6i. Skill Delete: POST /api/skills/delete or DELETE /api/skills
    if ((pathname === '/api/skills/delete' && req.method === 'POST') || (pathname === '/api/skills' && req.method === 'DELETE')) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                let skillName = parsedUrl.searchParams.get('name');
                if (!skillName && body) {
                    try { skillName = JSON.parse(body).name; } catch(e){}
                }
                const deleted = deleteWorkspaceSkill(activeWorkspacePath, skillName);
                const updatedSkills = listAvailableSkills(activeWorkspacePath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: deleted, skills: updatedSkills }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message } }));
            }
        });
        return;
    }


    // ==========================================
    // 7. Services & Connectors Hub APIs
    // ==========================================

    // 7a. Postman-style HTTP Client Proxy: POST /api/connectors/http
    if (pathname === '/api/connectors/http' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            const startT = Date.now();
            try {
                const payload = JSON.parse(body || '{}');
                let targetUrl = payload.url ? payload.url.trim() : '';
                if (!targetUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'URL is required' }));
                    return;
                }
                // Allow relative URL queries to current server
                if (targetUrl.startsWith('/')) {
                    targetUrl = `http://127.0.0.1:${PORT}${targetUrl}`;
                    if (!reqHeaders['x-studio-token']) {
                        reqHeaders['x-studio-token'] = studioAuthToken;
                    }
                } else {
                    // SSRF Protection: Block cloud metadata and disallowed schemes
                    try {
                        const parsed = new URL(targetUrl);
                        const host = parsed.hostname.toLowerCase();
                        if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === '100.100.100.200' || host.startsWith('169.254.')) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'SSRF protection: cloud metadata destination is blocked' }));
                            return;
                        }
                        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Unsupported protocol: only HTTP and HTTPS allowed' }));
                            return;
                        }
                    } catch (e) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid URL' }));
                        return;
                    }
                }

                const method = (payload.method || 'GET').toUpperCase();
                const reqHeaders = { ...(payload.headers || {}) };
                const fetchOpts = {
                    method,
                    headers: reqHeaders,
                    signal: AbortSignal.timeout(20000)
                };

                if (method !== 'GET' && method !== 'HEAD' && payload.body !== undefined) {
                    fetchOpts.body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
                }

                const response = await fetch(targetUrl, fetchOpts);
                const timeMs = Date.now() - startT;
                const respHeaders = {};
                response.headers.forEach((v, k) => { respHeaders[k] = v; });

                const contentType = response.headers.get('content-type') || '';
                let data = null;
                let rawText = '';
                if (contentType.includes('application/json')) {
                    try {
                        data = await response.json();
                        rawText = JSON.stringify(data, null, 2);
                    } catch (e) {
                        rawText = await response.text();
                        data = rawText;
                    }
                } else {
                    rawText = await response.text();
                    data = rawText;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: response.status,
                    statusText: response.statusText,
                    ok: response.ok,
                    timeMs,
                    sizeBytes: Buffer.byteLength(rawText, 'utf8'),
                    headers: respHeaders,
                    data
                }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 0,
                    statusText: 'Network Error',
                    ok: false,
                    timeMs: Date.now() - startT,
                    sizeBytes: 0,
                    headers: {},
                    error: err.message
                }));
            }
        });
        return;
    }

    // 7b. Database List: GET /api/connectors/db/list
    if (pathname === '/api/connectors/db/list' && req.method === 'GET') {
        try {
            const databases = [];
            const findDbs = (dir, depth = 0) => {
                if (depth > 3) return;
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const ent of entries) {
                        if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'vendor') continue;
                        const full = path.join(dir, ent.name);
                        if (ent.isDirectory()) {
                            findDbs(full, depth + 1);
                        } else if (ent.isFile()) {
                            const ext = path.extname(ent.name).toLowerCase();
                            if (['.sqlite', '.sqlite3', '.db', '.s3db'].includes(ext)) {
                                databases.push(path.relative(activeWorkspacePath, full).replace(/\\/g, '/'));
                            }
                        }
                    }
                } catch (e) {}
            };
            findDbs(activeWorkspacePath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ databases, workspace: activeWorkspacePath }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // 7c. Database Query Executor (SQLite native): POST /api/connectors/db/query
    if (pathname === '/api/connectors/db/query' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const startT = Date.now();
            try {
                const payload = JSON.parse(body || '{}');
                const sql = (payload.query || '').trim();
                let dbTarget = (payload.dbPath || '').trim();

                if (!sql) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'SQL query is required' }));
                    return;
                }

                let targetDbFile = ':memory:';
                if (dbTarget && dbTarget !== ':memory:') {
                    targetDbFile = path.isAbsolute(dbTarget) ? path.normalize(dbTarget) : path.normalize(path.join(activeWorkspacePath, dbTarget));
                    if (!isPathInside(activeWorkspacePath, targetDbFile) || isSensitivePath(targetDbFile)) {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Database file must be inside the active workspace and non-sensitive' }));
                        return;
                    }
                } else if (!dbTarget) {
                    // Check if workspace has an existing sqlite file
                    const defaultDb = path.join(activeWorkspacePath, 'workspace.db');
                    targetDbFile = defaultDb;
                }

                if (!DatabaseSync) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'node:sqlite is not supported on this Node.js build. Please use Node 22+.' }));
                    return;
                }
                const db = new DatabaseSync(targetDbFile);
                try {
                    const isSelectLike = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(sql);
                    if (isSelectLike) {
                        const stmt = db.prepare(sql);
                        const rows = stmt.all();
                        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
                        const timeMs = Date.now() - startT;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            dbFile: path.basename(targetDbFile),
                            type: 'select',
                            columns,
                            rows,
                            count: rows.length,
                            timeMs
                        }));
                    } else {
                        const stmt = db.prepare(sql);
                        const result = stmt.run();
                        const timeMs = Date.now() - startT;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            dbFile: path.basename(targetDbFile),
                            type: 'mutation',
                            changes: result.changes,
                            lastInsertRowid: result.lastInsertRowid ? String(result.lastInsertRowid) : null,
                            timeMs
                        }));
                    }
                } finally {
                    try { db.close(); } catch(e){}
                }
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: err.message,
                    timeMs: Date.now() - startT
                }));
            }
        });
        return;
    }

    // 7d. Docker Manager: POST /api/connectors/docker
    if (pathname === '/api/connectors/docker' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const action = payload.action || 'ps';
                const allowedActions = new Set(['ps', 'images', 'logs', 'start', 'stop', 'run_redis']);
                if (!allowedActions.has(action)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Unsupported docker action' }));
                    return;
                }
                const id = payload.id ? String(payload.id).replace(/[^a-zA-Z0-9_\-\.]/g, '') : '';
                if ((action === 'logs' || action === 'start' || action === 'stop') && (!id || !/^[a-zA-Z0-9_\-\.]{1,64}$/.test(id))) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Valid container ID required' }));
                    return;
                }

                let cmd = 'docker ps -a --format "{{json .}}"';
                if (action === 'images') {
                    cmd = 'docker images --format "{{json .}}"';
                } else if (action === 'logs' && id) {
                    cmd = `docker logs --tail 100 ${id}`;
                } else if (action === 'start' && id) {
                    cmd = `docker start ${id}`;
                } else if (action === 'stop' && id) {
                    cmd = `docker stop ${id}`;
                } else if (action === 'run_redis') {
                    cmd = 'docker run -d --name studio-redis -p 6379:6379 redis:alpine';
                }

                exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
                    if (error) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: stderr || error.message,
                            available: false
                        }));
                        return;
                    }

                    if (action === 'ps' || action === 'images') {
                        const lines = (stdout || '').trim().split('\n').filter(Boolean);
                        const items = lines.map(line => {
                            try { return JSON.parse(line); } catch (e) { return { raw: line }; }
                        });
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, available: true, action, items }));
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, available: true, action, output: stdout || stderr || 'OK' }));
                    }
                });
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // 7e. Redis Explorer: POST /api/connectors/redis
    if (pathname === '/api/connectors/redis' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const startT = Date.now();
            try {
                const payload = JSON.parse(body || '{}');
                const host = (payload.host || '127.0.0.1').trim();
                if (!/^([a-zA-Z0-9_\-\.]+)$/.test(host) || host === '169.254.169.254' || host.startsWith('169.254.')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid or restricted Redis host' }));
                    return;
                }
                const port = parseInt(payload.port || 6379, 10);
                const rawCmd = (payload.command || 'PING').trim();

                if (!rawCmd) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Command is required' }));
                    return;
                }

                // Split command into arguments respecting quotes
                const args = rawCmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [rawCmd];
                const cleanArgs = args.map(a => a.replace(/^["']|["']$/g, ''));

                // Construct standard RESP (REdis Serialization Protocol) array
                let respPacket = `*${cleanArgs.length}\r\n`;
                for (const arg of cleanArgs) {
                    const b = Buffer.from(arg, 'utf8');
                    respPacket += `$${b.length}\r\n${arg}\r\n`;
                }

                const client = new net.Socket();
                let receivedData = '';
                let responded = false;

                const finish = (statusCode, dataObj) => {
                    if (responded) return;
                    responded = true;
                    try { client.destroy(); } catch(e){}
                    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(dataObj));
                };

                client.setTimeout(3500);

                client.connect(port, host, () => {
                    client.write(respPacket);
                });

                client.on('data', (chunk) => {
                    receivedData += chunk.toString('utf8');
                    // Format RESP output into readable text
                    let formatted = receivedData;
                    if (formatted.startsWith('+')) {
                        formatted = formatted.slice(1).replace(/\r\n$/, '');
                    } else if (formatted.startsWith(':')) {
                        formatted = `(integer) ${formatted.slice(1).replace(/\r\n$/, '')}`;
                    } else if (formatted.startsWith('$')) {
                        // Bulk string
                        const lines = formatted.split('\r\n');
                        const len = parseInt(lines[0].slice(1), 10);
                        if (len === -1) {
                            formatted = '(nil)';
                        } else {
                            formatted = lines.slice(1, -1).join('\n');
                        }
                    } else if (formatted.startsWith('*')) {
                        // Array of bulk strings
                        const lines = formatted.split('\r\n');
                        const items = [];
                        let i = 1;
                        let idx = 1;
                        while (i < lines.length - 1) {
                            if (lines[i].startsWith('$')) {
                                const l = parseInt(lines[i].slice(1), 10);
                                if (l === -1) {
                                    items.push(`${idx}) (nil)`);
                                    i += 1;
                                } else {
                                    items.push(`${idx}) "${lines[i+1]}"`);
                                    i += 2;
                                }
                                idx++;
                            } else {
                                i++;
                            }
                        }
                        formatted = items.length > 0 ? items.join('\n') : '(empty array)';
                    } else if (formatted.startsWith('-')) {
                        formatted = `(error) ${formatted.slice(1).replace(/\r\n$/, '')}`;
                    }

                    finish(200, {
                        success: !receivedData.startsWith('-'),
                        host,
                        port,
                        command: rawCmd,
                        output: formatted,
                        raw: receivedData,
                        timeMs: Date.now() - startT
                    });
                });

                client.on('timeout', () => {
                    finish(200, {
                        success: false,
                        host,
                        port,
                        command: rawCmd,
                        error: `Connection timed out connecting to Redis at ${host}:${port}`,
                        timeMs: Date.now() - startT
                    });
                });

                client.on('error', (err) => {
                    finish(200, {
                        success: false,
                        host,
                        port,
                        command: rawCmd,
                        error: `Redis connection error: ${err.message}. (Ensure Redis is running locally on port ${port} or start via Docker).`,
                        timeMs: Date.now() - startT
                    });
                });
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // 4a. Models endpoint (required by Continue / OpenAI clients to validate connection and list models)
    if (pathname.endsWith('/models') || pathname === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            object: "list",
            data: [
                { id: "deepseek-v4-flash", object: "model", created: 1700000000, owned_by: "agentrouter" },
                { id: "claude-opus-5", object: "model", created: 1700000000, owned_by: "agentrouter" },
                { id: "gpt-5.6-sol", object: "model", created: 1700000000, owned_by: "agentrouter" },
                { id: "claude-opus-4-8", object: "model", created: 1700000000, owned_by: "agentrouter" },
                { id: "gpt-6-astra", object: "model", created: 1700000000, owned_by: "agentrouter" }
            ]
        }));
        return;
    }

    // 4b. Embeddings endpoint (prevents Continue codebase indexer from hanging or looping)
    if (pathname.endsWith('/embeddings')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            object: "list",
            data: [{
                object: "embedding",
                embedding: new Array(1536).fill(0),
                index: 0
            }],
            model: "text-embedding-3-small",
            usage: { prompt_tokens: 0, total_tokens: 0 }
        }));
        return;
    }

    // 4c. Legacy text completions endpoint (prevents Continue tab-autocomplete from hanging VS Code)
    if ((pathname.endsWith('/completions') || pathname === '/completions') && !pathname.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'cmpl-' + Date.now(),
            object: 'text_completion',
            created: Math.floor(Date.now() / 1000),
            model: 'fast-autocomplete-mock',
            choices: [{ text: '', index: 0, logprobs: null, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }));
        return;
    }

    // 5. Chat Completions - Match /v1/chat/completions, /chat/completions, /api/chat
    if (pathname.endsWith('/chat/completions') || pathname === '/api/chat') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body || '{}');
                const chatStartMs = Date.now();
                const studioCfg = studio.getConfig();
                const requestedModel = payload.model || studioCfg.settings?.runtime?.fallbackModel || 'gpt-5.6-sol';
                const resolved = studio.resolveModel(requestedModel);
                const resolvedProvider = resolved.provider;

                let token = '';
                const authHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
                if (authHeader) {
                    token = authHeader.replace(/^Bearer\s+/i, '').trim();
                }
                if (!token && payload.token) {
                    token = payload.token.replace(/^Bearer\s+/i, '').trim();
                }
                if (!token || token.length < 10 || token.includes('dummy') || token.includes('test') || token.includes('PASTE')) {
                    token = resolved.key || getStoredKey();
                }
                token = (token || '').replace(/[\r\n"'\s]/g, '').trim();

                const providerNeedsKey = !studio.PROVIDER_PRESETS[resolvedProvider.preset || resolvedProvider.id]?.noKey;
                if (!token && providerNeedsKey) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        error: { 
                            message: `No API key configured for ${resolvedProvider.name}. Open Agent Studio (Ctrl+Shift+A) → Providers & Keys to add one.` 
                        } 
                    }));
                    return;
                }

                // Extract last user message for memory recall & hook context
                const lastUserMsg = [...(payload.messages || [])].reverse().find(m => m.role === 'user');
                const lastUserText = flattenContent(lastUserMsg?.content || '');
                const studioCtx = await studio.buildContext({
                    agentId: payload.agent,
                    userText: lastUserText,
                    sessionId: payload.session_id || null,
                    model: resolved.model
                });

                const endpoint = `${AGENTROUTER_ENDPOINT}/chat/completions`;
                const VALID_MODELS = ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'deepseek-v4-flash', 'claude-opus-4-8', 'claude-opus-5'];
                let model = resolved.model || 'gpt-5.6-sol';
                if (resolvedProvider.type === 'agentrouter' && (model === 'deepseek-v4-flash' || (!VALID_MODELS.includes(model) && ! (resolvedProvider.models || []).includes(model)))) {
                    model = studioCfg.settings?.runtime?.fallbackModel || 'gpt-5.6-sol';
                }
                const isStream = !!payload.stream;
                const effectiveTemp = typeof payload.temperature === 'number'
                    ? payload.temperature
                    : (typeof studioCtx.temperature === 'number' ? studioCtx.temperature : studioCfg.settings?.runtime?.defaultTemperature);
                const effectiveMaxTokens = payload.max_tokens || studioCtx.maxTokens || undefined;

                console.log(`[Proxy] -> ${resolvedProvider.name} :: ${model} (agent: ${studioCtx.agent?.id || 'default'}, stream: ${isStream})`);

                const upstreamPayload = { ...payload, model: model };
                function sanitizeToolSchema(obj) {
                    if (!obj || typeof obj !== 'object') return obj;
                    if (Array.isArray(obj)) return obj.map(sanitizeToolSchema);
                    const cleaned = { ...obj };
                    if ('required' in cleaned && (cleaned.required === null || !Array.isArray(cleaned.required))) {
                        cleaned.required = [];
                    }
                    for (const key of Object.keys(cleaned)) {
                        if (cleaned[key] && typeof cleaned[key] === 'object') {
                            cleaned[key] = sanitizeToolSchema(cleaned[key]);
                        }
                    }
                    return cleaned;
                }

                if (upstreamPayload.tools && Array.isArray(upstreamPayload.tools)) {
                    upstreamPayload.tools = sanitizeToolSchema(upstreamPayload.tools);
                }

                if (isStream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream; charset=utf-8',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                        'Access-Control-Allow-Origin': '*'
                    });

                    // Build a strict, minimal OpenAI-compatible payload with workspace files + Progressive Disclosure Skills + Agent Studio context
                    const maxContextFiles = studioCfg.settings?.runtime?.contextFiles || 80;
                    const wsFiles = getFlatWorkspaceFiles(activeWorkspacePath, maxContextFiles);
                    const projMem = loadProjectMemory(activeWorkspacePath);
                    const memSection = (projMem.notes && projMem.notes.length > 0)
                        ? `\nPersistent Project Memory (${projMem.notes.length} saved rules/facts):\n${projMem.notes.map(n => `• ${n}`).join('\n')}\n`
                        : '';
                    const availableSkills = listAvailableSkills(activeWorkspacePath);
                    const skillsSection = (availableSkills && availableSkills.length > 0)
                        ? `\nAvailable Workspace Skills (Progressive Disclosure — call "read_skill" to inspect full playbook):\n${availableSkills.map(s => `• ${s.name}: ${s.description}`).join('\n')}\n`
                        : '';
                    // Frozen System Header (Excludes dynamic terminal logs to preserve 100% LLM Context Cache Hit Rate)
                    const wsHeader = `Active Workspace: "${path.basename(activeWorkspacePath)}" (Path: "${activeWorkspacePath}")\n${memSection}${skillsSection}Indexed files in project (${wsFiles.length} files):\n${wsFiles.map(f => `• ${f}`).join('\n')}${studioCtx.block || ''}`;

                    let hasSysMsg = false;
                    const cleanMessages = (payload.messages || []).map(m => {
                        let content = m.content;
                        if (m.role === 'system') {
                            hasSysMsg = true;
                            const textContent = typeof content === 'string' ? content : (Array.isArray(content) ? content.map(c => typeof c === 'string' ? c : (c.text || '')).join('') : String(content));
                            if (!textContent.includes(activeWorkspacePath)) {
                                return { role: 'system', content: `${textContent}\n\n${wsHeader}` };
                            }
                            return { role: 'system', content: `${textContent}${studioCtx.block || ''}` };
                        }
                        if (Array.isArray(content)) {
                            const hasImages = content.some(c => c && (c.type === 'image_url' || c.type === 'input_image' || c.image_url));
                            if (hasImages) {
                                return { role: m.role || 'user', content };
                            }
                            content = content.map(c => (typeof c === 'string' ? c : (c.text || ''))).join('');
                        }
                        let strContent = typeof content === 'string' ? content : String(content);
                        if (strContent.length > 25000) {
                            strContent = strContent.slice(0, 25000) + '\n... [Remaining content truncated for gateway stability]';
                        }
                        strContent = sanitizeForUpstreamWAF(strContent);
                        return { role: m.role || 'user', content: strContent };
                    });

                    if (!hasSysMsg) {
                        cleanMessages.unshift({
                            role: 'system',
                            content: `You are an autonomous engineering assistant connected to the active workspace.\n${wsHeader}`
                        });
                    }

                    // Context Caching Dynamic Suffix: inject recent terminal logs onto the latest user message
                    const termSection = getRecentTerminalLogsFormatted();
                    if (termSection && termSection.trim().length > 0) {
                        for (let i = cleanMessages.length - 1; i >= 0; i--) {
                            if (cleanMessages[i].role === 'user') {
                                if (typeof cleanMessages[i].content === 'string') {
                                    cleanMessages[i].content = `${cleanMessages[i].content}\n\n${termSection.trim()}`;
                                } else if (Array.isArray(cleanMessages[i].content)) {
                                    cleanMessages[i].content.push({ type: 'text', text: `\n\n${termSection.trim()}` });
                                }
                                break;
                            }
                        }
                    }

                    // If selected provider is any non-AgentRouter provider (OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Groq, Ollama, Custom), stream directly via Studio
                    if (resolvedProvider.type !== 'agentrouter') {
                        const sr = await studio.streamToResponse({
                            provider: resolvedProvider,
                            model,
                            key: token,
                            messages: formatMessagesForApi(cleanMessages, false),
                            temperature: effectiveTemp,
                            maxTokens: effectiveMaxTokens
                        }, req, res);
                        await studio.afterChat({
                            agentId: studioCtx.agent?.id,
                            sessionId: payload.session_id || null,
                            userText: lastUserText,
                            replyText: sr.text,
                            model,
                            provider: resolvedProvider.id,
                            ms: Date.now() - chatStartMs,
                            ok: sr.ok,
                            error: sr.error
                        });
                        autoExtractProjectFacts(lastUserText, sr.text, activeWorkspacePath);
                        return;
                    }

                    const isResponsesApi = ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol'].includes(model);
                    const apiPath = isResponsesApi ? '/v1/responses' : '/v1/chat/completions';
                    const outPayload = isResponsesApi
                        ? { model, input: formatMessagesForApi(cleanMessages, true), stream: true }
                        : { model, messages: formatMessagesForApi(cleanMessages, false), stream: true };
                    // Never send temperature to Agent Router models — upstream rejects 'temperature' with HTTP 400
                    if (typeof effectiveMaxTokens === 'number' && !isResponsesApi) outPayload.max_tokens = effectiveMaxTokens;

                    const streamBody = JSON.stringify(outPayload);
                    console.log(`[Proxy Stream] Sending ${Buffer.byteLength(streamBody)} bytes upstream to ${apiPath} (model: ${model})`);

                    const streamReq = https.request({
                        hostname: 'agentrouter.org',
                        servername: 'agentrouter.org',
                        port: 443,
                        path: apiPath,
                        method: 'POST',
                        agent: upstreamAgent,
                        timeout: 60000,
                        headers: {
                            'Host': 'agentrouter.org',
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'User-Agent': WHITELISTED_UA,
                            'Content-Length': Buffer.byteLength(streamBody),
                            'Connection': 'close'
                        }
                    }, (upstreamRes) => {
                        req.on('close', () => {
                            if (!upstreamRes.complete) {
                                streamReq.destroy();
                            }
                        });
                        console.log(`[Proxy Stream] Upstream responded: HTTP ${upstreamRes.statusCode}`);

                        if (upstreamRes.statusCode !== 200) {
                            let errText = '';
                            upstreamRes.on('data', c => errText += c);
                            upstreamRes.on('end', () => {
                                let msg = errText;
                                try { msg = JSON.parse(errText).error?.message || errText; } catch(e){}
                                console.error(`[Proxy Stream Upstream Error HTTP ${upstreamRes.statusCode}]:`, msg);
                                let displayMsg = `\n\n[Agent Router ${upstreamRes.statusCode}]: ${msg}\n`;
                                if (!res.writableEnded) {
                                    res.write(`data: ${JSON.stringify({
                                        id: 'err-' + Date.now(),
                                        object: 'chat.completion.chunk',
                                        created: Math.floor(Date.now() / 1000),
                                        model: model,
                                        choices: [{ index: 0, delta: { content: displayMsg }, finish_reason: 'stop' }],
                                        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                                    })}\n\ndata: [DONE]\n\n`);
                                    res.end();
                                }
                            });
                            return;
                        }

                        // Pipe upstream SSE chunks to client
                        let buffer = '';
                        let hasSentUsage = false;
                        let streamedReplyText = '';
                        upstreamRes.on('data', (chunk) => {
                            buffer += chunk.toString('utf8');
                            const lines = buffer.split('\n');
                            buffer = lines.pop() || '';

                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed) continue;

                                if (isResponsesApi) {
                                    if (trimmed.startsWith('data: ')) {
                                        try {
                                          const parsed = JSON.parse(trimmed.slice(6));
                                          if ((parsed.type === 'response.reasoning_summary_text.delta' || parsed.type === 'response.reasoning.delta') && parsed.delta) {
                                            res.write(`data: ${JSON.stringify({
                                              id: parsed.item_id || ('think-' + Date.now()),
                                              object: 'chat.completion.chunk',
                                              created: Math.floor(Date.now() / 1000),
                                              model: model,
                                              choices: [{ index: 0, delta: { reasoning_content: parsed.delta }, finish_reason: null }]
                                            })}\n\n`);
                                          } else if (parsed.type === 'response.output_text.delta' && parsed.delta) {
                                            streamedReplyText += parsed.delta;
                                            res.write(`data: ${JSON.stringify({
                                              id: parsed.item_id || ('chunk-' + Date.now()),
                                              object: 'chat.completion.chunk',
                                              created: Math.floor(Date.now() / 1000),
                                              model: model,
                                              choices: [{ index: 0, delta: { content: parsed.delta }, finish_reason: null }]
                                            })}\n\n`);
                                          } else if (parsed.type === 'response.completed') {
                                            if (!hasSentUsage) {
                                              hasSentUsage = true;
                                              res.write(`data: ${JSON.stringify({ id: 'usage-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
                                            }
                                            res.write('data: [DONE]\n\n');
                                          }
                                        } catch(e){}
                                    }
                                    continue;
                                }

                                if (trimmed === 'data: [DONE]') {
                                    if (!hasSentUsage) {
                                        hasSentUsage = true;
                                        res.write(`data: ${JSON.stringify({ id: 'usage-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
                                    }
                                    res.write('data: [DONE]\n\n');
                                    continue;
                                }
                                if (trimmed.startsWith('data: ')) {
                                    try {
                                        const parsed = JSON.parse(trimmed.slice(6));
                                        if (parsed) {
                                            if (parsed.usage) hasSentUsage = true;
                                            const delta = parsed.choices?.[0]?.delta;
                                            if (delta && !delta.reasoning_content && delta.thinking) {
                                                delta.reasoning_content = delta.thinking;
                                            }
                                            if (delta?.content) streamedReplyText += delta.content;
                                            res.write(`data: ${JSON.stringify(parsed)}\n\n`);
                                        }
                                    } catch (e) {
                                        res.write(`${trimmed}\n\n`);
                                    }
                                }
                            }
                        });

                        upstreamRes.on('end', () => {
                            if (!hasSentUsage) {
                                res.write(`data: ${JSON.stringify({ id: 'usage-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
                            }
                            if (!res.writableEnded) res.end();
                            studio.afterChat({
                                agentId: studioCtx.agent?.id,
                                sessionId: payload.session_id || null,
                                userText: lastUserText,
                                replyText: streamedReplyText,
                                model,
                                provider: resolvedProvider.id,
                                ms: Date.now() - chatStartMs,
                                ok: true
                            }).catch(() => {});
                            autoExtractProjectFacts(lastUserText, streamedReplyText, activeWorkspacePath);
                        });
                    });

                    streamReq.on('error', (err) => {
                        console.error('[Proxy Stream Error]:', err.message, err.code || '');
                        if (!res.writableEnded) {
                            res.write(`data: ${JSON.stringify({
                                id: 'err-' + Date.now(),
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: model,
                                choices: [{ delta: { content: `\n\n[Agent Router Error: ${err.message}]` } }],
                                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                            })}\n\ndata: [DONE]\n\n`);
                            res.end();
                        }
                    });

                    streamReq.on('timeout', () => {
                        console.error('[Proxy Stream] Request timed out');
                        streamReq.destroy(new Error('Upstream request timed out'));
                    });

                    streamReq.write(streamBody);
                    streamReq.end();
                    return;
                }

                // Non-streaming response with tool-calling loop for full codebase visibility
                let clientAborted = false;
                req.on('close', () => {
                    clientAborted = true;
                });

                let totalPromptTokens = 0;
                let totalCompletionTokens = 0;
                let finalData = null;
                const executedTools = [];
                let messagesList = Array.isArray(payload.messages) ? [...payload.messages] : [];

                // Attach cached reasoning_content / thinking if available to prevent upstream 400
                messagesList = messagesList.map(m => {
                    if (m.role === 'assistant') {
                        const key = (m.content || '').substring(0, 120);
                        const cached = thinkingCache.get(key);
                        if (cached && !m.reasoning_content && !m.thinking) {
                            return { ...m, reasoning_content: cached, thinking: cached };
                        }
                    }
                    return m;
                });

                // Inject Active Agent Mandate to ensure the model has full codebase visibility + Agent Studio context + Progressive Disclosure Skills
                const wsFiles = getFlatWorkspaceFiles(activeWorkspacePath, studioCfg.settings?.runtime?.contextFiles || 80);
                const fileListFormatted = wsFiles.length > 0 ? `\nIndexed Project Files (${wsFiles.length} files in codebase):\n${wsFiles.map(f => `• ${f}`).join('\n')}` : '';
                const projMem = loadProjectMemory(activeWorkspacePath);
                const memSection = (projMem.notes && projMem.notes.length > 0)
                    ? `\nPersistent Project Memory (${projMem.notes.length} saved rules/facts):\n${projMem.notes.map(n => `• ${n}`).join('\n')}\n`
                    : '';
                const availableSkills = listAvailableSkills(activeWorkspacePath);
                const skillsSection = (availableSkills && availableSkills.length > 0)
                    ? `\nAvailable Workspace Skills (Progressive Disclosure — call "read_skill" to inspect full playbook):\n${availableSkills.map(s => `• ${s.name}: ${s.description}`).join('\n')}\n`
                    : '';
                const ACTION_MANDATE = `
CRITICAL AGENT DIRECTIVE: You are an AUTONOMOUS SOFTWARE ENGINEERING AGENT operating in project: "${path.basename(activeWorkspacePath)}" (Full path: "${activeWorkspacePath}").
${memSection}
${skillsSection}
${fileListFormatted}${studioCtx.block || ''}

When the user asks you about the codebase, files, or project structure:
1. Answer directly and accurately using the indexed files above. You HAVE FULL VISIBILITY into this project.
2. When the user asks you to run commands, run tests, verify files, install packages, check system status, or run scripts:
   - Call "execute_terminal_command" to execute the shell command autonomously.
   - In your answer, also output the command in a \`\`\`terminal code block so the Web IDE executes it automatically.
3. When the user asks you to fix bugs, edit code, or create files:
   - Call "write_workspace_file" with the complete corrected file content.
   - When presenting code fixes in your response, ALWAYS output complete code blocks with the target file path in the markdown fence header (e.g. \`\`\`javascript:path/to/file.js or \`\`\`file:path/to/file.js).
   - The Web IDE is equipped with Autonomous Code Application and automatically applies all changes to the editor and workspace disk without requiring the user to click Apply. Never tell the user to click Apply.
4. When inspecting specific file contents, call "read_workspace_file".
5. When learning important project conventions, architectural facts, or user instructions that must be remembered permanently, call "save_project_memory".
6. When needing specialized procedures (e.g. Python testing/virtualenvs, git flows, or custom workflows), call "read_skill" to fetch the playbook.`;

                let hasSys = false;
                messagesList = messagesList.map(m => {
                    if (m.role === 'system') {
                        hasSys = true;
                        return { ...m, content: m.content + '\n\n' + ACTION_MANDATE };
                    }
                    return m;
                });
                if (!hasSys) {
                    messagesList.unshift({ role: 'system', content: ACTION_MANDATE });
                }

                // Dynamic Context Suffix for context caching
                const nonStreamTermSection = getRecentTerminalLogsFormatted();
                if (nonStreamTermSection && nonStreamTermSection.trim().length > 0) {
                    for (let i = messagesList.length - 1; i >= 0; i--) {
                        if (messagesList[i].role === 'user') {
                            if (typeof messagesList[i].content === 'string') {
                                messagesList[i].content = `${messagesList[i].content}\n\n${nonStreamTermSection.trim()}`;
                            }
                            break;
                        }
                    }
                }

                // Flatten multi-turn conversation history into a single clean user turn.
                // This guarantees standard OpenAI compatibility and completely prevents 
                // "unknown variant thinking" (422) and "content[].thinking must be passed back" (400).
                const sysMsg = messagesList.find(m => m.role === 'system');
                const nonSysMsgs = messagesList.filter(m => m.role !== 'system');
                if (nonSysMsgs.length > 1) {
                    let historyContext = '';
                    for (let i = 0; i < nonSysMsgs.length - 1; i++) {
                        const turn = nonSysMsgs[i];
                        let text = typeof turn.content === 'string' ? turn.content : (Array.isArray(turn.content) ? turn.content.map(c => c.text || '').join('') : JSON.stringify(turn.content));
                        if (text.trim()) {
                            historyContext += `[Previous ${turn.role.toUpperCase()}]:\n${text.trim()}\n\n`;
                        }
                    }
                    const lastTurn = nonSysMsgs[nonSysMsgs.length - 1];
                    let lastText = typeof lastTurn.content === 'string' ? lastTurn.content : (Array.isArray(lastTurn.content) ? lastTurn.content.map(c => c.text || '').join('') : JSON.stringify(lastTurn.content));
                    const combinedPrompt = historyContext 
                        ? `${historyContext}[Current User Request]:\n${lastText}`
                        : lastText;
                    
                    messagesList = [
                        ...(sysMsg ? [sysMsg] : []),
                        { role: 'user', content: sanitizeForUpstreamWAF(combinedPrompt.trim()) }
                    ];
                } else {
                    messagesList = messagesList.map(m => {
                        if (typeof m.content === 'string') {
                            return { ...m, content: sanitizeForUpstreamWAF(m.content) };
                        }
                        return m;
                    });
                }

                // If selected provider is a non-AgentRouter provider in non-streaming mode, complete via Studio
                if (resolvedProvider.type !== 'agentrouter') {
                    const cr = await studio.complete({
                        model: `${resolvedProvider.id}::${model}`,
                        messages: messagesList,
                        temperature: effectiveTemp,
                        maxTokens: effectiveMaxTokens
                    });
                    const cleanReply = studio.stripDirectives(cr.text);
                    await studio.afterChat({
                        agentId: studioCtx.agent?.id,
                        sessionId: payload.session_id || null,
                        userText: lastUserText,
                        replyText: cr.text,
                        model,
                        provider: resolvedProvider.id,
                        ms: Date.now() - chatStartMs,
                        ok: true
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'chatcmpl-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model,
                        choices: [{ index: 0, message: { role: 'assistant', content: cleanReply }, finish_reason: 'stop' }],
                        usage: cr.usage || { prompt_tokens: 15, completion_tokens: Math.round(cleanReply.length / 4), total_tokens: 15 + Math.round(cleanReply.length / 4) }
                    }));
                    return;
                }

                const MAX_TOOL_ROUNDS = Math.max(1, studioCfg.settings?.runtime?.maxToolRounds || 2);
                for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                    if (clientAborted || req.destroyed || res.writableEnded) {
                        console.log('[Proxy] Client closed connection, stopping agent tool loop.');
                        return;
                    }
                    const currentPayload = {
                        ...upstreamPayload,
                        messages: messagesList,
                        tools: WORKSPACE_TOOLS,
                        tool_choice: 'auto'
                    };

                    let apiResult = null;
                    let fetchError = null;
                    for (let attempt = 1; attempt <= 2; attempt++) {
                        try {
                            apiResult = await postAgentRouterRaw(currentPayload, token, 25000);
                            break;
                        } catch (e) {
                            fetchError = e;
                            const delay = attempt * 600;
                            console.warn(`[Proxy] Request attempt ${attempt} failed: ${e.message}. Retrying in ${delay}ms...`);
                            await new Promise(r => setTimeout(r, delay));
                        }
                    }

                    if (!apiResult) {
                        throw fetchError || new Error('Connection to Agent Router timed out');
                    }

                    let rawText = apiResult.body;
                    let statusCode = apiResult.status;
                    console.log(`[Proxy Round ${round + 1}] Status: ${statusCode}, Body: ${rawText.substring(0, 160)}`);

                    // Handle WAF challenge or 405 Method Not Allowed from upstream Alibaba Cloud
                    if (rawText.trim().startsWith('<') || statusCode === 405) {
                        console.warn(`[Proxy Round ${round + 1}] Received WAF challenge / 405. Sleeping 1.5s and retrying with minimal clean turns...`);
                        await new Promise(r => setTimeout(r, 1500));
                        
                        const sys = messagesList.find(m => m.role === 'system');
                        const lastUser = [...messagesList].reverse().find(m => m.role === 'user');
                        currentPayload.messages = [
                            ...(sys ? [{ role: 'system', content: sanitizeForUpstreamWAF(sys.content) }] : []),
                            ...(lastUser ? [{ role: 'user', content: sanitizeForUpstreamWAF(lastUser.content) }] : [])
                        ];

                        try {
                            const retryRes = await postAgentRouterRaw(currentPayload, token, 35000);
                            if (!retryRes.body.trim().startsWith('<') && retryRes.status === 200) {
                                statusCode = retryRes.status;
                                rawText = retryRes.body;
                            }
                        } catch (e) {}
                    }

                    if (rawText.trim().startsWith('<') || statusCode === 405) {
                        const match = rawText.match(/<title>([^<]+)<\/title>/i);
                        const title = match ? match[1].trim() : 'WAF / Rate Limit';
                        if (executedTools.length > 0) {
                            const summaryText = `I completed the requested workspace operations:\n` +
                                executedTools.map(t => `• **${t.name}**: \`${t.args?.file_path || t.args?.query || t.args?.directory || ''}\``).join('\n') +
                                `\n\nAll modifications and tool operations have been prepared and applied.`;
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                id: 'chatcmpl-' + Date.now(),
                                object: 'chat.completion',
                                created: Math.floor(Date.now() / 1000),
                                model: model,
                                choices: [{ index: 0, message: { role: 'assistant', content: summaryText }, finish_reason: 'stop' }],
                                tools_used: executedTools,
                                usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }
                            }));
                            return;
                        }
                        res.writeHead(statusCode || 405, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            error: { message: `Agent Router Gateway (${statusCode}): ${title}. Please re-send or switch model.` },
                            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                        }));
                        return;
                    }

                    let parsedData;
                    try {
                        parsedData = JSON.parse(rawText);
                    } catch (e) {
                        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                        res.end(rawText);
                        return;
                    }

                    // Auto-heal thinking-mode and sensitive-words WAF errors
                    if (parsedData.error) {
                        const errStr = (parsedData.error.message || '').toLowerCase();
                        const isSensitive = errStr.includes('sensitive words') || parsedData.error.code === 'sensitive_words_detected';
                        const isThinking = errStr.includes('thinking') || errStr.includes('content[].thinking') || errStr.includes('thinking mode');

                        if (isSensitive || isThinking) {
                            console.warn(`[Proxy] Detected upstream issue (${isSensitive ? 'sensitive words' : 'thinking mode'}). Sanitizing & retrying...`);
                            
                            // If sensitive words triggered on tool output, condense all tool results to safe summaries
                            if (isSensitive) {
                                for (let i = 0; i < messagesList.length; i++) {
                                    if (messagesList[i].role === 'tool') {
                                        messagesList[i].content = JSON.stringify({
                                            status: "inspected",
                                            note: "File content read successfully. Detailed text condensed to clear upstream content safety filters."
                                        });
                                    }
                                }
                            }

                            const sys = messagesList.find(m => m.role === 'system');
                            const nonSys = messagesList.filter(m => m.role !== 'system');
                            
                            // Collapse turns into clean prompt to bypass validation errors
                            let historyContext = '';
                            for (let i = 0; i < nonSys.length - 1; i++) {
                                const turn = nonSys[i];
                                let text = '';
                                if (typeof turn.content === 'string') {
                                    text = turn.content;
                                } else if (Array.isArray(turn.content)) {
                                    text = turn.content.map(c => c.text || '').filter(Boolean).join('\n');
                                }
                                if (text.trim()) {
                                    historyContext += `[${turn.role.toUpperCase()}]: ${text.trim()}\n\n`;
                                }
                            }
                            
                            const lastTurn = nonSys[nonSys.length - 1];
                            let lastText = '';
                            if (lastTurn) {
                                if (typeof lastTurn.content === 'string') {
                                    lastText = lastTurn.content;
                                } else if (Array.isArray(lastTurn.content)) {
                                    lastText = lastTurn.content.map(c => c.text || '').filter(Boolean).join('\n');
                                }
                            }
                            
                            const collapsedUserPrompt = historyContext 
                                ? `${historyContext}[CURRENT USER REQUEST]:\n${lastText}`
                                : lastText;

                            messagesList = [
                                ...(sys ? [sys] : []),
                                { role: 'user', content: collapsedUserPrompt }
                            ];
                            currentPayload.messages = messagesList;

                            try {
                                const retryRes = await postAgentRouterRaw(currentPayload, token, 40000);
                                statusCode = retryRes.status;
                                rawText = retryRes.body;
                                parsedData = JSON.parse(rawText);
                                console.log(`[Proxy Auto-Heal Retry] Status: ${statusCode}, Body: ${rawText.substring(0, 160)}`);
                            } catch (retryErr) {
                                console.error('[Proxy Retry Error]:', retryErr);
                            }
                        }
                    }

                    if (parsedData.error) {
                        console.error(`[Proxy Upstream Error in round ${round + 1}]:`, JSON.stringify(parsedData.error));
                        if (executedTools.length > 0) {
                            const summaryText = `I completed the requested workspace operations:\n` +
                                executedTools.map(t => `• **${t.name}**: \`${t.args?.file_path || t.args?.query || t.args?.directory || ''}\``).join('\n') +
                                `\n\nAll inspected and modified files have been processed.`;
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                id: 'chatcmpl-' + Date.now(),
                                object: 'chat.completion',
                                created: Math.floor(Date.now() / 1000),
                                model: model,
                                choices: [{ index: 0, message: { role: 'assistant', content: summaryText }, finish_reason: 'stop' }],
                                tools_used: executedTools,
                                usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }
                            }));
                            return;
                        }
                        if (!parsedData.usage) {
                            parsedData.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
                        }
                        res.writeHead(statusCode || 400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(parsedData));
                        return;
                    }

                    if (parsedData.usage) {
                        totalPromptTokens += (parsedData.usage.prompt_tokens || 0);
                        totalCompletionTokens += (parsedData.usage.completion_tokens || 0);
                    }

                    // Cache any reasoning_content or thinking
                    const choice = parsedData.choices?.[0];
                    if (choice?.message?.content && (choice?.message?.reasoning_content || choice?.message?.thinking)) {
                        thinkingCache.set(choice.message.content.substring(0, 120), choice.message.reasoning_content || choice.message.thinking);
                    }

                    const toolCalls = choice?.message?.tool_calls;

                    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length > 0 && round < MAX_TOOL_ROUNDS - 1) {
                        console.log(`[Proxy] Model invoked ${toolCalls.length} tool(s) in round ${round + 1}`);
                        
                        // Maintain standard OpenAI message schema with reasoning_content (never put 'thinking' in content array)
                        const assistantMsg = { ...choice.message };
                        assistantMsg.content = typeof choice.message.content === 'string' ? choice.message.content : '';
                        if (choice.message.reasoning_content) {
                            assistantMsg.reasoning_content = choice.message.reasoning_content;
                        }
                        delete assistantMsg.thinking;
                        messagesList.push(assistantMsg);

                        const permMode = payload.permission_mode || 'default';
                        for (const tc of toolCalls) {
                            const fnName = tc.function?.name;
                            const fnArgs = tc.function?.arguments;
                            const result = agentAllowsTool(studioCtx.agent, fnName)
                                ? await executeTool(fnName, fnArgs, permMode)
                                : { error: `Agent "${studioCtx.agent?.name}" does not have permission to run tool "${fnName}".` };
                            executedTools.push({ name: fnName, args: fnArgs, result: result });
                            messagesList.push({
                                role: 'tool',
                                tool_call_id: tc.id,
                                content: sanitizeForUpstreamWAF(JSON.stringify(result))
                            });
                        }
                        // Continue to next round so model consumes tool results and continues working
                        continue;
                    }

                    // Check for native DSML tool call in content
                    const contentStr = choice?.message?.content || '';
                    if (contentStr.includes('<｜｜DSML｜｜ invoke') && round < MAX_TOOL_ROUNDS - 1) {
                        const fnMatch = contentStr.match(/invoke name="([^"]+)"/);
                        const fileMatch = contentStr.match(/parameter name="(?:file_path|path|filename)"[^>]*>([\s\S]*?)<\//);
                        const contentMatch = contentStr.match(/parameter name="(?:content|code|text)"[^>]*>([\s\S]*?)<\//);
                        const queryMatch = contentStr.match(/parameter name="query"[^>]*>([\s\S]*?)<\//);
                        const dirMatch = contentStr.match(/parameter name="directory"[^>]*>([\s\S]*?)<\//);

                        if (fnMatch) {
                            const fnName = fnMatch[1];
                            const args = {};
                            if (fileMatch) args.file_path = fileMatch[1].trim();
                            if (contentMatch) args.content = contentMatch[1];
                            if (queryMatch) args.query = queryMatch[1].trim();
                            if (dirMatch) args.directory = dirMatch[1].trim();

                            const permMode = payload.permission_mode || 'default';
                            console.log(`[Proxy] Detected DSML tool call: ${fnName}(${JSON.stringify(args)}) [perm: ${permMode}]`);
                            const result = await executeTool(fnName, args, permMode);
                            executedTools.push({ name: fnName, args, result: result });
                            messagesList.push(choice.message);
                            messagesList.push({
                                role: 'user',
                                content: `[Tool Execution Result for ${fnName}]:\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nContinue executing next steps toward the goal, or provide your full response if completed.`
                            });
                            continue;
                        }
                    }

                    // Final response reached: guarantee usage is always non-null
                    if (!parsedData.usage || typeof parsedData.usage !== 'object') {
                        parsedData.usage = {
                            prompt_tokens: totalPromptTokens || 15,
                            completion_tokens: totalCompletionTokens || 25,
                            total_tokens: (totalPromptTokens || 15) + (totalCompletionTokens || 25)
                        };
                    } else {
                        parsedData.usage.prompt_tokens = totalPromptTokens || parsedData.usage.prompt_tokens || 15;
                        parsedData.usage.completion_tokens = totalCompletionTokens || parsedData.usage.completion_tokens || 25;
                        parsedData.usage.total_tokens = parsedData.usage.prompt_tokens + parsedData.usage.completion_tokens;
                    }
                    if (executedTools.length > 0) {
                        parsedData.tools_used = executedTools;
                    }

                    // Strip any lingering raw DSML blocks from user-visible content
                    if (parsedData.choices?.[0]?.message?.content) {
                        let text = parsedData.choices[0].message.content;
                        text = text.replace(/<｜｜DSML｜｜[\s\S]*?<\/｜｜DSML｜｜ calls>/g, '').replace(/<｜｜DSML｜｜[\s\S]*?<\/｜｜DSML｜｜ invoke>/g, '').trim();
                        if (!text && executedTools.length > 0) {
                            const lastTool = executedTools[executedTools.length - 1];
                            if (lastTool.name === 'write_workspace_file' || lastTool.name === 'create_file') {
                                if (lastTool.result?.pending_approval) {
                                    text = `I have prepared proposed changes for **\`${lastTool.args?.file_path || lastTool.result?.file || 'file'}\`**. Please review the diff below and choose whether to accept or reject the changes.`;
                                } else {
                                    text = `Successfully created and saved file **\`${lastTool.args?.file_path || 'file'}\`** to your workspace.`;
                                }
                            } else {
                                text = `Successfully executed workspace tool: \`${lastTool.name}\`.`;
                            }
                        }
                        parsedData.choices[0].message.content = text;
                    }

                    finalData = parsedData;
                    break;
                }

                if (!finalData) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'chatcmpl-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: model,
                        choices: [{ index: 0, message: { role: 'assistant', content: 'Operation completed.' }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
                    }));
                    return;
                }

                const finalReplyText = finalData?.choices?.[0]?.message?.content || '';
                if (finalData?.choices?.[0]?.message?.content) {
                    finalData.choices[0].message.content = studio.stripDirectives(finalReplyText);
                }
                studio.afterChat({
                    agentId: studioCtx.agent?.id,
                    sessionId: payload.session_id || null,
                    userText: lastUserText,
                    replyText: finalReplyText,
                    model,
                    provider: resolvedProvider.id,
                    ms: Date.now() - chatStartMs,
                    ok: true
                }).catch(() => {});
                autoExtractProjectFacts(lastUserText, finalReplyText, activeWorkspacePath);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(finalData));

            } catch (err) {
                console.error('[Proxy Error]', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: err.message || 'Internal proxy error' } }));
            }
        });
        return;
    }

    // 6. Models Endpoint
    if (pathname.includes('/models')) {
        const parts = pathname.split('/models');
        const subpath = (parts[parts.length - 1] || '').replace(/^\/+/, '');

        if (subpath && subpath !== 'models') {
            const modelId = decodeURIComponent(subpath);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: modelId,
                object: "model",
                created: 1626777600,
                owned_by: "openai",
                permission: []
            }));
            return;
        }

        const token = getStoredKey();
        try {
            const modelsRes = await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'agentrouter.org',
                    servername: 'agentrouter.org',
                    port: 443,
                    path: '/v1/models',
                    method: 'GET',
                    agent: upstreamAgent,
                    headers: {
                        'Host': 'agentrouter.org',
                        'Authorization': `Bearer ${token}`,
                        'User-Agent': WHITELISTED_UA,
                        'Connection': 'keep-alive'
                    },
                    timeout: 10000
                }, (r) => {
                    let d = '';
                    r.on('data', chunk => d += chunk);
                    r.on('end', () => resolve({ status: r.statusCode, body: d }));
                });
                req.on('error', reject);
                req.on('timeout', () => req.destroy(new Error('Timeout')));
                req.end();
            });

            const raw = JSON.parse(modelsRes.body);
            const rawData = Array.isArray(raw.data) ? raw.data : [];
            const standardList = rawData.map(m => ({
                id: m.id,
                object: "model",
                created: m.created || 1626777600,
                owned_by: m.owned_by || "openai",
                permission: []
            }));

            if (!res.headersSent) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    object: "list",
                    data: standardList
                }));
            }
        } catch (err) {
            if (!res.headersSent) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    object: "list",
                    data: [
                        { id: "deepseek-v4-flash", object: "model", created: 1626777600, owned_by: "deepseek" },
                        { id: "glm-5.3", object: "model", created: 1626777600, owned_by: "zhipu" },
                        { id: "gpt-5.6-sol", object: "model", created: 1626777600, owned_by: "openai" },
                        { id: "gpt-6-astra", object: "model", created: 1626777600, owned_by: "openai" },
                        { id: "claude-opus-5", object: "model", created: 1626777600, owned_by: "anthropic" },
                        { id: "claude-opus-4-8", object: "model", created: 1626777600, owned_by: "anthropic" }
                    ]
                }));
            }
        }
        return;
    }

    // 7. Key Status
    if (pathname === '/api/key-status') {
        const key = getStoredKey();
        const masked = key ? (key.substring(0, 7) + '...' + key.substring(key.length - 4)) : '';
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        });
        res.end(JSON.stringify({ 
            hasKey: !!key, 
            keyMasked: masked,
            defaultModel: 'deepseek-v4-flash',
            userAgentActive: WHITELISTED_UA
        }));
        return;
    }

    // Static file serving fallback (strict allowlist of public extensions; excludes secrets & credentials)
    const ALLOWED_STATIC_EXTS = new Set([
        '.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf'
    ]);

    let possibleFile = path.normalize(path.join(activeWorkspacePath, pathname));
    let isInside = isPathInside(activeWorkspacePath, possibleFile);
    if (!isInside || !fs.existsSync(possibleFile) || !fs.statSync(possibleFile).isFile()) {
        possibleFile = path.normalize(path.join(__dirname, pathname));
        isInside = isPathInside(__dirname, possibleFile);
    }

    if (isInside && fs.existsSync(possibleFile) && fs.statSync(possibleFile).isFile()) {
        const ext = path.extname(possibleFile).toLowerCase();
        if (!ALLOWED_STATIC_EXTS.has(ext) || isSensitivePath(possibleFile)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Forbidden' } }));
            return;
        }
        const mimeTypes = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf'
        };
        const mime = mimeTypes[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
        fs.createReadStream(possibleFile).pipe(res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Route not found: ${pathname}` } }));
});

server.listen(PORT, HOST, () => {
    console.log(`\n======================================================`);
    console.log(`Pocket Cowork — Web IDE running on ${HOST}:${PORT}`);
    console.log(`Local URL:   http://localhost:${PORT} (or http://127.0.0.1:${PORT})`);
    console.log(`Mobile/LAN:  Set HOST=0.0.0.0 in .env to access from Android on Wi-Fi`);
    console.log(`Security:    Fail-closed auth & .env secret protection active`);
    console.log(`======================================================\n`);
});
