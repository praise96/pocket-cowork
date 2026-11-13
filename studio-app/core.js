// ═══════════════════════════════════════════════════════════════════════════
//  AGENT STUDIO — Core Engine
//  Providers · Agents · Long/Short-term Memory · Hooks · Activity · Arena
//
//  All user-facing state lives in plain files under <root>/studio/ so it can be
//  inspected and edited straight from the IDE:
//     studio/studio.config.json   ← control file (providers, agents, settings, hooks)
//     studio/secrets.json         ← API keys (never sent to the browser unmasked)
//     studio/memory/long_term.json
//     studio/memory/short_term.json
//     studio/hooks/*.mjs          ← script hooks
//     studio/logs/activity.jsonl
// ═══════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ─── Provider presets (all speak the OpenAI chat-completions dialect) ───────
export const PROVIDER_PRESETS = {
    agentrouter: { name: 'Agent Router', type: 'agentrouter', baseUrl: 'https://agentrouter.org/v1', models: ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'claude-opus-5', 'claude-opus-4-8', 'deepseek-v4-flash'], keyUrl: 'https://agentrouter.org/console/token' },
    bedrock:     { name: 'AWS Bedrock', type: 'openai', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', region: 'us-east-1', models: ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.anthropic.claude-opus-4-1-20250805-v1:0', 'us.meta.llama3-3-70b-instruct-v1:0', 'us.amazon.nova-pro-v1:0', 'us.deepseek.r1-v1:0'], keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys' },
    openai:      { name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini'], keyUrl: 'https://platform.openai.com/api-keys' },
    anthropic:   { name: 'Anthropic', type: 'openai', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'], keyUrl: 'https://console.anthropic.com/settings/keys' },
    gemini:      { name: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], keyUrl: 'https://aistudio.google.com/apikey' },
    openrouter:  { name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['openrouter/auto', 'anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'], keyUrl: 'https://openrouter.ai/keys' },
    deepseek:    { name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys' },
    groq:        { name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], keyUrl: 'https://console.groq.com/keys' },
    mistral:     { name: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'codestral-latest'], keyUrl: 'https://console.mistral.ai/api-keys' },
    xai:         { name: 'xAI Grok', type: 'openai', baseUrl: 'https://api.x.ai/v1', models: ['grok-4', 'grok-3-mini'], keyUrl: 'https://console.x.ai' },
    together:    { name: 'Together AI', type: 'openai', baseUrl: 'https://api.together.xyz/v1', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-Coder-32B-Instruct'], keyUrl: 'https://api.together.ai/settings/api-keys' },
    ollama:      { name: 'Ollama (local)', type: 'openai', baseUrl: 'http://localhost:11434/v1', models: ['llama3.1', 'qwen2.5-coder'], noKey: true },
    lmstudio:    { name: 'LM Studio (local)', type: 'openai', baseUrl: 'http://localhost:1234/v1', models: ['local-model'], noKey: true },
    custom:      { name: 'Custom (OpenAI-compatible)', type: 'openai', baseUrl: 'https://your-endpoint.example.com/v1', models: [] }
};

export const TOOL_PERMISSIONS = ['read', 'write', 'terminal', 'search', 'memory', 'delegate'];

const DEFAULT_AGENTS = [
    {
        id: 'builder', name: 'Builder', emoji: '', color: '#38bdf8', model: 'gpt-5.6-sol',
        temperature: 0.3, maxTokens: 0, memory: 'both', tools: ['read', 'write', 'terminal', 'search', 'memory'],
        description: 'Default full-stack engineer. Ships working code end to end.',
        systemPrompt: 'You are Builder, a senior full-stack engineer. Read before you write, make minimal correct changes, and always output complete files with their path in the code fence header. Verify with terminal commands when useful.'
    },
    {
        id: 'architect', name: 'Architect', emoji: '', color: '#a78bfa', model: 'gpt-6-astra',
        temperature: 0.5, maxTokens: 0, memory: 'both', tools: ['read', 'search', 'memory'],
        description: 'Plans systems, data models and migrations before code is written.',
        systemPrompt: 'You are Architect. Before proposing code, produce a short plan: goals, constraints, components, data flow, risks, and an ordered task list. Prefer simple designs. Record key decisions with [[remember: ...]].'
    },
    {
        id: 'reviewer', name: 'Reviewer', emoji: '', color: '#f59e0b', model: 'gpt-5.6-sol',
        temperature: 0.2, maxTokens: 0, memory: 'long', tools: ['read', 'search'],
        description: 'Strict code reviewer: bugs, edge cases, readability.',
        systemPrompt: 'You are Reviewer. Review the code the user points to. Report findings as a prioritized list (Critical / Major / Minor) with file:line references and concrete fixes. Do not rewrite whole files unless asked.'
    },
    {
        id: 'sentinel', name: 'Sentinel', emoji: '', color: '#ef4444', model: 'gpt-5.6-sol',
        temperature: 0.1, maxTokens: 0, memory: 'long', tools: ['read', 'search'],
        description: 'Security auditor: auth, injection, secrets, OWASP Top 10.',
        systemPrompt: 'You are Sentinel, an application security auditor. Hunt for auth/permission flaws, injection (SQL, command, XSS), secret leakage, insecure defaults and missing validation. Rate each issue by severity and give a patch.'
    },
    {
        id: 'scribe', name: 'Scribe', emoji: '', color: '#10b981', model: 'gpt-5.6-sol',
        temperature: 0.6, maxTokens: 0, memory: 'short', tools: ['read', 'write', 'search'],
        description: 'Writes READMEs, docstrings, changelogs and guides.',
        systemPrompt: 'You are Scribe, a technical writer. Produce clear, well-structured documentation in Markdown. Match the existing tone of the project and keep examples runnable.'
    }
];

export const DEFAULT_SETTINGS = {
    general:  {
        studioName: 'Agent Studio',
        themePreset: 'obsidian',
        accent: '#3b82f6',
        bgBase: '#0a0c10',
        bgSidebar: '#0f1219',
        bgEditor: '#0c0e14',
        bgCard: '#151922',
        borderColor: '#232838',
        replyColor: '#38bdf8',
        thinkingColor: '#a78bfa',
        collapseThinking: false,
        agentTone: 'default',
        customTonePrompt: '',
        compactMode: false,
        showTokenUsage: true,
        confirmDangerous: true
    },
    editor:   { fontSize: 13, tabSize: 2, wordWrap: 'on', minimap: false, lineNumbers: 'on', fontLigatures: true, renderWhitespace: 'selection', cursorBlinking: 'smooth', smoothScrolling: true },
    chat:     { defaultAgent: 'builder', historyLimit: 40, autoScroll: true, sendOnEnter: true },
    runtime:  { requestTimeoutSec: 90, maxToolRounds: 2, contextFiles: 80, defaultTemperature: 0.3, fallbackModel: 'gpt-5.6-sol', retryWithFallback: true },
    memory:   { enabled: true, autoCapture: true, inlineDirectives: true, shortTermMax: 40, shortTermTTLHours: 48, longTermTopK: 8, injectPinned: true, scopeToProject: true },
    security: { hookToken: '', allowScriptHooks: true, allowRemoteHookCalls: false }
};

export const TONE_INSTRUCTIONS = {
    default: '',
    concise: 'COMMUNICATION TONE: Be ultra-concise, direct, and surgical. Skip pleasantries and filler; lead with the solution or code.',
    friendly: 'COMMUNICATION TONE: Be a warm, encouraging, collaborative pair-programmer. Explain ideas enthusiastically and clearly.',
    principal: 'COMMUNICATION TONE: Speak as a rigorous Principal Staff Engineer. Emphasize correctness, edge cases, performance, and clean architecture.',
    teacher: 'COMMUNICATION TONE: Act as a patient, step-by-step mentor. Explain the "why" behind each change so the user learns deeply.',
    cyberpunk: 'COMMUNICATION TONE: Adopt a sharp, high-tech netrunner / cyberpunk engineering persona while keeping all technical output 100% accurate.'
};

const DEFAULT_HOOKS = [
    { id: 'hook_datetime', name: 'Inject current date/time', event: 'beforeChat', type: 'inject', enabled: true, template: 'Current local time: {{datetime}}. Active workspace: {{workspace}}.' },
    { id: 'hook_example_script', name: 'Example script hook (studio/hooks/example.mjs)', event: 'afterChat', type: 'script', enabled: false, file: 'example.mjs' },
    { id: 'hook_webhook', name: 'Notify a webhook after each reply', event: 'afterChat', type: 'webhook', enabled: false, url: 'https://example.com/webhook' }
];

export const HOOK_EVENTS = ['beforeChat', 'afterChat', 'onMemoryWrite', 'onError', 'custom'];

// ─── Small helpers ──────────────────────────────────────────────────────────
const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
    if (!isObj(base)) return over === undefined ? base : over;
    const out = { ...base };
    if (!isObj(over)) return out;
    for (const k of Object.keys(over)) {
        out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
    }
    return out;
}

function readJSON(file, fallback) {
    try {
        if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        console.warn(`[Studio] Could not parse ${path.basename(file)}: ${e.message}`);
    }
    return fallback;
}

function writeJSON(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function maskKey(k) {
    if (!k) return '';
    if (k.length <= 10) return '•'.repeat(k.length);
    return `${k.slice(0, 5)}…${k.slice(-4)}`;
}

const STOPWORDS = new Set('the a an and or of to in on for is are was be with this that it as at by from i you we they me my our your can do does did please make just use using into about what how why when where which'.split(' '));
function tokenize(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9_.\-/]+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

// ═══════════════════════════════════════════════════════════════════════════
export function createStudio({ rootDir, getWorkspacePath, agentRouterPost, legacyKeyPath, masterToken = '' }) {
    const STUDIO_DIR = path.join(rootDir, 'studio');
    const CONFIG_FILE = path.join(STUDIO_DIR, 'studio.config.json');
    const SECRETS_FILE = path.join(STUDIO_DIR, 'secrets.json');
    const LTM_FILE = path.join(STUDIO_DIR, 'memory', 'long_term.json');
    const STM_FILE = path.join(STUDIO_DIR, 'memory', 'short_term.json');
    const HOOKS_DIR = path.join(STUDIO_DIR, 'hooks');
    const LOG_FILE = path.join(STUDIO_DIR, 'logs', 'activity.jsonl');

    const activity = [];
    const stats = { startedAt: Date.now(), requests: 0, errors: 0, byModel: {}, byAgent: {}, latencyTotal: 0 };
    const listeners = new Set();
    let configCache = null, configMtime = 0;

    // ── Bootstrap files on first run ────────────────────────────────────────
    function bootstrap() {
        fs.mkdirSync(path.join(STUDIO_DIR, 'memory'), { recursive: true });
        fs.mkdirSync(HOOKS_DIR, { recursive: true });
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

        if (!fs.existsSync(CONFIG_FILE)) {
            const providers = ['agentrouter', 'bedrock', 'openai', 'anthropic', 'gemini', 'openrouter', 'ollama'].map(id => ({
                id, name: PROVIDER_PRESETS[id].name, type: PROVIDER_PRESETS[id].type, baseUrl: PROVIDER_PRESETS[id].baseUrl,
                region: PROVIDER_PRESETS[id].region || undefined,
                enabled: id === 'agentrouter', models: [...PROVIDER_PRESETS[id].models], headers: {}, preset: id
            }));
            writeJSON(CONFIG_FILE, {
                $readme: 'Agent Studio control file. Edit providers, agents, routing, settings and hooks here or from the Studio UI (Ctrl+Shift+A). API keys live in secrets.json.',
                version: 1, providers, agents: clone(DEFAULT_AGENTS), settings: clone(DEFAULT_SETTINGS), hooks: clone(DEFAULT_HOOKS)
            });
        }
        if (!fs.existsSync(SECRETS_FILE)) {
            const secrets = { $readme: 'API keys per provider id. Keep this file private; it is gitignored.', providers: {} };
            try {
                if (legacyKeyPath && fs.existsSync(legacyKeyPath)) {
                    const raw = fs.readFileSync(legacyKeyPath, 'utf8');
                    const line = raw.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('sk-')) || raw.trim();
                    if (line && !line.includes('PASTE')) secrets.providers.agentrouter = { apiKey: line };
                }
            } catch (e) {}
            writeJSON(SECRETS_FILE, secrets);
        }
        if (!fs.existsSync(LTM_FILE)) writeJSON(LTM_FILE, { $readme: 'Long-term memory: durable facts, decisions and preferences. Pinned entries are always injected.', entries: [] });
        if (!fs.existsSync(STM_FILE)) writeJSON(STM_FILE, { $readme: 'Short-term memory: rolling working context with TTL. Auto-captured from recent turns.', entries: [] });
        if (!fs.existsSync(LOG_FILE)) {
            try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch (e) {}
        }

        const gi = path.join(STUDIO_DIR, '.gitignore');
        if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'secrets.json\nlogs/\nmemory/\n*.tmp\n', 'utf8');

        const example = path.join(HOOKS_DIR, 'example.mjs');
        if (!fs.existsSync(example)) {
            fs.writeFileSync(example, `// Example Agent Studio script hook.
// Export a default function (or a function named after the event).
// ctx = { event, agent, model, workspace, userText, replyText, sessionId, data }
// api = { remember(text, opts), note(text, opts), recall(query, limit), log(msg), config() }
// Return a string (or { inject: "..." }) from a beforeChat hook to add it to the system prompt.

export default async function (ctx, api) {
    if (ctx.event === 'afterChat' && /TODO/i.test(ctx.replyText || '')) {
        api.note('Agent left TODOs in its last reply - follow up.', { sessionId: ctx.sessionId });
    }
    api.log(\`example hook fired for \${ctx.event} (agent: \${ctx.agent?.name || 'none'})\`);
}
`, 'utf8');
        }
    }
    bootstrap();

    // ── Config / secrets ────────────────────────────────────────────────────
    function normalizeConfig(raw) {
        const cfg = isObj(raw) ? raw : {};
        cfg.version = cfg.version || 1;
        cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
        if (!cfg.providers.some(p => p.id === 'bedrock' || p.preset === 'bedrock')) {
            const bp = PROVIDER_PRESETS.bedrock;
            const insertIdx = cfg.providers.findIndex(p => p.id === 'agentrouter');
            const bedrockEntry = {
                id: 'bedrock',
                name: bp.name,
                type: bp.type,
                preset: 'bedrock',
                region: bp.region,
                baseUrl: bp.baseUrl,
                enabled: true,
                models: [...bp.models],
                headers: {}
            };
            if (insertIdx >= 0) cfg.providers.splice(insertIdx + 1, 0, bedrockEntry);
            else cfg.providers.unshift(bedrockEntry);
        }
        cfg.providers.forEach(p => {
            p.id = String(p.id || uid('prov')).replace(/[^a-zA-Z0-9_\-]/g, '');
            p.type = p.type || 'openai';
            p.models = Array.isArray(p.models) ? p.models.map(String).filter(Boolean) : [];
            p.headers = isObj(p.headers) ? p.headers : {};
            p.enabled = p.enabled !== false;
            delete p.hasKey;
            delete p.keyPreview;
            delete p.noKey;
            delete p.keyUrl;
            delete p.apiKey;
            delete p.key;
        });
        cfg.agents = Array.isArray(cfg.agents) && cfg.agents.length ? cfg.agents : clone(DEFAULT_AGENTS);
        cfg.agents.forEach(a => {
            a.id = String(a.id || uid('agent')).replace(/[^a-zA-Z0-9_\-]/g, '');
            a.tools = Array.isArray(a.tools) ? a.tools : TOOL_PERMISSIONS.slice(0, 5);
            a.memory = a.memory || 'both';
            if (typeof a.temperature !== 'number') a.temperature = 0.3;
        });
        cfg.settings = deepMerge(DEFAULT_SETTINGS, cfg.settings || {});
        cfg.hooks = Array.isArray(cfg.hooks) ? cfg.hooks : [];
        cfg.hooks.forEach(h => { h.id = h.id || uid('hook'); h.enabled = !!h.enabled; });
        return cfg;
    }

    function getConfig() {
        try {
            const m = fs.statSync(CONFIG_FILE).mtimeMs;
            if (!configCache || m !== configMtime) {
                configCache = normalizeConfig(readJSON(CONFIG_FILE, {}));
                configMtime = m;
            }
        } catch (e) {
            if (!configCache) configCache = normalizeConfig({});
        }
        return configCache;
    }

    function saveConfig(next) {
        const cfg = normalizeConfig(next);
        cfg.$readme = getConfig().$readme;
        writeJSON(CONFIG_FILE, cfg);
        configCache = cfg;
        configMtime = fs.statSync(CONFIG_FILE).mtimeMs;
        emit({ type: 'config', message: 'Configuration saved' });
        return cfg;
    }

    function getSecrets() { return readJSON(SECRETS_FILE, { providers: {} }); }

    const ENV_KEY_MAP = {
        agentrouter: 'AGENTROUTER_API_KEY',
        bedrock: 'AWS_BEARER_TOKEN_BEDROCK',
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        gemini: 'GEMINI_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        groq: 'GROQ_API_KEY',
        mistral: 'MISTRAL_API_KEY',
        xai: 'XAI_API_KEY',
        together: 'TOGETHER_API_KEY'
    };

    function getKey(providerId) {
        const s = getSecrets();
        const key = s.providers?.[providerId]?.apiKey || '';
        if (key) return key;
        const envVar = ENV_KEY_MAP[providerId];
        if (envVar && process.env[envVar] && !process.env[envVar].includes('your-')) {
            return process.env[envVar].trim();
        }
        if (providerId === 'bedrock') {
            return process.env.AWS_BEARER_TOKEN_BEDROCK || process.env.BEDROCK_API_KEY || '';
        }
        if (providerId === 'agentrouter' && legacyKeyPath && fs.existsSync(legacyKeyPath)) {
            const raw = fs.readFileSync(legacyKeyPath, 'utf8');
            return raw.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('sk-')) || '';
        }
        return '';
    }

    function setKey(providerId, apiKey) {
        const s = getSecrets();
        s.providers = s.providers || {};
        const clean = String(apiKey || '').replace(/[\r\n"'\s]/g, '');
        if (clean) s.providers[providerId] = { ...(s.providers[providerId] || {}), apiKey: clean, updatedAt: Date.now() };
        else delete s.providers[providerId];
        writeJSON(SECRETS_FILE, s);
        const envVar = ENV_KEY_MAP[providerId];
        if (envVar) {
            process.env[envVar] = clean;
            try {
                const envFile = path.join(rootDir, '.env');
                if (fs.existsSync(envFile)) {
                    let envText = fs.readFileSync(envFile, 'utf8');
                    const re = new RegExp(`^${envVar}=.*$`, 'm');
                    if (re.test(envText)) {
                        envText = envText.replace(re, `${envVar}=${clean}`);
                    } else {
                        envText = envText.trimEnd() + `\n${envVar}=${clean}\n`;
                    }
                    fs.writeFileSync(envFile, envText, 'utf8');
                }
            } catch (e) {}
        }
        if (providerId === 'agentrouter' && legacyKeyPath && clean) {
            try { fs.writeFileSync(legacyKeyPath, clean, 'utf8'); } catch (e) {}
        }
        emit({ type: 'config', message: `API key ${clean ? 'updated' : 'removed'} for ${providerId}` });
    }

    function publicConfig() {
        const cfg = clone(getConfig());
        cfg.providers.forEach(p => {
            const key = getKey(p.id);
            p.hasKey = !!key;
            p.keyPreview = maskKey(key);
            p.noKey = !!PROVIDER_PRESETS[p.preset || p.id]?.noKey;
            p.keyUrl = PROVIDER_PRESETS[p.preset || p.id]?.keyUrl || '';
        });
        if (cfg.settings?.security?.hookToken) cfg.settings.security.hookToken = '••••••••';
        return cfg;
    }

    // ── Model / agent resolution ────────────────────────────────────────────
    function listModels() {
        const out = [];
        for (const p of getConfig().providers) {
            if (!p.enabled) continue;
            for (const m of p.models) out.push({ id: m, provider: p.id, providerName: p.name, ready: !!(getKey(p.id) || PROVIDER_PRESETS[p.preset || p.id]?.noKey) });
        }
        return out;
    }

    function resolveModel(modelId) {
        const cfg = getConfig();
        let id = String(modelId || '').trim();
        let forced = null;
        const m = id.match(/^([a-zA-Z0-9_\-]+)::(.+)$/);
        if (m) { forced = m[1]; id = m[2]; }
        const enabled = cfg.providers.filter(p => p.enabled);
        let provider = forced ? enabled.find(p => p.id === forced) : null;
        if (!provider) {
            // Prefer a provider that has this model AND a key, then any provider listing it.
            const listing = enabled.filter(p => p.models.includes(id));
            provider = listing.find(p => getKey(p.id) || PROVIDER_PRESETS[p.preset || p.id]?.noKey) || listing[0] || null;
        }
        if (!provider) provider = enabled.find(p => p.type === 'agentrouter') || { id: 'agentrouter', type: 'agentrouter', name: 'Agent Router', baseUrl: 'https://agentrouter.org/v1', models: [], headers: {} };
        return { provider, model: id, key: getKey(provider.id) };
    }

    function getAgent(agentId) {
        const cfg = getConfig();
        return cfg.agents.find(a => a.id === agentId) || null;
    }

    // ── Memory ──────────────────────────────────────────────────────────────
    function loadLTM() { const d = readJSON(LTM_FILE, { entries: [] }); d.entries = Array.isArray(d.entries) ? d.entries : []; return d; }
    function loadSTM() {
        const d = readJSON(STM_FILE, { entries: [] });
        d.entries = Array.isArray(d.entries) ? d.entries : [];
        const now = Date.now();
        const before = d.entries.length;
        d.entries = d.entries.filter(e => !e.expiresAt || e.expiresAt > now);
        if (d.entries.length !== before) writeJSON(STM_FILE, d);
        return d;
    }

    function remember(text, opts = {}) {
        const t = String(text || '').trim();
        if (!t) throw new Error('Memory text is required');
        const d = loadLTM();
        const dup = d.entries.find(e => e.text.toLowerCase() === t.toLowerCase());
        if (dup) { dup.updatedAt = Date.now(); dup.importance = Math.max(dup.importance || 3, opts.importance || 3); writeJSON(LTM_FILE, d); return dup; }
        const s = getConfig().settings.memory;
        const entry = {
            id: uid('ltm'), text: t,
            tags: Array.isArray(opts.tags) ? opts.tags : (opts.tags ? String(opts.tags).split(',').map(x => x.trim()).filter(Boolean) : []),
            agent: opts.agent || '*',
            project: opts.project || (s.scopeToProject ? getWorkspacePath() : '*'),
            pinned: !!opts.pinned, importance: Math.min(5, Math.max(1, Number(opts.importance) || 3)),
            source: opts.source || 'manual', createdAt: Date.now(), updatedAt: Date.now(), hits: 0
        };
        d.entries.unshift(entry);
        writeJSON(LTM_FILE, d);
        emit({ type: 'memory', message: `Long-term memory saved: "${t.slice(0, 80)}"` });
        if (entry.source !== 'hook') runHooks('onMemoryWrite', { tier: 'long', entry }).catch(() => {});
        return entry;
    }

    function note(text, opts = {}) {
        const t = String(text || '').trim();
        if (!t) throw new Error('Note text is required');
        const s = getConfig().settings.memory;
        const d = loadSTM();
        const ttl = Number(opts.ttlHours) || s.shortTermTTLHours || 48;
        const entry = { id: uid('stm'), text: t, kind: opts.kind || 'note', agent: opts.agent || '*', sessionId: opts.sessionId || null, createdAt: Date.now(), expiresAt: Date.now() + ttl * 3600 * 1000 };
        d.entries.unshift(entry);
        d.entries = d.entries.slice(0, Math.max(5, s.shortTermMax || 40));
        writeJSON(STM_FILE, d);
        if (entry.kind !== 'turn' && opts.source !== 'hook') runHooks('onMemoryWrite', { tier: 'short', entry }).catch(() => {});
        return entry;
    }

    function scoreEntry(entry, qTokens) {
        const eTokens = tokenize(entry.text + ' ' + (entry.tags || []).join(' '));
        if (!qTokens.length) return 0;
        const set = new Set(eTokens);
        let overlap = 0;
        for (const q of qTokens) if (set.has(q)) overlap += 1; else if (eTokens.some(e => e.startsWith(q) || q.startsWith(e))) overlap += 0.4;
        const ageDays = (Date.now() - (entry.updatedAt || entry.createdAt || Date.now())) / 86400000;
        const recency = 1 / (1 + ageDays / 30);
        return overlap * 2 + (entry.importance || 3) * 0.25 + recency * 0.5 + Math.min(entry.hits || 0, 10) * 0.05;
    }

    function recall(query, { limit = 8, agentId = null, includePinned = true } = {}) {
        const s = getConfig().settings.memory;
        const ws = getWorkspacePath();
        const d = loadLTM();
        const q = tokenize(query);
        const visible = d.entries.filter(e => (e.agent === '*' || !agentId || e.agent === agentId) && (!s.scopeToProject || !e.project || e.project === '*' || e.project === ws));
        const pinned = includePinned ? visible.filter(e => e.pinned) : [];
        const ranked = visible.filter(e => !e.pinned).map(e => ({ e, s: scoreEntry(e, q) })).filter(x => x.s > 1.2 || !q.length).sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.e);
        const used = [...pinned, ...ranked];
        if (used.length) {
            const ids = new Set(used.map(e => e.id));
            d.entries.forEach(e => { if (ids.has(e.id)) { e.hits = (e.hits || 0) + 1; e.lastUsed = Date.now(); } });
            try { writeJSON(LTM_FILE, d); } catch (e) {}
        }
        return { pinned, relevant: ranked };
    }

    function shortTermFor(sessionId, agentId, max = 12) {
        return loadSTM().entries.filter(e => (!sessionId || !e.sessionId || e.sessionId === sessionId) && (e.agent === '*' || !agentId || e.agent === agentId)).slice(0, max);
    }

    function memoryOp(op) {
        const tier = op.tier === 'short' ? 'short' : 'long';
        const file = tier === 'short' ? STM_FILE : LTM_FILE;
        const d = tier === 'short' ? loadSTM() : loadLTM();
        const find = () => d.entries.find(e => e.id === op.id);
        switch (op.op) {
            case 'add': return tier === 'short' ? note(op.text, op) : remember(op.text, op);
            case 'update': { const e = find(); if (!e) throw new Error('Entry not found'); ['text', 'tags', 'agent', 'pinned', 'importance', 'project'].forEach(k => { if (op[k] !== undefined) e[k] = op[k]; }); e.updatedAt = Date.now(); writeJSON(file, d); return e; }
            case 'pin': { const e = find(); if (!e) throw new Error('Entry not found'); e.pinned = !e.pinned; writeJSON(file, d); return e; }
            case 'delete': { d.entries = d.entries.filter(e => e.id !== op.id); writeJSON(file, d); return { deleted: op.id }; }
            case 'promote': { const s = loadSTM(); const e = s.entries.find(x => x.id === op.id); if (!e) throw new Error('Entry not found'); const ltm = remember(e.text, { agent: e.agent, source: 'promoted' }); s.entries = s.entries.filter(x => x.id !== op.id); writeJSON(STM_FILE, s); return ltm; }
            case 'clear': { d.entries = op.keepPinned ? d.entries.filter(e => e.pinned) : []; writeJSON(file, d); return { cleared: tier }; }
            default: throw new Error(`Unknown memory op "${op.op}"`);
        }
    }

    // ── Context builder (persona + memory + hook injections) ───────────────
    async function buildContext({ agentId, userText, sessionId, model }) {
        const cfg = getConfig();
        const agent = getAgent(agentId || cfg.settings.chat.defaultAgent);
        const ms = cfg.settings.memory;
        const parts = [];
        const used = { pinned: 0, relevant: 0, short: 0, hooks: 0 };

        if (agent) {
            parts.push(`## ACTIVE AGENT: ${agent.emoji || ''} ${agent.name}\n${agent.systemPrompt || ''}`.trim());
            const denied = TOOL_PERMISSIONS.filter(t => !(agent.tools || []).includes(t));
            if (denied.length) parts.push(`Agent permission policy: you are NOT allowed to ${denied.map(d => ({ read: 'read files', write: 'write or modify files', terminal: 'run terminal commands', search: 'search the codebase', memory: 'write memory', delegate: 'delegate to other agents' }[d])).join(', ')}. If the user asks for this, explain that this agent lacks the permission and suggest switching agents.`);
        }

        const toneKey = cfg.settings?.general?.agentTone || 'default';
        const customTone = String(cfg.settings?.general?.customTonePrompt || '').trim();
        const toneInstruction = toneKey === 'custom' ? customTone : (TONE_INSTRUCTIONS[toneKey] || '');
        if (toneInstruction) {
            parts.push(`## IDE COMMUNICATION TONE\n${toneInstruction}`);
        }

        if (ms.enabled && (!agent || agent.memory !== 'none')) {
            const wantLong = !agent || agent.memory === 'both' || agent.memory === 'long';
            const wantShort = !agent || agent.memory === 'both' || agent.memory === 'short';
            if (wantLong) {
                const { pinned, relevant } = recall(userText, { limit: ms.longTermTopK || 8, agentId: agent?.id, includePinned: ms.injectPinned });
                used.pinned = pinned.length; used.relevant = relevant.length;
                if (pinned.length || relevant.length) {
                    parts.push(`## LONG-TERM MEMORY (durable facts — trust these)\n${[...pinned.map(e => `• [PINNED] ${e.text}`), ...relevant.map(e => `• ${e.text}`)].join('\n')}`);
                }
            }
            if (wantShort) {
                const st = shortTermFor(sessionId, agent?.id, 12);
                used.short = st.length;
                if (st.length) parts.push(`## SHORT-TERM MEMORY (recent working context, newest first)\n${st.map(e => `• [${e.kind}] ${e.text}`).join('\n')}`);
            }
            if (ms.inlineDirectives && (!agent || (agent.tools || []).includes('memory'))) {
                parts.push('Memory directives: to store a durable fact/decision/preference write `[[remember: <fact>]]` on its own line; for temporary working notes write `[[note: <text>]]`. These lines are captured automatically and hidden from the user.');
            }
        }

        const injected = await runHooks('beforeChat', { agent, model, userText, sessionId });
        if (injected.length) { used.hooks = injected.length; parts.push(`## CONTEXT FROM HOOKS\n${injected.join('\n')}`); }

        return {
            agent,
            block: parts.length ? `\n\n═══ AGENT STUDIO CONTEXT ═══\n${parts.join('\n\n')}\n═══ END STUDIO CONTEXT ═══\n` : '',
            temperature: agent?.temperature,
            maxTokens: agent?.maxTokens || 0,
            used
        };
    }

    // ── After-chat processing (directives, auto-capture, hooks, stats) ─────
    const DIRECTIVE_RE = /\[\[(remember|note)\s*:\s*([^\]]+?)\]\]/gi;
    function stripDirectives(text) { return String(text || '').replace(DIRECTIVE_RE, '').replace(/\n{3,}/g, '\n\n'); }

    async function afterChat({ agentId, sessionId, userText, replyText, model, provider, ms, ok, error }) {
        const cfg = getConfig();
        const agent = getAgent(agentId);
        const mem = cfg.settings.memory;
        const captured = { remembered: 0, noted: 0 };
        try {
            if (mem.enabled && mem.inlineDirectives && replyText) {
                for (const m of String(replyText).matchAll(DIRECTIVE_RE)) {
                    if (m[1].toLowerCase() === 'remember') { remember(m[2], { agent: '*', source: `agent:${agentId || 'default'}` }); captured.remembered++; }
                    else { note(m[2], { sessionId, agent: agentId || '*' }); captured.noted++; }
                }
            }
            if (mem.enabled && mem.autoCapture && ok && userText) {
                const u = String(userText).replace(/\s+/g, ' ').trim().slice(0, 220);
                const r = stripDirectives(replyText).replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim().slice(0, 260);
                note(`User asked: "${u}" → ${agent ? agent.name : 'Agent'} replied: "${r}"`, { kind: 'turn', sessionId, agent: agentId || '*' });
            }
        } catch (e) { console.warn('[Studio] afterChat memory error:', e.message); }

        record({ type: ok ? 'chat' : 'error', agent: agent?.name || agentId || 'default', model, provider, ms, ok, chars: (replyText || '').length, message: ok ? `${(replyText || '').length} chars` : (error || 'error') });
        runHooks(ok ? 'afterChat' : 'onError', { agent, model, userText, replyText, sessionId, error }).catch(() => {});
        return captured;
    }

    // ── Hooks runtime ───────────────────────────────────────────────────────
    function renderTemplate(tpl, ctx) {
        const now = new Date();
        const vars = { datetime: now.toLocaleString(), date: now.toDateString(), workspace: getWorkspacePath(), agent: ctx.agent?.name || 'none', model: ctx.model || '', user: (ctx.userText || '').slice(0, 300) };
        return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
    }

    const hookApi = {
        remember: (t, o) => remember(t, { ...o, source: 'hook' }),
        note: (t, o) => note(t, { ...o, source: 'hook' }),
        recall: (q, l) => recall(q, { limit: l || 8 }),
        log: (msg) => record({ type: 'hook', message: String(msg).slice(0, 300) }),
        config: () => publicConfig()
    };

    async function runOneHook(h, event, ctx) {
        const sec = getConfig().settings.security;
        const payload = { event, workspace: getWorkspacePath(), ...ctx, agent: ctx.agent ? { id: ctx.agent.id, name: ctx.agent.name } : null };
        if (h.type === 'inject') return renderTemplate(h.template, ctx);
        if (h.type === 'webhook') {
            if (!/^https?:\/\//i.test(h.url || '')) throw new Error('Webhook URL must start with http(s)://');
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), event === 'beforeChat' ? 3000 : 8000);
            try {
                const r = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(h.headers || {}) }, body: JSON.stringify(payload), signal: ctrl.signal });
                const txt = await r.text();
                try { const j = JSON.parse(txt); return j.inject || null; } catch (e) { return null; }
            } finally { clearTimeout(t); }
        }
        if (h.type === 'script') {
            if (!sec.allowScriptHooks) throw new Error('Script hooks are disabled in Settings → Security');
            const file = path.normalize(path.join(HOOKS_DIR, h.file || ''));
            if (!file.startsWith(HOOKS_DIR) || !fs.existsSync(file)) throw new Error(`Hook script not found: studio/hooks/${h.file}`);
            const mod = await import(pathToFileURL(file).href + `?v=${fs.statSync(file).mtimeMs}`);
            const fn = mod[event] || mod.default;
            if (typeof fn !== 'function') return null;
            const out = await Promise.race([fn(payload, hookApi), new Promise((_, rej) => setTimeout(() => rej(new Error('Hook timed out (5s)')), 5000))]);
            return typeof out === 'string' ? out : (out && out.inject) || null;
        }
        return null;
    }

    async function runHooks(event, ctx = {}, onlyId = null) {
        const hooks = getConfig().hooks.filter(h => (onlyId ? h.id === onlyId : h.enabled) && (h.event === event || (event.startsWith('custom:') && h.event === 'custom' && (!h.match || event === `custom:${h.match}`))));
        const injected = [];
        for (const h of hooks) {
            const t0 = Date.now();
            try {
                const out = await runOneHook(h, event, ctx);
                if (out) injected.push(String(out));
                record({ type: 'hook', message: `${h.name} (${event}) ✓`, ms: Date.now() - t0, ok: true });
            } catch (e) {
                record({ type: 'hook', message: `${h.name} (${event}) ✗ ${e.message}`, ms: Date.now() - t0, ok: false });
                if (onlyId) throw e;
            }
        }
        return injected;
    }

    // ── Provider calls ──────────────────────────────────────────────────────
    function providerHeaders(provider, key) {
        const h = { 'Content-Type': 'application/json', ...(provider.headers || {}) };
        if (key) h.Authorization = `Bearer ${key}`;
        if (provider.preset === 'anthropic' || provider.id === 'anthropic') { if (key) h['x-api-key'] = key; h['anthropic-version'] = '2023-06-01'; }
        if (provider.preset === 'openrouter' || provider.id === 'openrouter') { h['HTTP-Referer'] = 'http://localhost'; h['X-Title'] = 'Agent Studio'; }
        return h;
    }

    function baseUrl(provider) { return String(provider.baseUrl || '').replace(/\/+$/, ''); }

    function supportsTemperature(provider, modelId) {
        if (!provider || provider.type === 'agentrouter') return false;
        return !/(^o[134]|gpt-5|gpt-6|reasoner|deepseek\.r1|deepseek-r1)/i.test(String(modelId || ''));
    }

    /** Non-streaming completion through any configured provider. Returns { text, usage, ms }. */
    async function complete({ model, messages, temperature, maxTokens, timeoutMs }) {
        const { provider, model: m, key } = resolveModel(model);
        const t0 = Date.now();
        const timeout = timeoutMs || (getConfig().settings.runtime.requestTimeoutSec || 90) * 1000;
        if (provider.type === 'agentrouter') {
            if (!key) throw new Error('No Agent Router key. Add one in Studio → Providers.');
            const payload = { model: m, messages, ...(maxTokens ? { max_tokens: maxTokens } : {}) };
            const r = await agentRouterPost(payload, key, timeout);
            let j; try { j = JSON.parse(r.body); } catch (e) { throw new Error(`Agent Router HTTP ${r.status}: ${String(r.body).slice(0, 200)}`); }
            if (j.error || r.status !== 200) throw new Error(`[${provider.name} ${r.status}] ${j.error?.message || 'request failed'}`);
            return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || null, ms: Date.now() - t0, provider: provider.id, model: m };
        }
        if (!key && !PROVIDER_PRESETS[provider.preset || provider.id]?.noKey) throw new Error(`No API key for ${provider.name}. Add one in Studio → Providers.`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
            const allowTemp = supportsTemperature(provider, m) && typeof temperature === 'number';
            const body = { model: m, messages, stream: false, ...(allowTemp ? { temperature } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) };
            let r = await fetch(`${baseUrl(provider)}/chat/completions`, { method: 'POST', headers: providerHeaders(provider, key), body: JSON.stringify(body), signal: ctrl.signal });
            let txt = await r.text();
            if (r.status === 400 && body.temperature !== undefined && /temperature/i.test(txt)) {
                delete body.temperature;
                r = await fetch(`${baseUrl(provider)}/chat/completions`, { method: 'POST', headers: providerHeaders(provider, key), body: JSON.stringify(body), signal: ctrl.signal });
                txt = await r.text();
            }
            let j; try { j = JSON.parse(txt); } catch (e) { throw new Error(`${provider.name} HTTP ${r.status}: ${txt.slice(0, 200)}`); }
            if (!r.ok || j.error) throw new Error(`[${provider.name} ${r.status}] ${j.error?.message || j.message || 'request failed'}`);
            return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || null, ms: Date.now() - t0, provider: provider.id, model: m };
        } finally { clearTimeout(timer); }
    }

    /**
     * Stream a chat completion from a generic OpenAI-compatible provider straight
     * into an SSE response. Resolves with the full assistant text.
     */
    async function streamToResponse({ provider, model, key, messages, temperature, maxTokens }, req, res) {
        const timeout = (getConfig().settings.runtime.requestTimeoutSec || 90) * 1000;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        req.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
        const sendChunk = (content, finish = null, reasoning = null) => res.write(`data: ${JSON.stringify({ id: 'studio-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { ...(content ? { content } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finish }] })}\n\n`);
        let full = '';
        try {
            if (!key && !PROVIDER_PRESETS[provider.preset || provider.id]?.noKey) throw new Error(`No API key configured for ${provider.name}. Open Agent Studio → Providers to add one.`);
            const allowTemp = supportsTemperature(provider, model) && typeof temperature === 'number';
            const body = { model, messages, stream: true, ...(allowTemp ? { temperature } : {}), ...(maxTokens ? { max_tokens: maxTokens } : {}) };
            let r = await fetch(`${baseUrl(provider)}/chat/completions`, { method: 'POST', headers: providerHeaders(provider, key), body: JSON.stringify(body), signal: ctrl.signal });
            if (r.status === 400 && body.temperature !== undefined) {
                const errTxt = await r.text();
                if (/temperature/i.test(errTxt)) {
                    delete body.temperature;
                    r = await fetch(`${baseUrl(provider)}/chat/completions`, { method: 'POST', headers: providerHeaders(provider, key), body: JSON.stringify(body), signal: ctrl.signal });
                } else {
                    let msg = errTxt; try { const j = JSON.parse(errTxt); msg = j.error?.message || j.message || errTxt; } catch (e) {}
                    throw new Error(`[${provider.name} ${r.status}]: ${String(msg).slice(0, 400)}`);
                }
            }
            if (!r.ok) {
                const txt = await r.text();
                let msg = txt; try { const j = JSON.parse(txt); msg = j.error?.message || j.message || txt; } catch (e) {}
                throw new Error(`[${provider.name} ${r.status}]: ${String(msg).slice(0, 400)}`);
            }
            const decoder = new TextDecoder();
            let buf = '';
            for await (const chunk of r.body) {
                buf += decoder.decode(chunk, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop() || '';
                for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const data = t.slice(5).trim();
                    if (data === '[DONE]') continue;
                    try {
                        const j = JSON.parse(data);
                        const delta = j.choices?.[0]?.delta || {};
                        const thinkPiece = delta.reasoning_content || delta.thinking || '';
                        const piece = delta.content || '';
                        if (thinkPiece) sendChunk(null, null, thinkPiece);
                        if (piece) { full += piece; sendChunk(piece); }
                    } catch (e) {}
                }
            }
            res.write(`data: ${JSON.stringify({ id: 'usage-' + Date.now(), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: 0, completion_tokens: Math.round(full.length / 4), total_tokens: Math.round(full.length / 4) } })}\n\n`);
            res.write('data: [DONE]\n\n');
            return { ok: true, text: full };
        } catch (e) {
            const msg = e.name === 'AbortError' ? `${provider.name} request timed out or was cancelled` : e.message;
            if (!res.writableEnded) { sendChunk(`\n\n${msg}\n`, 'stop'); res.write('data: [DONE]\n\n'); }
            return { ok: false, text: full, error: msg };
        } finally {
            clearTimeout(timer);
            if (!res.writableEnded) res.end();
        }
    }

    async function testProvider(providerId) {
        const p = getConfig().providers.find(x => x.id === providerId);
        if (!p) throw new Error('Provider not found');
        const key = getKey(p.id);
        const t0 = Date.now();
        if (p.type === 'agentrouter') {
            const model = p.models[0] || 'gpt-5.6-sol';
            const r = await complete({ model: `${p.id}::${model}`, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], timeoutMs: 30000 });
            return { ok: true, ms: Date.now() - t0, sample: r.text.slice(0, 60), models: null };
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
            const r = await fetch(`${baseUrl(p)}/models`, { headers: providerHeaders(p, key), signal: ctrl.signal });
            const txt = await r.text();
            if (!r.ok) { let msg = txt; try { msg = JSON.parse(txt).error?.message || txt; } catch (e) {} throw new Error(`HTTP ${r.status}: ${String(msg).slice(0, 200)}`); }
            let models = [];
            try { const j = JSON.parse(txt); models = (j.data || j.models || []).map(m => (m.id || m.name || '').replace(/^models\//, '')).filter(Boolean); } catch (e) {}
            return { ok: true, ms: Date.now() - t0, models: models.slice(0, 300) };
        } finally { clearTimeout(timer); }
    }

    // ── Activity log ────────────────────────────────────────────────────────
    function record(evt) {
        const e = { ts: Date.now(), ...evt };
        activity.unshift(e);
        if (activity.length > 400) activity.length = 400;
        if (e.type === 'chat' || e.type === 'error') {
            stats.requests++;
            if (!e.ok) stats.errors++;
            if (e.model) stats.byModel[e.model] = (stats.byModel[e.model] || 0) + 1;
            if (e.agent) stats.byAgent[e.agent] = (stats.byAgent[e.agent] || 0) + 1;
            if (e.ms) stats.latencyTotal += e.ms;
        }
        try {
            fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n');
            const st = fs.statSync(LOG_FILE);
            if (st.size > 2 * 1024 * 1024) {
                const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n');
                fs.writeFileSync(LOG_FILE, lines.slice(-2000).join('\n') + '\n');
            }
        } catch (err) {}
        emit(e);
    }
    function emit(e) { for (const fn of listeners) { try { fn(e); } catch (err) {} } }

    // ── Universal hook endpoint dispatcher (/api/studio/hook) ───────────────
    async function dispatch(action, p = {}) {
        switch (action) {
            case 'ping': return { pong: true, studio: getConfig().settings.general.studioName, time: Date.now() };
            case 'memory.remember': return remember(p.text, { ...p, source: p.source || 'hook-api' });
            case 'memory.note': return note(p.text, p);
            case 'memory.recall': return recall(p.query || '', { limit: p.limit || 8, agentId: p.agent || null });
            case 'memory.list': return p.tier === 'short' ? loadSTM().entries : loadLTM().entries;
            case 'memory.forget': return memoryOp({ op: 'delete', tier: p.tier || 'long', id: p.id });
            case 'agents.list': return getConfig().agents.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, model: a.model, description: a.description }));
            case 'models.list': return listModels();
            case 'agent.run': return runAgent(p);
            case 'config.get': return publicConfig();
            case 'settings.get': return getConfig().settings;
            case 'settings.set': {
                if (!p.path) throw new Error('path is required, e.g. "editor.fontSize"');
                const cfg = clone(getConfig());
                const keys = String(p.path).split('.');
                let o = cfg.settings;
                while (keys.length > 1) { const k = keys.shift(); o[k] = isObj(o[k]) ? o[k] : {}; o = o[k]; }
                o[keys[0]] = p.value;
                return saveConfig(cfg).settings;
            }
            case 'event.emit': return { injected: await runHooks(`custom:${p.event || 'event'}`, { data: p.data }) };
            case 'log': record({ type: 'hook', message: String(p.message || '').slice(0, 300) }); return { ok: true };
            default: throw new Error(`Unknown action "${action}". Try: ping, memory.remember, memory.note, memory.recall, memory.list, memory.forget, agents.list, models.list, agent.run, config.get, settings.get, settings.set, event.emit, log`);
        }
    }

    async function runAgent({ agent: agentId, prompt, model, sessionId, withMemory = true }) {
        if (!prompt) throw new Error('prompt is required');
        const agent = getAgent(agentId) || getAgent(getConfig().settings.chat.defaultAgent);
        const useModel = model || agent?.model || getConfig().settings.runtime.fallbackModel;
        const ctx = withMemory ? await buildContext({ agentId: agent?.id, userText: prompt, sessionId, model: useModel }) : { block: '', temperature: agent?.temperature };
        const messages = [{ role: 'system', content: `You are an AI agent inside Agent Studio.${ctx.block}` }, { role: 'user', content: prompt }];
        const t0 = Date.now();
        try {
            const r = await complete({ model: useModel, messages, temperature: ctx.temperature, maxTokens: agent?.maxTokens || 0 });
            await afterChat({ agentId: agent?.id, sessionId, userText: prompt, replyText: r.text, model: useModel, provider: r.provider, ms: Date.now() - t0, ok: true });
            return { agent: agent?.id, model: useModel, provider: r.provider, ms: r.ms, text: stripDirectives(r.text), usage: r.usage };
        } catch (e) {
            await afterChat({ agentId: agent?.id, sessionId, userText: prompt, replyText: '', model: useModel, ms: Date.now() - t0, ok: false, error: e.message });
            throw e;
        }
    }

    async function consolidateMemory({ model } = {}) {
        const st = loadSTM().entries;
        if (!st.length) return { added: 0, message: 'Short-term memory is empty.' };
        const existing = loadLTM().entries.slice(0, 60).map(e => `- ${e.text}`).join('\n');
        const useModel = model || getConfig().settings.runtime.fallbackModel;
        const prompt = `You maintain an AI coding agent's long-term memory.\n\nEXISTING LONG-TERM MEMORY:\n${existing || '(empty)'}\n\nRECENT SHORT-TERM MEMORY:\n${st.map(e => `- ${e.text}`).join('\n')}\n\nExtract at most 8 NEW durable facts worth remembering for future sessions (project conventions, architecture decisions, user preferences, recurring problems and their fixes, environment details). Skip anything trivial, temporary or already present. Respond ONLY with a JSON array of objects: [{"text": "...", "tags": ["..."], "importance": 1-5}]`;
        const r = await complete({ model: useModel, messages: [{ role: 'user', content: prompt }], temperature: 0.2 });
        const m = r.text.match(/\[[\s\S]*\]/);
        let items = [];
        try { items = m ? JSON.parse(m[0]) : []; } catch (e) { throw new Error('Model did not return valid JSON: ' + r.text.slice(0, 160)); }
        const added = [];
        for (const it of items.slice(0, 8)) if (it && it.text) added.push(remember(it.text, { tags: it.tags, importance: it.importance, source: 'consolidation' }));
        record({ type: 'memory', message: `Consolidated ${added.length} long-term memories from ${st.length} short-term entries`, ok: true, ms: r.ms });
        return { added: added.length, entries: added };
    }

    // ── @studio/ virtual path mapping for the IDE file APIs ─────────────────
    function resolveStudioPath(relPath) {
        if (!relPath || !/^@studio[\\/]/.test(relPath)) return null;
        const sub = relPath.replace(/^@studio[\\/]+/, '');
        const full = path.normalize(path.join(STUDIO_DIR, sub));
        if (!full.startsWith(STUDIO_DIR)) return null;
        const base = path.basename(full).toLowerCase();
        if (base === 'secrets.json' || base === '.router_key' || base === '.studio_auth_token') return null;
        return full;
    }

    function studioFiles() {
        const out = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name.endsWith('.tmp') || e.name === 'secrets.json' || e.name.startsWith('.')) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else out.push({ path: '@studio/' + path.relative(STUDIO_DIR, full).replace(/\\/g, '/'), size: fs.statSync(full).size });
            }
        };
        try { walk(STUDIO_DIR); } catch (e) {}
        return out;
    }

    function state() {
        const ltm = loadLTM().entries;
        const stm = loadSTM().entries;
        return {
            config: publicConfig(),
            presets: Object.fromEntries(Object.entries(PROVIDER_PRESETS).map(([k, v]) => [k, { name: v.name, baseUrl: v.baseUrl, models: v.models, noKey: !!v.noKey, keyUrl: v.keyUrl || '' }])),
            hookEvents: HOOK_EVENTS, toolPermissions: TOOL_PERMISSIONS,
            memory: { long: ltm.length, pinned: ltm.filter(e => e.pinned).length, short: stm.length },
            stats: { ...stats, avgLatency: stats.requests ? Math.round(stats.latencyTotal / stats.requests) : 0, uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000) },
            files: studioFiles(),
            workspace: getWorkspacePath(),
            studioDir: STUDIO_DIR
        };
    }

    function resetSection(what) {
        const cfg = clone(getConfig());
        if (what === 'agents') cfg.agents = clone(DEFAULT_AGENTS);
        else if (what === 'settings') cfg.settings = clone(DEFAULT_SETTINGS);
        else if (what === 'hooks') cfg.hooks = clone(DEFAULT_HOOKS);
        else if (what === 'memory') { writeJSON(LTM_FILE, { entries: [] }); writeJSON(STM_FILE, { entries: [] }); return { reset: 'memory' }; }
        else throw new Error('Unknown section');
        saveConfig(cfg);
        return { reset: what };
    }

    return {
        STUDIO_DIR, getConfig, saveConfig, publicConfig, getKey, setKey, listModels, resolveModel, getAgent,
        remember, note, recall, memoryOp, loadLTM, loadSTM, consolidateMemory,
        buildContext, afterChat, stripDirectives, runHooks, complete, streamToResponse, testProvider, runAgent,
        dispatch, record, activity, stats, state, resolveStudioPath, resetSection, PROVIDER_PRESETS,
        getMasterToken: () => masterToken,
        onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }
    };
}
