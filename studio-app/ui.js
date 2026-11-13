// ═══════════════════════════════════════════════════════════════════════════
//  AGENT STUDIO — Client UI & IDE Bridge (/__studio/ui.js)
//  Shortcut: Ctrl+Shift+A (Studio)  ·  Ctrl+, (Settings)  ·  Ctrl+Shift+M (Memory)
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const S = {
    state: null,
    memory: { long: [], short: [] },
    activity: [],
    tab: 'providers',
    selectedAgentId: localStorage.getItem('studio_active_agent') || 'builder',
    editingAgentId: 'builder',
    memTier: 'long',
    memSearch: '',
    arenaModels: ['gpt-5.6-sol', 'gpt-6-astra'],
    arenaResults: null,
    arenaRunning: false
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtAgo = (ts) => {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  async function api(path, body) {
    const r = await fetch(path, body !== undefined ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    } : undefined);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j?.error?.message || `HTTP ${r.status}`);
    return j;
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById('studio-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'studio-toast';
      el.className = 'studio-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  // ── Intercept fetch('/api/chat') so active agent + session_id are always sent ─
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input?.url || '');
      if (url.endsWith('/api/chat') && init && typeof init.body === 'string') {
        const body = JSON.parse(init.body);
        if (!body.agent) body.agent = S.selectedAgentId;
        if (!body.session_id && typeof activeSessionId !== 'undefined') body.session_id = activeSessionId;
        // Support @agentName prefix in user prompt for 1-turn specialist routing
        const msgs = body.messages || [];
        const last = msgs[msgs.length - 1];
        if (last && last.role === 'user' && typeof last.content === 'string') {
          const m = last.content.match(/^@([a-zA-Z0-9_\-]+)\s+([\s\S]+)$/);
          if (m && S.state?.config?.agents?.some(a => a.id.toLowerCase() === m[1].toLowerCase())) {
            const ag = S.state.config.agents.find(a => a.id.toLowerCase() === m[1].toLowerCase());
            body.agent = ag.id;
            last.content = m[2];
          }
        }
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch (e) {}
    return origFetch(input, init);
  };

  // ── Open any @studio/... file right inside Monaco Editor ──────────────────
  window.openStudioFileInIDE = async function (relPath) {
    closeStudio();
    if (typeof window.openFile === 'function') {
      await window.openFile(relPath, true);
      toast(`Opened ${relPath} in editor`);
    }
  };

  const IDE_THEME_PRESETS = {
    obsidian:  { label: 'Obsidian Midnight', bgBase: '#0a0c10', bgSidebar: '#0f1219', bgEditor: '#0c0e14', bgCard: '#151922', borderColor: '#232838', accent: '#3b82f6', replyColor: '#38bdf8', thinkingColor: '#a78bfa', light: false },
    cyberpunk: { label: 'Cyberpunk Neon',    bgBase: '#070510', bgSidebar: '#0d091c', bgEditor: '#090614', bgCard: '#16102c', borderColor: '#3b2170', accent: '#f43f5e', replyColor: '#22d3ee', thinkingColor: '#f472b6', light: false },
    emerald:   { label: 'Emerald Matrix',    bgBase: '#040d08', bgSidebar: '#07160e', bgEditor: '#05100a', bgCard: '#0c2217', borderColor: '#16442c', accent: '#10b981', replyColor: '#34d399', thinkingColor: '#fbbf24', light: false },
    amethyst:  { label: 'Royal Amethyst',    bgBase: '#0b0714', bgSidebar: '#120c21', bgEditor: '#0e091a', bgCard: '#1b1230', borderColor: '#312154', accent: '#8b5cf6', replyColor: '#c084fc', thinkingColor: '#38bdf8', light: false },
    amber:     { label: 'Solarized Gold',    bgBase: '#0d0a05', bgSidebar: '#161108', bgEditor: '#100c06', bgCard: '#211a0d', borderColor: '#3d3019', accent: '#f59e0b', replyColor: '#fbbf24', thinkingColor: '#fb923c', light: false },
    crimson:   { label: 'Crimson Velvet',    bgBase: '#100608', bgSidebar: '#18090d', bgEditor: '#13070a', bgCard: '#250e14', borderColor: '#421924', accent: '#ef4444', replyColor: '#f87171', thinkingColor: '#c084fc', light: false },
    nord:      { label: 'Nordic Frost',      bgBase: '#191d24', bgSidebar: '#1e222a', bgEditor: '#1b1f27', bgCard: '#242933', borderColor: '#333b4a', accent: '#88c0d0', replyColor: '#81a1c1', thinkingColor: '#b48ead', light: false },
    daylight:  { label: 'Daylight Clean',    bgBase: '#f1f5f9', bgSidebar: '#e2e8f0', bgEditor: '#ffffff', bgCard: '#ffffff', borderColor: '#cbd5e1', accent: '#2563eb', replyColor: '#0284c7', thinkingColor: '#7c3aed', light: true }
  };

  function applyWholeIDETheme(g = {}) {
    const preset = IDE_THEME_PRESETS[g.themePreset] || IDE_THEME_PRESETS.obsidian;
    const bgBase = g.bgBase || preset.bgBase;
    const bgSidebar = g.bgSidebar || preset.bgSidebar;
    const bgEditor = g.bgEditor || preset.bgEditor;
    const bgCard = g.bgCard || preset.bgCard;
    const borderColor = g.borderColor || preset.borderColor;
    const accent = g.accent || preset.accent || '#3b82f6';
    const replyColor = g.replyColor || preset.replyColor || '#38bdf8';
    const thinkingColor = g.thinkingColor || preset.thinkingColor || '#a78bfa';
    const isLight = preset.light === true || g.themePreset === 'daylight';

    const root = document.documentElement;
    root.style.setProperty('--bg-base', bgBase);
    root.style.setProperty('--bg-sidebar', bgSidebar);
    root.style.setProperty('--bg-editor', bgEditor);
    root.style.setProperty('--bg-card', bgCard);
    root.style.setProperty('--bg-card-hover', bgCard);
    root.style.setProperty('--border', borderColor);
    root.style.setProperty('--border-subtle', borderColor);
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--studio-accent', accent);
    root.style.setProperty('--studio-bg', isLight ? '#f8fafc' : bgBase);
    root.style.setProperty('--studio-panel', isLight ? '#f1f5f9' : bgSidebar);
    root.style.setProperty('--studio-card', isLight ? '#ffffff' : bgCard);
    root.style.setProperty('--studio-text', isLight ? '#0f172a' : '#f1f5f9');
    root.style.setProperty('--studio-dim', isLight ? '#334155' : '#94a3b8');
    root.style.setProperty('--studio-muted', isLight ? '#64748b' : '#64748b');
    root.style.setProperty('--studio-border', isLight ? '#cbd5e1' : borderColor);
    root.style.setProperty('--ide-reply-color', replyColor);
    root.style.setProperty('--ide-thinking-color', thinkingColor);
    root.style.setProperty('--text', isLight ? '#0f172a' : '#e6e9f0');
    root.style.setProperty('--text-muted', isLight ? '#334155' : '#8c93a8');
    root.style.setProperty('--text-dim', isLight ? '#475569' : '#545c73');

    document.body.classList.toggle('ide-theme-light', isLight);
    document.documentElement.classList.toggle('ide-theme-light', isLight);
    window.__coworkCollapseThinkingDefault = !!g.collapseThinking;

    let styleTag = document.getElementById('studio-dynamic-theme-style');
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'studio-dynamic-theme-style';
      document.head.appendChild(styleTag);
    }
    styleTag.textContent = `
      body, .workspace-split, .chat-pane, .editor-pane { background-color: ${bgBase} !important; color: ${isLight ? '#0f172a' : '#f1f5f9'} !important; }
      .app-header, .pane-header, .history-sidebar, .file-explorer-sidebar, .mobile-bottom-nav { background-color: ${bgSidebar} !important; border-color: ${borderColor} !important; }
      #editor-main-stage, #monaco-container, .monaco-editor, .monaco-editor-background, .monaco-editor .margin { background-color: ${bgEditor} !important; }
      .chat-input-wrapper, .agent-activity-box, .chat-code-block { background-color: ${bgCard} !important; border-color: ${borderColor} !important; }
      .msg-row.user .msg-content { border-color: ${accent}55 !important; }
      .agent-final-reply { border-left: 3px solid ${replyColor} !important; background: ${isLight ? 'rgba(2,132,199,0.06)' : 'rgba(15, 23, 42, 0.55)'} !important; color: ${isLight ? '#0f172a' : '#f8fafc'} !important; }
      .agent-final-reply-badge { color: ${replyColor} !important; }
      .agent-thinking-dropdown { border-color: ${thinkingColor}55 !important; background: ${isLight ? 'rgba(124,58,237,0.06)' : 'rgba(124, 92, 255, 0.08)'} !important; }
      .agent-thinking-dropdown summary { color: ${thinkingColor} !important; }
      .agent-thinking-body { color: ${thinkingColor}dd !important; border-top-color: ${thinkingColor}33 !important; }
      ${isLight ? `
        body.ide-theme-light .brand-title, body.ide-theme-light .brand-title span { color: #0f172a !important; }
        body.ide-theme-light .header-controls .btn-sm { background: #ffffff !important; border-color: #cbd5e1 !important; color: #0f172a !important; }
        body.ide-theme-light .history-sidebar, body.ide-theme-light .file-explorer-sidebar { color: #0f172a !important; }
        body.ide-theme-light .history-session-item, body.ide-theme-light .file-node-row { color: #1e293b !important; }
        body.ide-theme-light .msg-row .msg-content { color: #0f172a !important; }
        body.ide-theme-light .markdown-body, body.ide-theme-light .markdown-body * { color: #0f172a; }
        body.ide-theme-light .markdown-body pre, body.ide-theme-light .markdown-body code { color: #0f172a; }
        body.ide-theme-light .chat-input { color: #0f172a !important; }
        body.ide-theme-light .studio-shell { background: #f8fafc !important; color: #0f172a !important; border-color: #cbd5e1 !important; }
        body.ide-theme-light .studio-card { background: #ffffff !important; border-color: #cbd5e1 !important; color: #0f172a !important; }
        body.ide-theme-light .studio-section-title, body.ide-theme-light .studio-card strong { color: #0f172a !important; }
        body.ide-theme-light .studio-section-desc, body.ide-theme-light .studio-label { color: #334155 !important; }
        body.ide-theme-light .studio-accordion { background: #ffffff !important; border-color: #cbd5e1 !important; }
        body.ide-theme-light .studio-accordion-summary { background: #f8fafc !important; color: #0f172a !important; }
        body.ide-theme-light .studio-accordion-title, body.ide-theme-light .studio-accordion-title strong { color: #0f172a !important; }
        body.ide-theme-light .studio-accordion-title span { color: #334155 !important; }
        body.ide-theme-light .studio-chip-toggle { background: #ffffff !important; border-color: #cbd5e1 !important; color: #0f172a !important; }
        body.ide-theme-light .studio-chip-toggle span { color: #0f172a !important; }
        body.ide-theme-light .studio-brand-title { color: #0f172a !important; }
      ` : ''}
    `;

    if (window.monaco && window.monaco.editor) {
      try { window.monaco.editor.setTheme(isLight ? 'vs' : 'vs-dark'); } catch (e) {}
    }
  }
  window.applyWholeIDETheme = applyWholeIDETheme;

  // ── Sync settings to Monaco Editor, Model Dropdown & Header Badges ────────
  function applySettingsToIDE() {
    if (!S.state?.config) return;
    const { settings, agents, providers } = S.state.config;

    // 1. Whole-IDE Theme, Accent & Compact mode
    applyWholeIDETheme(settings?.general || {});
    document.body.classList.toggle('studio-compact', !!settings?.general?.compactMode);

    // 2. Brand title
    const brandSpan = document.querySelector('.brand-title span:last-child');
    if (brandSpan && settings?.general?.studioName) {
      brandSpan.textContent = settings.general.studioName;
    }

    // 3. Monaco Editor live options
    const ed = window.editor;
    if (ed && typeof ed.updateOptions === 'function' && settings?.editor) {
      const eo = settings.editor;
      ed.updateOptions({
        fontSize: Number(eo.fontSize) || 13,
        tabSize: Number(eo.tabSize) || 2,
        wordWrap: eo.wordWrap || 'on',
        minimap: { enabled: !!eo.minimap },
        lineNumbers: eo.lineNumbers || 'on',
        fontLigatures: !!eo.fontLigatures,
        renderWhitespace: eo.renderWhitespace || 'selection',
        cursorBlinking: eo.cursorBlinking || 'smooth',
        smoothScrolling: !!eo.smoothScrolling
      });
    }

    // 4. Populate IDE #model-select with all enabled providers & models
    const modelSel = document.getElementById('model-select');
    if (modelSel && Array.isArray(providers)) {
      const currentVal = modelSel.value || localStorage.getItem('cowork_selected_model') || 'gpt-5.6-sol';
      const groupsHtml = providers.filter(p => p.enabled && p.models?.length).map(p => {
        const status = (p.hasKey || p.noKey) ? 'Ready' : 'No Key';
        const opts = p.models.map(m => `<option value="${esc(m)}">${esc(m)} · ${esc(p.name)}</option>`).join('');
        return `<optgroup label="${esc(p.name)} (${status})">${opts}</optgroup>`;
      }).join('') + `<option value="custom">Custom model ID...</option>`;
      modelSel.innerHTML = groupsHtml;
      if ([...modelSel.options].some(o => o.value === currentVal)) modelSel.value = currentVal;
    }

    // 5. Populate chat dock agent selector
    const agSel = document.getElementById('studio-dock-agent');
    if (agSel && Array.isArray(agents)) {
      agSel.innerHTML = agents.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
      if (agents.some(a => a.id === S.selectedAgentId)) agSel.value = S.selectedAgentId;
    }

    // 6. Update header memory badge
    const memBadge = document.getElementById('studio-hdr-mem-count');
    if (memBadge && S.state.memory) {
      memBadge.textContent = `${S.state.memory.long}L · ${S.state.memory.short}S`;
    }
  }

  // ── Mount Header Buttons, Chat Dock Agent Switcher & Modal Shell ──────────
  function mountIDEChrome() {
    const hdrControls = document.querySelector('.header-controls');
    if (hdrControls && !document.getElementById('studio-open-btn')) {
      const wrap = document.createElement('span');
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '5px';
      wrap.className = 'studio-hdr-actions';
      wrap.innerHTML = `
        <button class="btn-sm studio-settings-pill" id="studio-hdr-settings-btn" onclick="openAgentStudio('settings')" title="Open All IDE & Agent Studio Settings (Ctrl+,)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg><span>Settings</span>
        </button>
        <button class="btn-sm studio-launch-btn" id="studio-open-btn" onclick="openAgentStudio('providers')" title="Open Full Agent Studio Command Center (Ctrl+Shift+A)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg><span>Agent Studio</span>
        </button>
        <button class="btn-sm studio-mem-pill" id="studio-hdr-mem-pill" onclick="openAgentStudio('memory')" title="Open Long-Term & Short-Term Agent Memory Studio (Ctrl+Shift+M)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg><span id="studio-hdr-mem-count">0L · 0S</span>
        </button>
        <button class="btn-sm studio-cfg-pill" onclick="openStudioFileInIDE('@studio/studio.config.json')" title="Open studio/studio.config.json directly in the Monaco editor to inspect or edit all providers, agents, hooks and settings">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span>studio.config</span>
        </button>
        <span class="hdr-btn-divider" style="width: 1px; height: 16px; background: rgba(255, 255, 255, 0.1); margin: 0 3px; display: inline-block;"></span>
      `;
      hdrControls.prepend(wrap);
    }

    // Add Agent Persona selector next to model selector in the chat input dock
    const inputLeft = document.querySelector('.input-bottom-left');
    if (inputLeft && !document.getElementById('studio-dock-agent')) {
      const pill = document.createElement('div');
      pill.className = 'studio-agent-select-wrap';
      pill.title = 'Active Agent Persona (changes system prompt, memory scope, temperature & allowed tools). Tip: type @agentName at the start of a message for 1-turn routing.';
      pill.innerHTML = `
        <select id="studio-dock-agent" class="studio-agent-select"></select>
      `;
      inputLeft.insertBefore(pill, inputLeft.children[1] || null);
      pill.querySelector('select').addEventListener('change', (e) => {
        selectActiveAgent(e.target.value);
      });
    }

    // Create Modal Shell
    if (!document.getElementById('studio-backdrop')) {
      const bd = document.createElement('div');
      bd.id = 'studio-backdrop';
      bd.className = 'studio-backdrop';
      bd.addEventListener('click', (e) => { if (e.target === bd) closeStudio(); });
      bd.innerHTML = `
        <div class="studio-shell" role="dialog" aria-label="Agent Studio">
          <div class="studio-topbar">
            <div class="studio-brand">
              <button type="button" class="studio-btn studio-menu-toggle" id="studio-menu-toggle" onclick="toggleStudioDrawer()" title="Open Studio Navigation Menu">
                <span class="studio-menu-icon" style="font-size:11px;font-weight:700;">MENU</span>
                <span class="studio-active-tab-badge" id="studio-active-tab-badge">Guide</span>
                <span class="studio-menu-arrow">▾</span>
              </button>
              <div class="studio-brand-badge">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
              </div>
              <div class="studio-brand-info">
                <div class="studio-brand-title">Agent Studio</div>
                <div class="studio-brand-sub">Command Center · Specialist Agents · Dual-Tier Memory · Settings</div>
              </div>
            </div>
            <div class="studio-top-actions">
              <details class="studio-files-dropdown" id="studio-quick-files-dropdown">
                <summary class="studio-btn studio-dropdown-trigger" title="Quick edit Studio configuration files in Monaco">
                  <span class="studio-quick-files-text">Files ▾</span>
                </summary>
                <div class="studio-dropdown-menu">
                  <button type="button" class="studio-dropdown-item" onclick="openStudioFileInIDE('@studio/studio.config.json'); closeQuickFilesDropdown();">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><span>Edit studio.config.json</span>
                  </button>
                  <button type="button" class="studio-dropdown-item" onclick="openStudioFileInIDE('@studio/memory/long_term.json'); closeQuickFilesDropdown();">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/></svg><span>Edit long_term.json</span>
                  </button>
                  <button type="button" class="studio-dropdown-item" onclick="openStudioFileInIDE('@studio/hook.mjs'); closeQuickFilesDropdown();">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg><span>Open hook.mjs</span>
                  </button>
                </div>
              </details>
              <button class="studio-btn danger studio-close-btn" onclick="closeStudio()" title="Close Studio (Esc)" aria-label="Close Studio">
                <span class="studio-close-icon">✕</span><span class="studio-close-label"> Close</span>
              </button>
            </div>
          </div>
          <div class="studio-body">
            <div class="studio-nav-backdrop" id="studio-nav-backdrop" onclick="closeStudioDrawer()"></div>
            <nav class="studio-nav" id="studio-nav"></nav>
            <main class="studio-main" id="studio-main"></main>
          </div>
        </div>
      `;
      document.body.appendChild(bd);
    }
  }

  function selectActiveAgent(agentId) {
    S.selectedAgentId = agentId;
    localStorage.setItem('studio_active_agent', agentId);
    const ag = S.state?.config?.agents?.find(a => a.id === agentId);
    if (ag) {
      if (ag.model && typeof window.switchModel === 'function') {
        window.switchModel(ag.model);
      }
      toast(`Active agent: ${ag.name} (${ag.model})`);
    }
    const sel = document.getElementById('studio-dock-agent');
    if (sel && sel.value !== agentId) sel.value = agentId;
  }
  window.selectActiveAgent = selectActiveAgent;

  // ── Load State & Memory from Backend ──────────────────────────────────────
  async function refreshStudio(renderAfter = true) {
    try {
      const [st, mem, act] = await Promise.all([
        api('/api/studio/state'),
        api('/api/studio/memory'),
        api('/api/studio/activity')
      ]);
      S.state = st;
      S.memory = mem;
      S.activity = act.activity || [];
      if (!S.state.config.agents.some(a => a.id === S.editingAgentId)) {
        S.editingAgentId = S.state.config.agents[0]?.id || 'builder';
      }
      applySettingsToIDE();
      if (renderAfter && document.getElementById('studio-backdrop')?.classList.contains('open')) {
        renderStudio();
      }
    } catch (e) {
      console.warn('[Agent Studio] refresh warning:', e.message);
    }
  }

  window.openAgentStudio = async function (tab) {
    if (tab) S.tab = tab;
    mountIDEChrome();
    const bd = document.getElementById('studio-backdrop');
    if (bd) {
      bd.classList.add('open');
      const main = document.getElementById('studio-main');
      if (main && !S.state) {
        main.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#94a3b8;gap:8px;">
          <div class="studio-spinner"></div> Loading Agent Studio...
        </div>`;
      }
    }
    await refreshStudio(true);
  };

  window.toggleStudioDrawer = function () {
    const nav = document.getElementById('studio-nav');
    const bd = document.getElementById('studio-nav-backdrop');
    if (!nav) return;
    const open = nav.classList.toggle('mobile-open');
    if (bd) bd.classList.toggle('open', open);
  };

  window.closeStudioDrawer = function () {
    const nav = document.getElementById('studio-nav');
    const bd = document.getElementById('studio-nav-backdrop');
    if (nav) nav.classList.remove('mobile-open');
    if (bd) bd.classList.remove('open');
  };

  window.closeStudio = function () {
    window.closeStudioDrawer();
    window.closeQuickFilesDropdown();
    document.getElementById('studio-backdrop')?.classList.remove('open');
  };

  window.closeQuickFilesDropdown = function () {
    const d = document.getElementById('studio-quick-files-dropdown');
    if (d) d.open = false;
  };

  window.AgentStudio = {
    open: function (tab) { return window.openAgentStudio(tab || 'providers'); },
    close: function () { return window.closeStudio(); },
    refresh: function (render) { return refreshStudio(render); },
    getState: function () { return S.state; }
  };

  // ── Navigation Sidebar ────────────────────────────────────────────────────
  
  function getTabIcon(id) {
    switch (id) {
      case 'providers': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>';
      case 'skills': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
      case 'settings': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
      case 'guide': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
      case 'agents': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
      case 'memory': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/></svg>';
      case 'hooks': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
      case 'arena': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg>';
      case 'activity': return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px;"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
      default: return '';
    }
  }

  function renderStudio() {
    if (!S.state) return;
    const nav = document.getElementById('studio-nav');
    const main = document.getElementById('studio-main');
    if (!nav || !main) return;

    const cfg = S.state.config;
    const readyProviders = cfg.providers.filter(p => p.enabled && (p.hasKey || p.noKey)).length;
    const tabs = [
      { id: 'providers', icon: '', label: 'Providers & APIs', badge: `${readyProviders}/${cfg.providers.length}` },
      { id: 'skills',    icon: '', label: 'Skills Hub (ADK)', badge: 'Skills' },
      { id: 'settings',  icon: '', label: 'All Settings', badge: 'Tweak' },
      { id: 'guide',     icon: '', label: 'User Guide & Docs', badge: 'Guide' },
      { id: 'agents',    icon: '', label: 'Agents & Personas', badge: cfg.agents.length },
      { id: 'memory',    icon: '', label: 'Memory (LTM + STM)', badge: `${S.memory.long.length}/${S.memory.short.length}` },
      { id: 'hooks',     icon: '', label: 'Agent Hooks & SDK', badge: cfg.hooks.filter(h => h.enabled).length },
      { id: 'arena',     icon: '', label: 'Multi-Model Arena', badge: 'Live' },
      { id: 'activity',  icon: '', label: 'Activity & Files', badge: S.activity.length }
    ];

    const currentTab = tabs.find(t => t.id === S.tab) || tabs[0];
    const activeBadge = document.getElementById('studio-active-tab-badge');
    if (activeBadge) {
      activeBadge.textContent = currentTab.label.split(' ')[0];
    }

    nav.innerHTML = `
      <div class="studio-drawer-header">
        <div style="display:flex;align-items:center;gap:7px;font-weight:700;font-size:13.5px;">
          <span>Studio Navigation</span>
        </div>
        <button type="button" class="studio-btn" onclick="closeStudioDrawer()" title="Close Menu" style="padding:2px 8px;font-size:13px;border-radius:6px;font-weight:700;">✕</button>
      </div>
    ` + tabs.map(t => `
      <button class="studio-nav-btn ${S.tab === t.id ? 'active' : ''}" data-tab="${t.id}">
        <span>${getTabIcon(t.id)}${esc(t.label)}</span>
        <span class="studio-nav-count">${esc(t.badge)}</span>
      </button>
    `).join('') + `
      <div class="studio-nav-footer">
        <div><strong>Active Agent:</strong> ${esc(cfg.agents.find(a => a.id === S.selectedAgentId)?.name || S.selectedAgentId)}</div>
        <div><strong>Shortcuts:</strong></div>
        <div><code>Ctrl+Shift+A</code> Studio</div>
        <div><code>Ctrl+,</code> Settings</div>
        <div><code>Ctrl+Shift+H</code> User Guide</div>
        <div><code>Ctrl+Shift+M</code> Memory</div>
      </div>
    `;

    nav.querySelectorAll('.studio-nav-btn').forEach(btn => {
      btn.onclick = () => {
        S.tab = btn.dataset.tab;
        window.closeStudioDrawer();
        renderStudio();
      };
    });

    if (S.tab === 'providers') renderProvidersTab(main);
    else if (S.tab === 'skills') renderSkillsTab(main);
    else if (S.tab === 'settings') renderSettingsTab(main);
    else if (S.tab === 'guide') renderGuideTab(main);
    else if (S.tab === 'agents') renderAgentsTab(main);
    else if (S.tab === 'memory') renderMemoryTab(main);
    else if (S.tab === 'hooks') renderHooksTab(main);
    else if (S.tab === 'arena') renderArenaTab(main);
    else if (S.tab === 'activity') renderActivityTab(main);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB: SKILLS HUB & ADK PROGRESSIVE DISCLOSURE
  // ═══════════════════════════════════════════════════════════════════════════
  async function renderSkillsTab(main) {
    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">Skills Hub &amp; ADK Playbooks</h2>
          <p class="studio-section-desc">
            Based on the Google Agent Development Kit (ADK) progressive disclosure architecture: skills store full instructions, scripts, and workflows in <code>skills/&lt;name&gt;/SKILL.md</code>.
            Only compact YAML frontmatter (~50 tokens) is injected into the context window, leaving 99% of your token budget free.
            The agent autonomously calls <code>read_skill</code> on demand when a task requires that skill.
          </p>
        </div>
        <div class="studio-row">
          <button class="studio-btn primary" id="studio-skill-teach-btn">Teach New Skill</button>
          <button class="studio-btn" id="studio-skill-refresh-btn">Refresh</button>
        </div>
      </div>

      <!-- Teach Skill Inline Card (hidden by default) -->
      <div class="studio-card" id="studio-skill-edit-card" style="display:none;margin-bottom:14px;background:#161b22;border:1px solid #38bdf8;">
        <h3 style="margin:0 0 10px 0;font-size:14px;color:#38bdf8;display:flex;align-items:center;gap:6px;">
          <span id="studio-skill-form-title">Teach Agent a New Skill</span>
        </h3>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="display:grid;grid-template-columns:200px 1fr;gap:10px;">
            <div>
              <label style="font-size:11px;font-weight:700;color:#94a3b8;display:block;margin-bottom:3px;">SKILL SLUG</label>
              <input id="studio-skill-name-input" class="studio-input" placeholder="e.g. docker-deploy, db-migrate" style="font-family:monospace;">
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:#94a3b8;display:block;margin-bottom:3px;">PROGRESSIVE DISCLOSURE DESCRIPTION</label>
              <input id="studio-skill-desc-input" class="studio-input" placeholder="One clear sentence explaining when and why the agent should activate this skill.">
            </div>
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;color:#94a3b8;display:block;margin-bottom:3px;">PLAYBOOK &amp; INSTRUCTIONS (Markdown)</label>
            <textarea id="studio-skill-content-input" class="studio-input" style="height:160px;font-family:monospace;font-size:12px;resize:vertical;" placeholder="# Skill Playbook&#10;&#10;Step 1: Check environment...&#10;Step 2: Execute command..."></textarea>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button class="studio-btn" id="studio-skill-cancel-btn">Cancel</button>
            <button class="studio-btn primary" id="studio-skill-save-btn">Save Playbook</button>
          </div>
        </div>
      </div>

      <!-- Skills Cards List -->
      <div id="studio-skills-list-container">
        <div style="text-align:center;padding:32px;color:#94a3b8;">Loading workspace skills...</div>
      </div>
    `;

    const editCard = main.querySelector('#studio-skill-edit-card');
    const teachBtn = main.querySelector('#studio-skill-teach-btn');
    const refreshBtn = main.querySelector('#studio-skill-refresh-btn');
    const cancelBtn = main.querySelector('#studio-skill-cancel-btn');
    const saveBtn = main.querySelector('#studio-skill-save-btn');
    const nameInput = main.querySelector('#studio-skill-name-input');
    const descInput = main.querySelector('#studio-skill-desc-input');
    const contentInput = main.querySelector('#studio-skill-content-input');
    const container = main.querySelector('#studio-skills-list-container');

    teachBtn.onclick = () => {
      editCard.style.display = 'block';
      nameInput.value = '';
      descInput.value = '';
      contentInput.value = '';
      nameInput.focus();
    };

    cancelBtn.onclick = () => {
      editCard.style.display = 'none';
    };

    async function loadSkills() {
      container.innerHTML = '<div style="text-align:center;padding:32px;color:#94a3b8;">Loading workspace skills...</div>';
      try {
        const res = await fetch('/api/skills');
        const data = await res.json();
        const skills = data.skills || [];
        if (skills.length === 0) {
          container.innerHTML = `
            <div class="studio-card" style="text-align:center;padding:36px;color:#94a3b8;">
              
              <strong style="color:#f1f5f9;font-size:14px;">No Workspace Skills Found</strong>
              <p style="font-size:12px;margin-top:6px;max-width:440px;margin-left:auto;margin-right:auto;">
                Teach your agent reusable workflows or CLI playbooks. Click "Teach New Skill" above or use <code>/learn</code> in chat.
              </p>
            </div>
          `;
          return;
        }

        container.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:12px;">
            ${skills.map(s => `
              <div class="studio-card" style="display:flex;flex-direction:column;justify-content:space-between;gap:10px;">
                <div>
                  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
                    <strong style="font-family:monospace;color:#38bdf8;font-size:14px;">${esc(s.name)}</strong>
                    <span class="studio-badge" style="font-size:10px;">ADK Skill</span>
                  </div>
                  <div style="font-size:12px;color:#cbd5e1;line-height:1.45;margin-bottom:8px;">${esc(s.description)}</div>
                  <div style="font-size:11px;color:#64748b;font-family:monospace;">${esc(s.relativePath || s.path)}</div>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:6px;border-top:1px solid #30363d;padding-top:8px;">
                  <button class="studio-btn" data-edit-skill="${esc(s.name)}">Edit Playbook</button>
                  <button class="studio-btn" data-del-skill="${esc(s.name)}" style="color:#f87171;">Delete</button>
                </div>
              </div>
            `).join('')}
          </div>
        `;

        container.querySelectorAll('[data-edit-skill]').forEach(btn => {
          btn.onclick = async () => {
            const skillName = btn.dataset.editSkill;
            try {
              const r = await fetch(`/api/skills/get?name=${encodeURIComponent(skillName)}`);
              const d = await r.json();
              if (d.success && d.skill) {
                editCard.style.display = 'block';
                nameInput.value = d.skill.name;
                descInput.value = d.skill.description || '';
                contentInput.value = d.skill.body || d.skill.raw || '';
                editCard.scrollIntoView({ behavior: 'smooth' });
              }
            } catch (e) { toast('Error loading skill: ' + e.message); }
          };
        });

        container.querySelectorAll('[data-del-skill]').forEach(btn => {
          btn.onclick = async () => {
            const skillName = btn.dataset.delSkill;
            if (!confirm(`Delete skill "${skillName}"?`)) return;
            try {
              const r = await fetch('/api/skills/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: skillName })
              });
              const d = await r.json();
              if (d.success) {
                toast(`Deleted skill "${skillName}"`);
                loadSkills();
              }
            } catch (e) { toast('Error deleting skill: ' + e.message); }
          };
        });
      } catch (e) {
        container.innerHTML = `<div class="studio-card" style="color:#f87171;">Failed to load skills: ${esc(e.message)}</div>`;
      }
    }

    refreshBtn.onclick = () => loadSkills();

    saveBtn.onclick = async () => {
      const name = nameInput.value.trim();
      const description = descInput.value.trim();
      const instructions = contentInput.value.trim();
      if (!name) { toast('Skill name is required'); return; }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, instructions })
        });
        const data = await res.json();
        if (data.success) {
          toast(`✓ Saved skill "${data.skill.name}"`);
          editCard.style.display = 'none';
          loadSkills();
        } else {
          toast('Failed: ' + (data.error?.message || 'Error'));
        }
      } catch (e) {
        toast('Error: ' + e.message);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Playbook';
      }
    };

    loadSkills();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB 1: PROVIDERS & API KEYS
  // ═══════════════════════════════════════════════════════════════════════════
  function renderProvidersTab(main) {
    const { providers } = S.state.config;
    const presets = S.state.presets || {};
    const unusedPresets = Object.keys(presets).filter(k => !providers.some(p => p.id === k));

    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">API Providers, Endpoints & Keys</h2>
          <p class="studio-section-desc">Switch or combine Agent Router, OpenAI, Anthropic, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, Ollama, or any custom OpenAI-compatible endpoint. Keys are stored locally in <code>studio/secrets.json</code> (never exposed unmasked).</p>
        </div>
        <div class="studio-row">
          <select id="studio-add-preset" class="studio-select" style="width:190px;">
            <option value="">+ Add provider preset...</option>
            ${unusedPresets.map(k => `<option value="${esc(k)}">${esc(presets[k].name)}</option>`).join('')}
            <option value="custom">+ Custom OpenAI Provider</option>
          </select>
          <button class="studio-btn primary" id="studio-add-prov-btn">+ Add Provider</button>
        </div>
      </div>

      <div class="studio-grid">
        ${providers.map((p, idx) => `
          <div class="studio-card ${p.enabled && (p.hasKey || p.noKey) ? 'highlight' : ''}" data-prov-idx="${idx}">
            <div class="studio-between">
              <div class="studio-row">
                <input type="checkbox" class="prov-enabled" ${p.enabled ? 'checked' : ''} title="Enable provider">
                <strong style="font-size:13.5px;">${esc(p.name)}</strong>
                <span class="studio-badge ${p.hasKey || p.noKey ? 'ok' : 'warn'}">${p.noKey ? 'Local (No key needed)' : (p.hasKey ? `Key: ${esc(p.keyPreview)}` : 'No API key')}</span>
              </div>
              <div class="studio-row">
                ${p.keyUrl ? `<a href="${esc(p.keyUrl)}" target="_blank" class="studio-btn" style="text-decoration:none;padding:4px 8px;font-size:10.5px;">Get Key ↗</a>` : ''}
                <button class="studio-btn prov-test-btn" data-id="${esc(p.id)}">Test</button>
                ${p.id !== 'agentrouter' ? `<button class="studio-btn danger prov-del-btn" data-idx="${idx}" title="Remove provider">x</button>` : ''}
              </div>
            </div>

            ${!p.noKey ? `
              <div>
                <label class="studio-label">${p.id === 'bedrock' || p.preset === 'bedrock' ? 'AWS Bedrock API Key / Bearer Token (AWS_BEARER_TOKEN_BEDROCK)' : `API Key (${p.hasKey ? 'saved — paste new key to replace' : 'not set'})`}</label>
                <div class="studio-row" style="flex-wrap:nowrap;">
                  <input type="password" class="studio-input studio-mono prov-key-input" placeholder="${p.hasKey ? esc(p.keyPreview) : (p.id === 'bedrock' || p.preset === 'bedrock' ? 'Paste AWS Bedrock Bearer Token or Access Key...' : 'Paste sk-... or API key')}">
                  <button class="studio-btn primary prov-save-key" data-id="${esc(p.id)}">Save Key</button>
                  ${p.hasKey ? `<button class="studio-btn danger prov-clear-key" data-id="${esc(p.id)}" title="Clear saved key">Clear</button>` : ''}
                </div>
              </div>
            ` : ''}

            <details class="studio-accordion" style="margin-top:8px;border-radius:8px;">
              <summary class="studio-accordion-summary" style="padding:7px 10px;">
                <div class="studio-accordion-title" style="font-size:11.5px;">
                  <strong>Endpoint, Models & Region Settings</strong>
                  <span class="studio-badge" style="font-size:9.5px;">${(p.models || []).length} models</span>
                </div>
                <span class="studio-accordion-chevron">▾</span>
              </summary>
              <div class="studio-accordion-content" style="padding:10px;">
                ${(p.id === 'bedrock' || p.preset === 'bedrock') ? `
                  <div>
                    <label class="studio-label">AWS Bedrock Region (auto-updates endpoint & model prefix)</label>
                    <select class="studio-select prov-region" data-idx="${idx}">
                      ${['us-east-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'ap-northeast-1', 'ap-southeast-1'].map(reg => `
                        <option value="${reg}" ${(p.region || (p.baseUrl || '').match(/bedrock-runtime\.([a-z0-9\-]+)\.amazonaws/)?.[1] || 'us-east-1') === reg ? 'selected' : ''}>${reg}</option>
                      `).join('')}
                    </select>
                  </div>
                ` : ''}

                <div>
                  <label class="studio-label">Base URL</label>
                  <input type="text" class="studio-input studio-mono prov-url" value="${esc(p.baseUrl || '')}">
                </div>

                <div>
                  <label class="studio-label">Models (comma-separated — shown in IDE model picker)</label>
                  <input type="text" class="studio-input studio-mono prov-models" value="${esc((p.models || []).join(', '))}">
                </div>

                <div class="studio-between" style="margin-top:2px;">
                  <span class="prov-status" style="font-size:11px;color:var(--studio-dim);">id: <code>${esc(p.id)}</code></span>
                  <button class="studio-btn success prov-save-cfg" data-idx="${idx}">Save Provider</button>
                </div>
              </div>
            </details>
          </div>
        `).join('')}
      </div>
    `;

    // Wire events
    main.querySelector('#studio-add-prov-btn').onclick = async () => {
      const sel = main.querySelector('#studio-add-preset').value || 'custom';
      const preset = S.state.presets[sel] || { name: 'Custom Provider', baseUrl: 'https://api.example.com/v1', models: ['model-1'] };
      const id = sel === 'custom' ? ('custom_' + Date.now().toString(36).slice(-4)) : sel;
      const next = [...S.state.config.providers, {
        id, name: preset.name, type: 'openai', preset: sel,
        baseUrl: preset.baseUrl, enabled: true, models: [...(preset.models || [])], headers: {}
      }];
      await api('/api/studio/config', { providers: next });
      toast(`Added ${preset.name}`);
      await refreshStudio(true);
    };

    main.querySelectorAll('.prov-save-key').forEach(btn => {
      btn.onclick = async () => {
        const card = btn.closest('.studio-card');
        const val = card.querySelector('.prov-key-input').value.trim();
        if (!val) return toast('Paste an API key first');
        await api('/api/studio/secret', { providerId: btn.dataset.id, apiKey: val });
        toast(`Saved API key for ${btn.dataset.id}`);
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.prov-clear-key').forEach(btn => {
      btn.onclick = async () => {
        await api('/api/studio/secret', { providerId: btn.dataset.id, apiKey: '' });
        toast(`Cleared key for ${btn.dataset.id}`);
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.prov-region').forEach(sel => {
      sel.onchange = () => {
        const card = sel.closest('.studio-card');
        const urlIn = card.querySelector('.prov-url');
        const reg = sel.value;
        if (urlIn) urlIn.value = `https://bedrock-runtime.${reg}.amazonaws.com/openai/v1`;
      };
    });

    main.querySelectorAll('.prov-save-cfg').forEach(btn => {
      btn.onclick = async () => {
        const idx = Number(btn.dataset.idx);
        const card = btn.closest('.studio-card');
        const regSel = card.querySelector('.prov-region');
        const next = [...S.state.config.providers];
        next[idx] = {
          ...next[idx],
          ...(regSel ? { region: regSel.value } : {}),
          enabled: card.querySelector('.prov-enabled').checked,
          baseUrl: card.querySelector('.prov-url').value.trim(),
          models: card.querySelector('.prov-models').value.split(',').map(s => s.trim()).filter(Boolean)
        };
        await api('/api/studio/config', { providers: next });
        toast(`Saved ${next[idx].name}`);
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.prov-del-btn').forEach(btn => {
      btn.onclick = async () => {
        const idx = Number(btn.dataset.idx);
        const next = S.state.config.providers.filter((_, i) => i !== idx);
        await api('/api/studio/config', { providers: next });
        toast('Provider removed');
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.prov-test-btn').forEach(btn => {
      btn.onclick = async () => {
        const card = btn.closest('.studio-card');
        const st = card.querySelector('.prov-status');
        st.textContent = 'Testing connection...';
        try {
          const r = await api('/api/studio/provider/test', { providerId: btn.dataset.id });
          st.innerHTML = `<span style="color:#6ee7b7;">✓ Connected (${r.ms}ms)${r.models?.length ? ` · ${r.models.length} models found` : ''}</span>`;
          toast(`Connected in ${r.ms}ms`);
        } catch (e) {
          st.innerHTML = `<span style="color:#fca5a5;">✗ ${esc(e.message)}</span>`;
        }
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB 2: AGENTS & PERSONAS
  // ═══════════════════════════════════════════════════════════════════════════
  function renderAgentsTab(main) {
    const { agents } = S.state.config;
    const allModels = S.state.config.providers.flatMap(p => p.models || []);
    const ag = agents.find(a => a.id === S.editingAgentId) || agents[0];
    const perms = S.state.toolPermissions || ['read', 'write', 'terminal', 'search', 'memory', 'delegate'];

    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">Specialist Agents & Personas</h2>
          <p class="studio-section-desc">Create and tune specialist agents with their own system prompt, default model, temperature, memory mode, and tool permissions. Switch agents anytime in the chat dock or prefix a message with <code>@agentId</code>.</p>
        </div>
        <div class="studio-row">
          <button class="studio-btn" id="studio-reset-agents">↺ Reset Defaults</button>
          <button class="studio-btn primary" id="studio-new-agent">+ New Agent</button>
        </div>
      </div>

      <div class="studio-split">
        <div>
          ${agents.map(a => `
            <div class="studio-list-item ${a.id === ag.id ? 'active' : ''}" data-ag="${esc(a.id)}">
              <div class="studio-between">
                <strong>${esc(a.name)}</strong>
                ${a.id === S.selectedAgentId ? '<span class="studio-badge ok">Active</span>' : ''}
              </div>
              <div style="font-size:11px;color:var(--studio-dim);margin-top:3px;">${esc(a.description || '')}</div>
              <div style="font-size:10.5px;color:#93c5fd;margin-top:4px;font-family:monospace;">${esc(a.model)} · mem:${esc(a.memory)}</div>
            </div>
          `).join('')}
        </div>

        <div class="studio-card">
          <div class="studio-between">
            <div class="studio-row">
              <span style="font-size:22px;">[Agent]</span>
              <div>
                <strong style="font-size:15px;">${esc(ag.name)}</strong>
                <div style="font-size:11px;color:var(--studio-dim);">Mention in chat with <code>@${esc(ag.id)}</code></div>
              </div>
            </div>
            <div class="studio-row">
              <button class="studio-btn success" id="ag-use-btn">✓ Set Active in Chat</button>
              ${agents.length > 1 ? `<button class="studio-btn danger" id="ag-del-btn">Delete</button>` : ''}
            </div>
          </div>

          <div style="display:grid;grid-template-columns:90px 1fr 1fr 110px;gap:10px;">
            <div>
              <label class="studio-label">Emoji</label>
              <input class="studio-input" id="ag-emoji" value="[Agent]">
            </div>
            <div>
              <label class="studio-label">Agent ID</label>
              <input class="studio-input studio-mono" id="ag-id" value="${esc(ag.id)}">
            </div>
            <div>
              <label class="studio-label">Display Name</label>
              <input class="studio-input" id="ag-name" value="${esc(ag.name)}">
            </div>
            <div>
              <label class="studio-label">Accent</label>
              <input type="color" class="studio-input" id="ag-color" value="${esc(ag.color || '#38bdf8')}" style="height:33px;padding:2px;">
            </div>
          </div>

          <div>
            <label class="studio-label">Short Description</label>
            <input class="studio-input" id="ag-desc" value="${esc(ag.description || '')}">
          </div>

          <div style="display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:10px;">
            <div>
              <label class="studio-label">Default Model</label>
              <input class="studio-input studio-mono" list="studio-model-datalist" id="ag-model" value="${esc(ag.model || 'gpt-5.6-sol')}">
              <datalist id="studio-model-datalist">
                ${allModels.map(m => `<option value="${esc(m)}"></option>`).join('')}
              </datalist>
            </div>
            <div>
              <label class="studio-label">Temperature (<span id="ag-temp-lbl">${ag.temperature ?? 0.3}</span>)</label>
              <input type="range" min="0" max="1.5" step="0.05" id="ag-temp" value="${ag.temperature ?? 0.3}" style="width:100%;">
            </div>
            <div>
              <label class="studio-label">Memory Access</label>
              <select class="studio-select" id="ag-memory">
                <option value="both" ${ag.memory === 'both' ? 'selected' : ''}>Long + Short-Term</option>
                <option value="long" ${ag.memory === 'long' ? 'selected' : ''}>Long-Term Only</option>
                <option value="short" ${ag.memory === 'short' ? 'selected' : ''}>Short-Term Only</option>
                <option value="none" ${ag.memory === 'none' ? 'selected' : ''}>Stateless (None)</option>
              </select>
            </div>
          </div>

          <div>
            <label class="studio-label">Allowed Workspace Tools</label>
            <div class="studio-row" style="gap:12px;">
              ${perms.map(t => `
                <label style="font-size:12px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                  <input type="checkbox" class="ag-tool-cb" value="${esc(t)}" ${(ag.tools || []).includes(t) ? 'checked' : ''}>
                  <code>${esc(t)}</code>
                </label>
              `).join('')}
            </div>
          </div>

          <div>
            <label class="studio-label">System Prompt / Instructions</label>
            <textarea class="studio-textarea" id="ag-prompt" rows="6">${esc(ag.systemPrompt || '')}</textarea>
          </div>

          <div class="studio-between">
            <div class="studio-row" style="flex:1;">
              <input class="studio-input" id="ag-test-input" placeholder="Quick test prompt for ${esc(ag.name)}..." style="max-width:340px;">
              <button class="studio-btn" id="ag-test-btn">▶ Test Run</button>
            </div>
            <button class="studio-btn primary" id="ag-save-btn">Save Agent</button>
          </div>
          <div id="ag-test-out" class="studio-code" style="display:none;"></div>
        </div>
      </div>
    `;

    main.querySelectorAll('.studio-list-item').forEach(el => {
      el.onclick = () => { S.editingAgentId = el.dataset.ag; renderStudio(); };
    });

    const tempInput = main.querySelector('#ag-temp');
    tempInput.oninput = () => { main.querySelector('#ag-temp-lbl').textContent = tempInput.value; };

    main.querySelector('#ag-use-btn').onclick = () => { selectActiveAgent(ag.id); renderStudio(); };

    main.querySelector('#ag-save-btn').onclick = async () => {
      const updated = {
        ...ag,
        emoji: main.querySelector('#ag-emoji').value.trim() || '',
        id: main.querySelector('#ag-id').value.trim().replace(/[^a-zA-Z0-9_\-]/g, '') || ag.id,
        name: main.querySelector('#ag-name').value.trim() || 'Agent',
        color: main.querySelector('#ag-color').value,
        description: main.querySelector('#ag-desc').value.trim(),
        model: main.querySelector('#ag-model').value.trim() || 'gpt-5.6-sol',
        temperature: parseFloat(main.querySelector('#ag-temp').value) || 0.3,
        memory: main.querySelector('#ag-memory').value,
        tools: [...main.querySelectorAll('.ag-tool-cb:checked')].map(c => c.value),
        systemPrompt: main.querySelector('#ag-prompt').value
      };
      const next = agents.map(a => a.id === ag.id ? updated : a);
      S.editingAgentId = updated.id;
      await api('/api/studio/config', { agents: next });
      toast(`Saved agent ${updated.name}`);
      await refreshStudio(true);
    };

    main.querySelector('#studio-new-agent').onclick = async () => {
      const id = 'agent_' + Date.now().toString(36).slice(-4);
      const next = [...agents, {
        id, name: 'Custom Agent', emoji: '', color: '#38bdf8', model: 'gpt-5.6-sol',
        temperature: 0.3, memory: 'both', tools: ['read', 'write', 'terminal', 'search', 'memory'],
        description: 'Custom specialist agent', systemPrompt: 'You are a helpful specialist agent.'
      }];
      S.editingAgentId = id;
      await api('/api/studio/config', { agents: next });
      await refreshStudio(true);
    };

    const delBtn = main.querySelector('#ag-del-btn');
    if (delBtn) {
      delBtn.onclick = async () => {
        const next = agents.filter(a => a.id !== ag.id);
        S.editingAgentId = next[0]?.id || 'builder';
        await api('/api/studio/config', { agents: next });
        toast(`Deleted ${ag.name}`);
        await refreshStudio(true);
      };
    }

    main.querySelector('#studio-reset-agents').onclick = async () => {
      await api('/api/studio/reset', { what: 'agents' });
      toast('Reset agents to default roster');
      await refreshStudio(true);
    };

    main.querySelector('#ag-test-btn').onclick = async () => {
      const p = main.querySelector('#ag-test-input').value.trim() || 'Introduce yourself and your permissions in 2 sentences.';
      const out = main.querySelector('#ag-test-out');
      out.style.display = 'block';
      out.textContent = `Running ${ag.name}...`;
      try {
        const r = await api('/api/studio/run', { agent: ag.id, prompt: p });
        out.textContent = `[${r.model} · ${r.ms}ms]\n\n${r.text}`;
      } catch (e) {
        out.textContent = `Error: ${e.message}`;
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB 3: MEMORY STUDIO (LONG-TERM + SHORT-TERM)
  // ═══════════════════════════════════════════════════════════════════════════
  function renderMemoryTab(main) {
    const entries = S.memTier === 'long' ? S.memory.long : S.memory.short;
    const q = S.memSearch.toLowerCase().trim();
    const filtered = entries.filter(e => !q || String(e.text).toLowerCase().includes(q) || (e.tags || []).some(t => t.toLowerCase().includes(q)));

    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">Agent Memory Bank (Long-Term & Short-Term)</h2>
          <p class="studio-section-desc">
            <strong>Long-Term Memory</strong> (<code>studio/memory/long_term.json</code>) stores durable architecture facts, rules, and preferences; pinned items are always injected, and relevant items are ranked per prompt.
            <strong>Short-Term Memory</strong> (<code>studio/memory/short_term.json</code>) holds rolling working notes and recent turn summaries with automatic TTL expiry.
            Agents can also write memory inline via <code>[[remember: ...]]</code> and <code>[[note: ...]]</code>.
          </p>
        </div>
        <div class="studio-row">
          <button class="studio-btn" onclick="openStudioFileInIDE('@studio/memory/long_term.json')">Open long_term.json</button>
          <button class="studio-btn" onclick="openStudioFileInIDE('@studio/memory/short_term.json')">Open short_term.json</button>
          <button class="studio-btn primary" id="mem-consolidate-btn" title="Use AI to distill Short-Term working notes into durable Long-Term memories">AI Consolidate STM → LTM</button>
        </div>
      </div>

      <!-- Add Memory Bar -->
      <div class="studio-card" style="margin-bottom:14px;">
        <div style="display:grid;grid-template-columns:150px 1fr 150px 95px auto;gap:8px;align-items:center;">
          <select id="mem-new-tier" class="studio-select">
            <option value="long" ${S.memTier === 'long' ? 'selected' : ''}>Long-Term Fact</option>
            <option value="short" ${S.memTier === 'short' ? 'selected' : ''}>Short-Term Note</option>
          </select>
          <input id="mem-new-text" class="studio-input" placeholder="Add a fact, rule, convention, or working note for your agents...">
          <input id="mem-new-tags" class="studio-input" placeholder="tags (e.g. php,auth)">
          <label style="font-size:12px;display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
            <input type="checkbox" id="mem-new-pin"> Pin
          </label>
          <button class="studio-btn primary" id="mem-add-btn">+ Save Memory</button>
        </div>
      </div>

      <!-- Switcher & Filter -->
      <div class="studio-between" style="margin-bottom:12px;">
        <div class="studio-row">
          <button class="studio-btn ${S.memTier === 'long' ? 'primary' : ''}" id="mem-tab-long">Long-Term (${S.memory.long.length})</button>
          <button class="studio-btn ${S.memTier === 'short' ? 'primary' : ''}" id="mem-tab-short">Short-Term (${S.memory.short.length})</button>
        </div>
        <div class="studio-row">
          <input id="mem-search" class="studio-input" placeholder="Search memories..." value="${esc(S.memSearch)}" style="width:220px;">
          <button class="studio-btn danger" id="mem-clear-btn">Clear ${S.memTier === 'long' ? 'Unpinned LTM' : 'STM'}</button>
        </div>
      </div>

      <!-- Memory List -->
      <div>
        ${filtered.length === 0 ? `<div class="studio-card" style="text-align:center;color:var(--studio-dim);">No ${S.memTier}-term memories yet. Add one above or chat with an agent!</div>` : ''}
        ${filtered.map(e => `
          <div class="studio-mem-item ${e.pinned ? 'pinned' : ''}">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;line-height:1.45;">${e.pinned ? '[Pinned] ' : ''}${esc(e.text)}</div>
              <div class="studio-row" style="margin-top:5px;gap:6px;">
                ${(e.tags || []).map(t => `<span class="studio-badge">#${esc(t)}</span>`).join('')}
                <span style="font-size:10.5px;color:var(--studio-dim);">
                  ${S.memTier === 'long'
                    ? `★${e.importance || 3} · hits:${e.hits || 0} · src:${esc(e.source || 'manual')} · ${fmtAgo(e.updatedAt || e.createdAt)}`
                    : `kind:${esc(e.kind || 'note')} · created ${fmtAgo(e.createdAt)} · expires in ${Math.max(1, Math.round(((e.expiresAt || Date.now()) - Date.now()) / 3600000))}h`}
                </span>
              </div>
            </div>
            <div class="studio-row">
              ${S.memTier === 'long'
                ? `<button class="studio-btn mem-pin-btn" data-id="${esc(e.id)}" title="Toggle pin (pinned memories are always injected)">${e.pinned ? 'Unpin' : 'Pin'}</button>`
                : `<button class="studio-btn success mem-promote-btn" data-id="${esc(e.id)}" title="Promote this short-term note to permanent Long-Term Memory">⬆ Promote to LTM</button>`}
              <button class="studio-btn danger mem-del-btn" data-id="${esc(e.id)}">x</button>
            </div>
          </div>
        `).join('')}
      </div>

      <!-- Live Prompt Context Inspector -->
      <div class="studio-card" style="margin-top:16px;">
        <strong>Live Memory Recall & Prompt Context Preview</strong>
        <p style="font-size:11.5px;color:var(--studio-dim);margin:0;">Test what persona + long/short-term memories + hook injections get added to the system prompt for any user query:</p>
        <div class="studio-row" style="flex-wrap:nowrap;">
          <input id="mem-preview-q" class="studio-input" placeholder="Type a sample user question to test recall ranking...">
          <button class="studio-btn primary" id="mem-preview-btn">Preview Injected Context</button>
        </div>
        <pre id="mem-preview-out" class="studio-code" style="display:none;margin:0;"></pre>
      </div>
    `;

    main.querySelector('#mem-tab-long').onclick = () => { S.memTier = 'long'; renderStudio(); };
    main.querySelector('#mem-tab-short').onclick = () => { S.memTier = 'short'; renderStudio(); };
    main.querySelector('#mem-search').oninput = (e) => { S.memSearch = e.target.value; renderStudio(); };

    main.querySelector('#mem-add-btn').onclick = async () => {
      const tier = main.querySelector('#mem-new-tier').value;
      const text = main.querySelector('#mem-new-text').value.trim();
      const tags = main.querySelector('#mem-new-tags').value.trim();
      const pinned = main.querySelector('#mem-new-pin').checked;
      if (!text) return toast('Enter memory text first');
      await api('/api/studio/memory', { op: 'add', tier, text, tags, pinned });
      S.memTier = tier;
      toast(`Saved to ${tier}-term memory`);
      await refreshStudio(true);
    };

    main.querySelectorAll('.mem-pin-btn').forEach(btn => {
      btn.onclick = async () => {
        await api('/api/studio/memory', { op: 'pin', tier: 'long', id: btn.dataset.id });
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.mem-promote-btn').forEach(btn => {
      btn.onclick = async () => {
        await api('/api/studio/memory', { op: 'promote', id: btn.dataset.id });
        toast('Promoted to Long-Term Memory');
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.mem-del-btn').forEach(btn => {
      btn.onclick = async () => {
        await api('/api/studio/memory', { op: 'delete', tier: S.memTier, id: btn.dataset.id });
        await refreshStudio(true);
      };
    });

    main.querySelector('#mem-clear-btn').onclick = async () => {
      await api('/api/studio/memory', { op: 'clear', tier: S.memTier, keepPinned: true });
      toast(`Cleared ${S.memTier}-term memory`);
      await refreshStudio(true);
    };

    main.querySelector('#mem-consolidate-btn').onclick = async (e) => {
      e.target.textContent = '⏳ Consolidating...';
      try {
        const r = await api('/api/studio/memory/consolidate', {});
        toast(`Consolidated ${r.added} durable facts into Long-Term Memory`);
        S.memTier = 'long';
        await refreshStudio(true);
      } catch (err) {
        toast(`Consolidation failed: ${err.message}`);
        e.target.textContent = 'AI Consolidate STM → LTM';
      }
    };

    main.querySelector('#mem-preview-btn').onclick = async () => {
      const q = main.querySelector('#mem-preview-q').value.trim();
      const out = main.querySelector('#mem-preview-out');
      out.style.display = 'block';
      const r = await api('/api/studio/context-preview', { agent: S.selectedAgentId, query: q });
      out.textContent = r.block || '(No studio context injected)';
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB 4: AGENT HOOKS & UNIVERSAL SDK
  // ═══════════════════════════════════════════════════════════════════════════
  function renderHooksTab(main) {
    const { hooks } = S.state.config;
    const events = S.state.hookEvents || ['beforeChat', 'afterChat', 'onMemoryWrite', 'onError', 'custom'];

    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">Agent Lifecycle Hooks & Universal Access Bridge</h2>
          <p class="studio-section-desc">
            Connect anything to your agents and memory! Configure event hooks below, or use <code>studio/hook.mjs</code> (Node SDK + CLI) or <code>POST /api/studio/hook</code> from PHP, Python, shell scripts, or webhooks.
          </p>
        </div>
        <div class="studio-row">
          <button class="studio-btn" onclick="openStudioFileInIDE('@studio/hook.mjs')">Open studio/hook.mjs</button>
          <button class="studio-btn" onclick="openStudioFileInIDE('@studio/hooks/example.mjs')">Open hooks/example.mjs</button>
          <button class="studio-btn primary" id="hook-add-btn">+ Add Lifecycle Hook</button>
        </div>
      </div>

      <div class="studio-grid" style="margin-bottom:16px;">
        ${hooks.map((h, idx) => `
          <div class="studio-card">
            <div class="studio-between">
              <div class="studio-row">
                <input type="checkbox" class="hk-enabled" data-idx="${idx}" ${h.enabled ? 'checked' : ''}>
                <input class="studio-input hk-name" value="${esc(h.name)}" style="width:190px;font-weight:600;">
              </div>
              <div class="studio-row">
                <button class="studio-btn hk-test" data-id="${esc(h.id)}" data-evt="${esc(h.event)}">▶ Test</button>
                <button class="studio-btn danger hk-del" data-idx="${idx}">x</button>
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div>
                <label class="studio-label">Event</label>
                <select class="studio-select hk-event">
                  ${events.map(ev => `<option value="${esc(ev)}" ${h.event === ev ? 'selected' : ''}>${esc(ev)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="studio-label">Hook Type</label>
                <select class="studio-select hk-type">
                  <option value="inject" ${h.type === 'inject' ? 'selected' : ''}>Prompt Template Inject</option>
                  <option value="script" ${h.type === 'script' ? 'selected' : ''}>Node Script (studio/hooks/*.mjs)</option>
                  <option value="webhook" ${h.type === 'webhook' ? 'selected' : ''}>HTTP Webhook POST</option>
                </select>
              </div>
            </div>
            <div>
              <label class="studio-label">${h.type === 'inject' ? 'Template ({{datetime}}, {{workspace}}, {{agent}}, {{model}})' : (h.type === 'script' ? 'Script filename in studio/hooks/' : 'Webhook URL')}</label>
              <input class="studio-input studio-mono hk-target" value="${esc(h.template || h.file || h.url || '')}">
            </div>
            <div class="studio-between">
              <span class="hk-status" style="font-size:11px;color:var(--studio-dim);">id: <code>${esc(h.id)}</code></span>
              <button class="studio-btn success hk-save" data-idx="${idx}">Save Hook</button>
            </div>
          </div>
        `).join('')}
      </div>

      <!-- Universal Hook Playground & Copy Snippets -->
      <div class="studio-card">
        <div class="studio-between">
          <strong>Universal Agent Hook Playground (<code>POST /api/studio/hook</code>)</strong>
          <span class="studio-badge ok">Active on port 3300</span>
        </div>
        <div style="display:grid;grid-template-columns:200px 1fr auto;gap:8px;">
          <select id="hk-play-action" class="studio-select">
            <option value='{"action":"ping"}'>ping</option>
            <option value='{"action":"memory.remember","text":"Always use prepared statements in PHP","tags":["php","security"],"pinned":true}'>memory.remember</option>
            <option value='{"action":"memory.note","text":"Testing payout webhook flow"}'>memory.note</option>
            <option value='{"action":"memory.recall","query":"php security"}'>memory.recall</option>
            <option value='{"action":"agents.list"}'>agents.list</option>
            <option value='{"action":"models.list"}'>models.list</option>
            <option value='{"action":"agent.run","agent":"sentinel","prompt":"Give 3 quick PHP security checks."}'>agent.run</option>
          </select>
          <input id="hk-play-body" class="studio-input studio-mono" value='{"action":"ping"}'>
          <button class="studio-btn primary" id="hk-play-run">▶ Call Hook API</button>
        </div>
        <pre id="hk-play-out" class="studio-code" style="display:none;margin:0;"></pre>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin-top:6px;">
          <div>
            <label class="studio-label">Node.js / ES Module (anywhere in project)</label>
            <pre class="studio-code">import studio from './studio/hook.mjs';
await studio.remember('Paystack uses NGN kobo', { pinned: true });
const mem = await studio.recall('paystack');
const res = await studio.ask('sentinel', 'Audit payouts.php');</pre>
          </div>
          <div>
            <label class="studio-label">Terminal / Git Hook / Task Runner CLI</label>
            <pre class="studio-code">node studio/hook.mjs remember "KYC uses Didit webhooks" --pin
node studio/hook.mjs recall "database config"
node studio/hook.mjs ask reviewer "Check auth.js"</pre>
          </div>
          <div>
            <label class="studio-label">PHP / cURL Integration Example</label>
            <pre class="studio-code">$ch = curl_init('http://localhost:3300/api/studio/hook');
curl_setopt_array($ch, [
  CURLOPT_POST => 1, CURLOPT_RETURNTRANSFER => 1,
  CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
  CURLOPT_POSTFIELDS => json_encode([
    'action' => 'memory.remember',
    'text'   => 'Production deployment completed'
  ])
]);
$res = curl_exec($ch);</pre>
          </div>
        </div>
      </div>
    `;

    main.querySelector('#hook-add-btn').onclick = async () => {
      const next = [...hooks, { id: 'hook_' + Date.now().toString(36).slice(-4), name: 'New Hook', event: 'beforeChat', type: 'inject', enabled: true, template: 'Workspace: {{workspace}}' }];
      await api('/api/studio/config', { hooks: next });
      await refreshStudio(true);
    };

    main.querySelectorAll('.hk-save').forEach(btn => {
      btn.onclick = async () => {
        const idx = Number(btn.dataset.idx);
        const card = btn.closest('.studio-card');
        const type = card.querySelector('.hk-type').value;
        const target = card.querySelector('.hk-target').value.trim();
        const next = [...hooks];
        next[idx] = {
          id: next[idx].id,
          name: card.querySelector('.hk-name').value.trim() || 'Hook',
          enabled: card.querySelector('.hk-enabled').checked,
          event: card.querySelector('.hk-event').value,
          type,
          ...(type === 'inject' ? { template: target } : (type === 'script' ? { file: target } : { url: target }))
        };
        await api('/api/studio/config', { hooks: next });
        toast('Saved hook');
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.hk-del').forEach(btn => {
      btn.onclick = async () => {
        const idx = Number(btn.dataset.idx);
        await api('/api/studio/config', { hooks: hooks.filter((_, i) => i !== idx) });
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.hk-test').forEach(btn => {
      btn.onclick = async () => {
        try {
          const r = await api('/api/studio/hooks/test', { id: btn.dataset.id, event: btn.dataset.evt });
          toast(`Hook ran ✓ ${r.injected?.length ? 'Injected: ' + r.injected[0] : ''}`);
        } catch (e) {
          toast(`Hook error: ${e.message}`);
        }
      };
    });

    const actSel = main.querySelector('#hk-play-action');
    const bodyIn = main.querySelector('#hk-play-body');
    actSel.onchange = () => { bodyIn.value = actSel.value; };
    main.querySelector('#hk-play-run').onclick = async () => {
      const out = main.querySelector('#hk-play-out');
      out.style.display = 'block';
      out.textContent = 'Running...';
      try {
        const parsed = JSON.parse(bodyIn.value);
        const r = await api('/api/studio/hook', parsed);
        out.textContent = JSON.stringify(r, null, 2);
        await refreshStudio(false);
      } catch (e) {
        out.textContent = 'Error: ' + e.message;
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB 5: MULTI-MODEL / MULTI-AGENT ARENA
  // ═══════════════════════════════════════════════════════════════════════════
  function renderArenaTab(main) {
    const models = S.state.config.providers.filter(p => p.enabled).flatMap(p => p.models.map(m => ({ id: m, provider: p.name })));
    const agents = S.state.config.agents;

    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">Multi-Model Side-by-Side Arena</h2>
          <p class="studio-section-desc">Run the exact same prompt across up to 4 models in parallel to compare speed, code quality, and reasoning.</p>
        </div>
      </div>

      <div class="studio-card" style="margin-bottom:14px;">
        <div class="studio-row">
          <label class="studio-label" style="margin:0;">Select 1–4 models:</label>
          ${models.map(m => `
            <label class="studio-chip-toggle arena-model-chip">
              <input type="checkbox" class="arena-m-cb" value="${esc(m.id)}" ${S.arenaModels.includes(m.id) ? 'checked' : ''}>
              <span>${esc(m.id)}</span>
            </label>
          `).join('')}
        </div>
        <div style="display:grid;grid-template-columns:200px 1fr auto;gap:8px;align-items:center;">
          <select id="arena-agent" class="studio-select">
            ${agents.map(a => `<option value="${esc(a.id)}" ${a.id === S.selectedAgentId ? 'selected' : ''}>${esc(a.emoji)} ${esc(a.name)}</option>`).join('')}
          </select>
          <input id="arena-prompt" class="studio-input" placeholder="Enter a coding, architecture, or debugging prompt to compare models side-by-side...">
          <button class="studio-btn primary" id="arena-run-btn">${S.arenaRunning ? 'Running...' : 'Run Side-by-Side'}</button>
        </div>
      </div>

      <div class="studio-grid" id="arena-results">
        ${(S.arenaResults || []).map(r => `
          <div class="studio-card">
            <div class="studio-between">
              <strong>${esc(r.model)}</strong>
              <span class="studio-badge ${r.ok ? 'ok' : 'warn'}">${r.ok ? `${r.ms}ms` : 'Failed'}</span>
            </div>
            <pre class="studio-code" style="max-height:360px;overflow-y:auto;margin:0;">${esc(r.ok ? r.text : r.error)}</pre>
            ${r.ok ? `
              <div class="studio-row">
                <button class="studio-btn arena-use-model" data-m="${esc(r.model)}">✓ Switch IDE to ${esc(r.model)}</button>
                <button class="studio-btn arena-save-mem" data-txt="${esc(r.text.slice(0, 300))}">Save to Memory</button>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;

    main.querySelector('#arena-run-btn').onclick = async () => {
      const chosen = [...main.querySelectorAll('.arena-m-cb:checked')].map(c => c.value).slice(0, 4);
      const prompt = main.querySelector('#arena-prompt').value.trim();
      const agent = main.querySelector('#arena-agent').value;
      if (!chosen.length || !prompt) return toast('Pick at least 1 model and enter a prompt');
      S.arenaModels = chosen;
      S.arenaRunning = true;
      renderStudio();
      try {
        const r = await api('/api/studio/arena', { models: chosen, prompt, agent });
        S.arenaResults = r.results;
      } catch (e) {
        toast(e.message);
      } finally {
        S.arenaRunning = false;
        renderStudio();
      }
    };

    main.querySelectorAll('.arena-use-model').forEach(btn => {
      btn.onclick = () => {
        if (typeof window.switchModel === 'function') window.switchModel(btn.dataset.m);
        toast(`Switched active model to ${btn.dataset.m}`);
      };
    });

    main.querySelectorAll('.arena-save-mem').forEach(btn => {
      btn.onclick = async () => {
        await api('/api/studio/memory', { op: 'add', tier: 'long', text: btn.dataset.txt, source: 'arena' });
        toast('Saved to Long-Term Memory');
        await refreshStudio(false);
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB 6: ALL SETTINGS (EDITOR, RUNTIME, MEMORY, CHAT, SECURITY)
  // ═══════════════════════════════════════════════════════════════════════════
  function renderSettingsTab(main) {
    const s = S.state.config.settings;
    const g = s.general || {};
    const agents = S.state.config.agents;
    const activePreset = g.themePreset || 'obsidian';
    const presetColors = IDE_THEME_PRESETS[activePreset] || IDE_THEME_PRESETS.obsidian;

    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">Whole-IDE Tone, Theme, Editor, Runtime & Memory Settings</h2>
          <p class="studio-section-desc">Every knob in one place. Theme presets and color pickers re-skin the entire IDE live and save to <code>studio/studio.config.json</code>.</p>
        </div>
        <div class="studio-row">
          <button class="studio-btn" id="st-reset-btn">↺ Reset Defaults</button>
          <button class="studio-btn primary" id="st-save-btn">Save All Settings</button>
        </div>
      </div>

      <div class="studio-row" style="margin-bottom:12px;gap:8px;align-items:center;">
        <button type="button" class="studio-btn" id="st-expand-all" style="font-size:11px;padding:4px 10px;">⊞ Expand All</button>
        <button type="button" class="studio-btn" id="st-collapse-all" style="font-size:11px;padding:4px 10px;">⊟ Collapse All</button>
        <span style="font-size:11px;color:var(--studio-dim);margin-left:auto;">Tap any section header to expand or retract</span>
      </div>

      <!-- Whole-IDE Theme / Visual Tone Presets -->
      <div class="studio-card" style="margin-bottom:14px;">
        <div class="studio-between">
          <strong>Whole-IDE Visual Tone & Theme Presets (1-Click Live Re-Skin)</strong>
          <span class="studio-badge ok">Active: ${esc(IDE_THEME_PRESETS[activePreset]?.label || activePreset)}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:8px;">
          ${Object.entries(IDE_THEME_PRESETS).map(([key, th]) => `
            <button type="button" class="studio-btn st-theme-preset ${activePreset === key ? 'primary' : ''}" data-preset="${key}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;">
              <span>${esc(th.label)}</span>
              <span style="display:inline-flex;gap:3px;">
                <span style="width:10px;height:10px;border-radius:50%;background:${th.bgBase};border:1px solid rgba(255,255,255,0.3);"></span>
                <span style="width:10px;height:10px;border-radius:50%;background:${th.accent};"></span>
                <span style="width:10px;height:10px;border-radius:50%;background:${th.replyColor};"></span>
              </span>
            </button>
          `).join('')}
        </div>

        <details class="studio-accordion" style="margin-top:12px;">
          <summary class="studio-accordion-summary" style="padding:8px 12px;">
            <div class="studio-accordion-title" style="font-size:12px;">
              <strong>Advanced Hex Color Customizer (7 Live Swatches)</strong>
              <span class="studio-badge">Fine-Tune</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content" style="padding:10px 12px;">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
              <div>
                <label class="studio-label">IDE Background</label>
                <input type="color" class="studio-input st-live-color" id="st-bg-base" value="${esc(g.bgBase || presetColors.bgBase)}" style="height:32px;padding:2px;">
              </div>
              <div>
                <label class="studio-label">Header / Sidebar</label>
                <input type="color" class="studio-input st-live-color" id="st-bg-sidebar" value="${esc(g.bgSidebar || presetColors.bgSidebar)}" style="height:32px;padding:2px;">
              </div>
              <div>
                <label class="studio-label">Editor Surface</label>
                <input type="color" class="studio-input st-live-color" id="st-bg-editor" value="${esc(g.bgEditor || presetColors.bgEditor)}" style="height:32px;padding:2px;">
              </div>
              <div>
                <label class="studio-label">Cards & Input Dock</label>
                <input type="color" class="studio-input st-live-color" id="st-bg-card" value="${esc(g.bgCard || presetColors.bgCard)}" style="height:32px;padding:2px;">
              </div>
              <div>
                <label class="studio-label">Primary Accent</label>
                <input type="color" class="studio-input st-live-color" id="st-accent" value="${esc(g.accent || presetColors.accent)}" style="height:32px;padding:2px;">
              </div>
              <div>
                <label class="studio-label">Reply Text Color</label>
                <input type="color" class="studio-input st-live-color" id="st-reply-color" value="${esc(g.replyColor || presetColors.replyColor)}" style="height:32px;padding:2px;">
              </div>
              <div>
                <label class="studio-label">Thinking Color</label>
                <input type="color" class="studio-input st-live-color" id="st-thinking-color" value="${esc(g.thinkingColor || presetColors.thinkingColor)}" style="height:32px;padding:2px;">
              </div>
            </div>
          </div>
        </details>
      </div>

      <div class="studio-grid">
        <!-- 1. Conversational Tone & Thought Display (Open by default) -->
        <details class="studio-accordion" open>
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>Agent Tone & Thought Display</strong>
              <span class="studio-badge ok">Tone: ${esc(g.agentTone || 'default')}</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <div>
              <label class="studio-label">Studio Name (shown in top header)</label>
              <input class="studio-input" id="st-name" value="${esc(g.studioName || 'Agent Studio')}">
            </div>
            <div>
              <label class="studio-label">Whole-IDE Agent Communication Tone (Instant Tap)</label>
              <div class="studio-tone-pills" id="st-tone-pill-list">
                <button type="button" class="studio-tone-pill ${(g.agentTone || 'default') === 'default' ? 'active' : ''}" data-tone="default">Balanced</button>
                <button type="button" class="studio-tone-pill ${g.agentTone === 'concise' ? 'active' : ''}" data-tone="concise">Concise</button>
                <button type="button" class="studio-tone-pill ${g.agentTone === 'friendly' ? 'active' : ''}" data-tone="friendly">Friendly</button>
                <button type="button" class="studio-tone-pill ${g.agentTone === 'principal' ? 'active' : ''}" data-tone="principal">Principal Staff</button>
                <button type="button" class="studio-tone-pill ${g.agentTone === 'teacher' ? 'active' : ''}" data-tone="teacher">Mentor</button>
                <button type="button" class="studio-tone-pill ${g.agentTone === 'cyberpunk' ? 'active' : ''}" data-tone="cyberpunk">Cyberpunk</button>
                <button type="button" class="studio-tone-pill ${g.agentTone === 'custom' ? 'active' : ''}" data-tone="custom">Custom...</button>
              </div>
              <select class="studio-select" id="st-agent-tone" style="display:none;">
                <option value="default" ${(g.agentTone || 'default') === 'default' ? 'selected' : ''}>Balanced</option>
                <option value="concise" ${g.agentTone === 'concise' ? 'selected' : ''}>Concise</option>
                <option value="friendly" ${g.agentTone === 'friendly' ? 'selected' : ''}>Friendly</option>
                <option value="principal" ${g.agentTone === 'principal' ? 'selected' : ''}>Principal Staff</option>
                <option value="teacher" ${g.agentTone === 'teacher' ? 'selected' : ''}>Mentor</option>
                <option value="cyberpunk" ${g.agentTone === 'cyberpunk' ? 'selected' : ''}>Cyberpunk</option>
                <option value="custom" ${g.agentTone === 'custom' ? 'selected' : ''}>Custom Directive</option>
              </select>
            </div>
            <div id="st-custom-tone-wrap" style="display:${g.agentTone === 'custom' ? 'block' : 'none'};margin-top:6px;">
              <label class="studio-label">Custom Tone Instruction</label>
              <input class="studio-input" id="st-custom-tone" value="${esc(g.customTonePrompt || '')}" placeholder="e.g. Speak like a senior Rust systems architect...">
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px 10px;padding-top:8px;">
              <label class="studio-chip-toggle"><input type="checkbox" id="st-collapse-thinking" ${g.collapseThinking ? 'checked' : ''}> <span>Collapse Thinking</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-compact" ${g.compactMode ? 'checked' : ''}> <span>Compact Chat Mode</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-tokens" ${g.showTokenUsage !== false ? 'checked' : ''}> <span>Show Token Usage</span></label>
            </div>
          </div>
        </details>

        <!-- 2. Monaco Code Editor (Retracted by default) -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>Monaco Code Editor & Formatting</strong>
              <span class="studio-badge">${s.editor.fontSize}px · Tab ${s.editor.tabSize} · Wrap ${s.editor.wordWrap}</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <div>
                <label class="studio-label">Font Size (px)</label>
                <input type="number" min="10" max="22" class="studio-input" id="st-fontsize" value="${s.editor.fontSize}">
              </div>
              <div>
                <label class="studio-label">Tab Size</label>
                <input type="number" min="1" max="8" class="studio-input" id="st-tabsize" value="${s.editor.tabSize}">
              </div>
              <div>
                <label class="studio-label">Word Wrap</label>
                <select class="studio-select" id="st-wrap">
                  <option value="on" ${s.editor.wordWrap === 'on' ? 'selected' : ''}>On</option>
                  <option value="off" ${s.editor.wordWrap === 'off' ? 'selected' : ''}>Off</option>
                </select>
              </div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px 10px;margin-top:8px;">
              <label class="studio-chip-toggle"><input type="checkbox" id="st-minimap" ${s.editor.minimap ? 'checked' : ''}> <span>Minimap</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-ligatures" ${s.editor.fontLigatures ? 'checked' : ''}> <span>Font Ligatures</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-smooth" ${s.editor.smoothScrolling ? 'checked' : ''}> <span>Smooth Scroll</span></label>
            </div>
          </div>
        </details>

        <!-- 3. Model Runtime & Context (Retracted by default) -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>Model Runtime, Timeout & Context Files</strong>
              <span class="studio-badge">${s.runtime.requestTimeoutSec}s timeout · ${s.runtime.contextFiles} files</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div>
                <label class="studio-label">Timeout (seconds)</label>
                <input type="number" min="15" max="300" class="studio-input" id="st-timeout" value="${s.runtime.requestTimeoutSec}">
              </div>
              <div>
                <label class="studio-label">Max Tool Rounds</label>
                <input type="number" min="1" max="8" class="studio-input" id="st-rounds" value="${s.runtime.maxToolRounds}">
              </div>
              <div>
                <label class="studio-label">Indexed Context Files</label>
                <input type="number" min="10" max="250" class="studio-input" id="st-ctxfiles" value="${s.runtime.contextFiles}">
              </div>
              <div>
                <label class="studio-label">Fallback Model</label>
                <input class="studio-input studio-mono" id="st-fallback" value="${esc(s.runtime.fallbackModel)}">
              </div>
            </div>
          </div>
        </details>

        <!-- 4. Memory Engine (Retracted by default) -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>Memory Engine & Auto-Capture Tuning</strong>
              <span class="studio-badge ${s.memory.enabled ? 'ok' : 'warn'}">${s.memory.enabled ? `Top-K ${s.memory.longTermTopK} · Max STM ${s.memory.shortTermMax}` : 'Disabled'}</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <div style="display:flex;flex-wrap:wrap;gap:8px 10px;margin-bottom:8px;">
              <label class="studio-chip-toggle"><input type="checkbox" id="st-mem-on" ${s.memory.enabled ? 'checked' : ''}> <span>Enable Memory</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-mem-auto" ${s.memory.autoCapture ? 'checked' : ''}> <span>Auto-Capture (STM)</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-mem-dir" ${s.memory.inlineDirectives ? 'checked' : ''}> <span>Inline [[remember:]]</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-mem-pin" ${s.memory.injectPinned ? 'checked' : ''}> <span>Always Inject Pinned</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-mem-scope" ${s.memory.scopeToProject ? 'checked' : ''}> <span>Scope to Active Project</span></label>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
              <div>
                <label class="studio-label">LTM Top-K Recall</label>
                <input type="number" min="1" max="25" class="studio-input" id="st-mem-topk" value="${s.memory.longTermTopK}">
              </div>
              <div>
                <label class="studio-label">STM Max Entries</label>
                <input type="number" min="5" max="200" class="studio-input" id="st-mem-stmax" value="${s.memory.shortTermMax}">
              </div>
              <div>
                <label class="studio-label">STM TTL (Hours)</label>
                <input type="number" min="1" max="720" class="studio-input" id="st-mem-ttl" value="${s.memory.shortTermTTLHours}">
              </div>
            </div>
          </div>
        </details>

        <!-- 5. Chat Defaults & History Retention (Retracted by default) -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>Chat Defaults & History Limits</strong>
              <span class="studio-badge">Default: ${esc(s.chat.defaultAgent || 'builder')} · Limit ${s.chat.historyLimit}</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div>
                <label class="studio-label">Default Agent on Startup</label>
                <select class="studio-select" id="st-def-agent">
                  ${agents.map(a => `<option value="${esc(a.id)}" ${s.chat.defaultAgent === a.id ? 'selected' : ''}>${esc(a.emoji)} ${esc(a.name)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="studio-label">Conversation History Turns</label>
                <input type="number" min="4" max="100" class="studio-input" id="st-hist" value="${s.chat.historyLimit}">
              </div>
            </div>
          </div>
        </details>

        <!-- 6. Hook Security & Remote Access (Retracted by default) -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>Agent Hook Security & Remote Access</strong>
              <span class="studio-badge">${s.security.allowRemoteHookCalls ? 'LAN Remote' : 'Local-Only'}</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <div style="display:flex;flex-wrap:wrap;gap:8px 10px;margin-bottom:8px;">
              <label class="studio-chip-toggle"><input type="checkbox" id="st-sec-scripts" ${s.security.allowScriptHooks ? 'checked' : ''}> <span>Allow studio/hooks/*.mjs</span></label>
              <label class="studio-chip-toggle"><input type="checkbox" id="st-sec-remote" ${s.security.allowRemoteHookCalls ? 'checked' : ''}> <span>Allow LAN / Remote Hooks</span></label>
            </div>
            <div>
              <label class="studio-label">Optional Hook Auth Token (sent via <code>x-studio-token</code> header)</label>
              <input type="password" class="studio-input studio-mono" id="st-sec-token" value="${esc(s.security.hookToken || '')}" placeholder="Leave blank for local-only no-token access">
            </div>
          </div>
        </details>
      </div>
    `;

    let chosenPreset = activePreset;

    const readCurrentThemeColors = () => ({
      themePreset: chosenPreset,
      bgBase: main.querySelector('#st-bg-base').value,
      bgSidebar: main.querySelector('#st-bg-sidebar').value,
      bgEditor: main.querySelector('#st-bg-editor').value,
      bgCard: main.querySelector('#st-bg-card').value,
      borderColor: (IDE_THEME_PRESETS[chosenPreset] || IDE_THEME_PRESETS.obsidian).borderColor,
      accent: main.querySelector('#st-accent').value,
      replyColor: main.querySelector('#st-reply-color').value,
      thinkingColor: main.querySelector('#st-thinking-color').value,
      collapseThinking: main.querySelector('#st-collapse-thinking').checked
    });

    main.querySelectorAll('.st-theme-preset').forEach(btn => {
      btn.onclick = async () => {
        chosenPreset = btn.dataset.preset;
        const p = IDE_THEME_PRESETS[chosenPreset];
        if (!p) return;
        main.querySelector('#st-bg-base').value = p.bgBase;
        main.querySelector('#st-bg-sidebar').value = p.bgSidebar;
        main.querySelector('#st-bg-editor').value = p.bgEditor;
        main.querySelector('#st-bg-card').value = p.bgCard;
        main.querySelector('#st-accent').value = p.accent;
        main.querySelector('#st-reply-color').value = p.replyColor;
        main.querySelector('#st-thinking-color').value = p.thinkingColor;
        applyWholeIDETheme(readCurrentThemeColors());
        const nextGen = { ...s.general, ...readCurrentThemeColors() };
        await api('/api/studio/config', { settings: { ...s, general: nextGen } });
        toast(`Applied IDE theme: ${p.label}`);
        await refreshStudio(true);
      };
    });

    main.querySelectorAll('.st-live-color').forEach(inp => {
      inp.oninput = () => applyWholeIDETheme(readCurrentThemeColors());
    });

    const toneSel = main.querySelector('#st-agent-tone');
    toneSel.onchange = () => {
      main.querySelector('#st-custom-tone-wrap').style.display = toneSel.value === 'custom' ? 'block' : 'none';
    };

    main.querySelectorAll('.studio-tone-pill').forEach(pill => {
      pill.onclick = () => {
        main.querySelectorAll('.studio-tone-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        if (toneSel) {
          toneSel.value = pill.dataset.tone;
          toneSel.onchange();
        }
      };
    });

    const expBtn = main.querySelector('#st-expand-all');
    const colBtn = main.querySelector('#st-collapse-all');
    if (expBtn) expBtn.onclick = () => main.querySelectorAll('details.studio-accordion').forEach(d => d.open = true);
    if (colBtn) colBtn.onclick = () => main.querySelectorAll('details.studio-accordion').forEach(d => d.open = false);

    main.querySelector('#st-save-btn').onclick = async () => {
      const next = {
        general: {
          ...s.general,
          ...readCurrentThemeColors(),
          studioName: main.querySelector('#st-name').value.trim() || 'Agent Studio',
          agentTone: main.querySelector('#st-agent-tone').value,
          customTonePrompt: main.querySelector('#st-custom-tone').value.trim(),
          compactMode: main.querySelector('#st-compact').checked,
          showTokenUsage: main.querySelector('#st-tokens').checked
        },
        editor: {
          ...s.editor,
          fontSize: Number(main.querySelector('#st-fontsize').value) || 13,
          tabSize: Number(main.querySelector('#st-tabsize').value) || 2,
          wordWrap: main.querySelector('#st-wrap').value,
          minimap: main.querySelector('#st-minimap').checked,
          fontLigatures: main.querySelector('#st-ligatures').checked,
          smoothScrolling: main.querySelector('#st-smooth').checked
        },
        runtime: {
          ...s.runtime,
          requestTimeoutSec: Number(main.querySelector('#st-timeout').value) || 90,
          maxToolRounds: Number(main.querySelector('#st-rounds').value) || 2,
          contextFiles: Number(main.querySelector('#st-ctxfiles').value) || 80,
          fallbackModel: main.querySelector('#st-fallback').value.trim() || 'gpt-5.6-sol'
        },
        memory: {
          ...s.memory,
          enabled: main.querySelector('#st-mem-on').checked,
          autoCapture: main.querySelector('#st-mem-auto').checked,
          inlineDirectives: main.querySelector('#st-mem-dir').checked,
          injectPinned: main.querySelector('#st-mem-pin').checked,
          scopeToProject: main.querySelector('#st-mem-scope').checked,
          longTermTopK: Number(main.querySelector('#st-mem-topk').value) || 8,
          shortTermMax: Number(main.querySelector('#st-mem-stmax').value) || 40,
          shortTermTTLHours: Number(main.querySelector('#st-mem-ttl').value) || 48
        },
        chat: {
          ...s.chat,
          defaultAgent: main.querySelector('#st-def-agent').value,
          historyLimit: Number(main.querySelector('#st-hist').value) || 40
        },
        security: {
          ...s.security,
          allowScriptHooks: main.querySelector('#st-sec-scripts').checked,
          allowRemoteHookCalls: main.querySelector('#st-sec-remote').checked,
          hookToken: main.querySelector('#st-sec-token').value
        }
      };
      await api('/api/studio/config', { settings: next });
      toast('All settings saved & applied across IDE');
      await refreshStudio(true);
    };

    main.querySelector('#st-reset-btn').onclick = async () => {
      await api('/api/studio/reset', { what: 'settings' });
      toast('Settings reset to defaults');
      await refreshStudio(true);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB 7: LIVE ACTIVITY & STUDIO CONTROL FILES
  // ═══════════════════════════════════════════════════════════════════════════
  function renderActivityTab(main) {
    const st = S.state.stats || {};
    const files = S.state.files || [];

    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">Live Telemetry & Studio Control Files</h2>
          <p class="studio-section-desc">Inspect every file powering Agent Studio directly in the Monaco editor, and watch live agent/hook/memory events.</p>
        </div>
        <button class="studio-btn" id="act-refresh-btn">↻ Refresh</button>
      </div>

      <div class="studio-grid" style="margin-bottom:16px;">
        <div class="studio-card">
          <strong>Session Telemetry</strong>
          <div class="studio-row" style="gap:16px;font-size:12.5px;">
            <div>Requests: <strong>${st.requests || 0}</strong></div>
            <div>Errors: <strong>${st.errors || 0}</strong></div>
            <div>Avg Latency: <strong>${st.avgLatency || 0}ms</strong></div>
            <div>Uptime: <strong>${st.uptimeSec || 0}s</strong></div>
          </div>
          <div style="font-size:11.5px;color:var(--studio-dim);">
            By Agent: ${Object.entries(st.byAgent || {}).map(([k, v]) => `<code>${esc(k)}:${v}</code>`).join(' ') || 'none yet'}
          </div>
        </div>

        <div class="studio-card">
          <strong>IDE Control & Memory Files (1-Click Open in Editor)</strong>
          <div class="studio-row">
            ${files.filter(f => !f.path.endsWith('secrets.json')).map(f => `
              <button class="studio-btn" onclick="openStudioFileInIDE('${esc(f.path)}')">${esc(f.path.replace('@studio/', ''))}</button>
            `).join('')}
            <button class="studio-btn" onclick="openStudioFileInIDE('@studio/hook.mjs')">hook.mjs</button>
          </div>
        </div>
      </div>

      <div class="studio-card">
        <strong>Recent Activity Stream (<code>studio/logs/activity.jsonl</code>)</strong>
        <div>
          ${S.activity.length === 0 ? '<div style="color:var(--studio-dim);font-size:12px;">No events logged yet.</div>' : ''}
          ${S.activity.slice(0, 60).map(e => `
            <div class="studio-between" style="padding:6px 0;border-bottom:1px solid var(--studio-border);font-size:12px;">
              <div class="studio-row">
                <span class="studio-badge ${e.ok === false ? 'warn' : 'ok'}">${esc(e.type || 'evt')}</span>
                ${e.agent ? `<strong>${esc(e.agent)}</strong>` : ''}
                ${e.model ? `<code>${esc(e.model)}</code>` : ''}
                <span>${esc(e.message || '')}</span>
              </div>
              <span style="color:var(--studio-dim);font-family:monospace;font-size:11px;">${e.ms ? `${e.ms}ms · ` : ''}${fmtAgo(e.ts)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    main.querySelector('#act-refresh-btn').onclick = () => refreshStudio(true);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TAB 8: USER GUIDE & DOCUMENTATION
  // ═══════════════════════════════════════════════════════════════════════════
  function renderGuideTab(main) {
    main.innerHTML = `
      <div class="studio-section-hdr">
        <div>
          <h2 class="studio-section-title">Agent Studio &amp; Cowork IDE User Guide</h2>
          <p class="studio-section-desc">Complete handbook for specialist agents, ADK skills, autonomous tool loops, dual-tier memory, mobile touch coding, and shortcuts.</p>
        </div>
        <div class="studio-row">
          <button type="button" class="studio-btn" id="guide-expand-all">Expand All</button>
          <button type="button" class="studio-btn" id="guide-collapse-all">Collapse All</button>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:12px;">
        <!-- 1. Getting Started, Layouts & Mobile Navigation -->
        <details class="studio-accordion" open>
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>1. Getting Started, Layouts &amp; Mobile Navigation</strong>
              <span class="studio-badge ok">Essential</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Welcome to <strong>Pocket Cowork / Agent Studio</strong> — a zero-dependency, self-hosted AI pair-programming workspace engineered for desktop and mobile over local Wi-Fi.</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Split View:</strong> Chat with AI on the left, edit code in Monaco Editor on the right. Resize panes dynamically using the divider handle. Type <code>/split</code> in chat or select Split from the bottom navigation bar.</li>
              <li><strong>Single Mode (Mobile):</strong> Use the bottom navigation bar to switch between <code>Chat</code>, <code>Editor</code>, <code>Split</code>, <code>Files</code>, <code>Term</code>, <code>Settings</code>, and <code>Guide</code> in one tap.</li>
              <li><strong>PWA / Android Install:</strong> Open your mobile browser's menu (Chrome or Edge) and tap <em>"Add to Home Screen"</em> for a full-screen, native-feeling mobile IDE.</li>
              <li><strong>Local Wi-Fi Pairing:</strong> Set <code>HOST=0.0.0.0</code> in <code>.env</code> to pair-program on your phone while running code on your desktop.</li>
            </ul>
          </div>
        </details>

        <!-- 2. Specialist Agents & Personas -->
        <details class="studio-accordion" open>
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>2. Specialist Agents &amp; Mentions (@builder, @architect...)</strong>
              <span class="studio-badge">5 Built-in</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Direct tasks to specialized AI roles by typing <code>@</code> in any prompt or switching the active persona dropdown:</p>
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:8px;">
              <div class="studio-card" style="padding:10px;">
                <div class="studio-row"><span class="studio-badge ok">@builder</span> <strong>Full-Stack Builder</strong></div>
                <div style="font-size:11.5px;color:var(--studio-dim);margin-top:4px;">Writes production code, creates components, runs test suites, and implements features end-to-end.</div>
              </div>
              <div class="studio-card" style="padding:10px;">
                <div class="studio-row"><span class="studio-badge" style="background:rgba(56,189,248,0.18);color:#38bdf8;">@architect</span> <strong>System Architect</strong></div>
                <div style="font-size:11.5px;color:var(--studio-dim);margin-top:4px;">Designs high-level software architectures, database schemas, API contracts, and refactoring plans.</div>
              </div>
              <div class="studio-card" style="padding:10px;">
                <div class="studio-row"><span class="studio-badge" style="background:rgba(245,158,11,0.18);color:#f59e0b;">@reviewer</span> <strong>Security &amp; Code Reviewer</strong></div>
                <div style="font-size:11.5px;color:var(--studio-dim);margin-top:4px;">Conducts code reviews, input validation audits, boundary checks, and syntax verifications.</div>
              </div>
              <div class="studio-card" style="padding:10px;">
                <div class="studio-row"><span class="studio-badge" style="background:rgba(239,68,68,0.18);color:#ef4444;">@debugger</span> <strong>Runtime Debugger</strong></div>
                <div style="font-size:11.5px;color:var(--studio-dim);margin-top:4px;">Diagnoses stack traces, analyzes error logs, isolates regressions, and applies surgical bug fixes.</div>
              </div>
              <div class="studio-card" style="padding:10px;">
                <div class="studio-row"><span class="studio-badge" style="background:rgba(168,85,247,0.18);color:#c084fc;">@chat</span> <strong>Conversational Assistant</strong></div>
                <div style="font-size:11.5px;color:var(--studio-dim);margin-top:4px;">Ideation, planning, drafting technical documentation, and exploring unfamiliar topics.</div>
              </div>
            </div>
          </div>
        </details>

        <!-- 3. ADK Skills System & Skills Hub -->
        <details class="studio-accordion" open>
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>3. ADK Skills Hub &amp; Teaching the Agent</strong>
              <span class="studio-badge ok">ADK Playbooks</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Built on the official Google Agent Development Kit (ADK) progressive disclosure patterns:</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Progressive Disclosure:</strong> Skills are stored as modular markdown playbooks in <code>skills/&lt;name&gt;/SKILL.md</code>. Only skill summaries (~50 tokens) are initially registered in the prompt, saving over 99% of context window capacity. Full playbooks are loaded on-demand when needed.</li>
              <li><strong>Teach Skill:</strong> Tap <strong>+ → Teach Skill</strong> to open the skill authoring sheet. Provide a name, short description, and clear step-by-step instructions.</li>
              <li><strong>Command Shortcut:</strong> Type <code>/learn &lt;skill-name&gt; &lt;instructions&gt;</code> directly in the chat to teach skills on the fly.</li>
              <li><strong>Skills Hub:</strong> Inspect, activate, edit, or delete existing skill playbooks via <strong>+ → Skills Hub</strong> or <code>Ctrl+Shift+S</code>.</li>
              <li><strong>Built-in Skills:</strong> Includes <code>python-runner</code> (virtual environment execution), <code>git-flow</code> (branching and conflict resolution), and <code>workflow-skill-creator</code>.</li>
            </ul>
          </div>
        </details>

        <!-- 4. Autonomous Agent Loop & Execution Controls -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>4. Autonomous Agent Loop &amp; Execution Controls</strong>
              <span class="studio-badge">Multi-Turn</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">The agent autonomously manages complex multi-step workflows:</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Autonomous Tool Loop:</strong> When a task requires reading files, making edits, running terminal commands, and verifying results, the agent continues autonomously across multiple tool iterations until the goal is accomplished.</li>
              <li><strong>Loading Spinner:</strong> A smooth rotating SVG ring indicates active processing and tool execution phases.</li>
              <li><strong>Manual Interrupt / Stop:</strong> Click the <strong>Stop</strong> button next to the prompt input at any time to halt an active loop safely.</li>
            </ul>
          </div>
        </details>

        <!-- 5. Dual-Tier Memory System -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>5. Dual-Tier Memory &amp; [[remember:]] Syntax</strong>
              <span class="studio-badge ok">LTM + STM</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Agent Studio features a persistent dual-tier memory engine so key project decisions persist across sessions:</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Long-Term Memory (LTM):</strong> Persisted to <code>studio/memory/long_term.json</code>. Survives chat resets, reboots, and browser clears. Ideal for architectural rules, database credentials, and tech stack choices.</li>
              <li><strong>Short-Term Memory (STM):</strong> Scoped to current active tasks and recent milestones. Automatically cleared between distinct tasks.</li>
              <li><strong>Instant Ingestion Syntax:</strong> Include <code>[[remember: Your note or rule]]</code> in any chat prompt. The agent automatically commits the note to LTM without breaking conversational flow.</li>
              <li><strong>Memory Manager:</strong> Open the <strong>Memory (LTM + STM)</strong> tab (or press <code>Ctrl+Shift+M</code>) to inspect, search, manually add, or delete memories.</li>
            </ul>
          </div>
        </details>

        <!-- 6. Workspace Files, Context Menu & Uploads -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>6. Workspace Files, Context Menu &amp; Uploads</strong>
              <span class="studio-badge">File Ops</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Full-featured workspace file management on both desktop and mobile:</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Context Menu:</strong> Right-click on desktop or long-press on mobile on any file or folder in the File Explorer to <strong>Create File</strong>, <strong>Create Folder</strong>, <strong>Rename</strong>, or <strong>Delete</strong>.</li>
              <li><strong>Drag &amp; Drop Uploads:</strong> Drag any file, log, or image directly into the chat or attachment dropzone. Files are saved into <code>.cowork/uploads/</code> for agent inspection.</li>
              <li><strong>File Quick Jump:</strong> Press <code>Ctrl+P</code> to fuzzy-search and instantly open any file in the Monaco Editor.</li>
            </ul>
          </div>
        </details>

        <!-- 7. Add Context Flyout & Slash Commands -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>7. Add Context Menu (+) &amp; Slash Commands</strong>
              <span class="studio-badge">Shortcuts</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Quick tools accessible from the prompt input area:</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Add Context (+) Menu:</strong> Tap the <strong>+</strong> button to attach workspace files, attach whole folders, insert <code>@agent</code> mentions, launch <strong>Teach Skill</strong>, open the <strong>Skills Hub</strong>, or trigger quick actions.</li>
              <li><strong>/split:</strong> Switch mobile view to simultaneous Top Editor + Bottom Chat split view.</li>
              <li><strong>/clear:</strong> Reset chat message stream and start a clean session.</li>
              <li><strong>/studio:</strong> Open the Agent Studio command center.</li>
              <li><strong>/learn &lt;name&gt; &lt;instructions&gt;:</strong> Directly register a new skill playbook.</li>
            </ul>
          </div>
        </details>

        <!-- 8. Providers & API Keys -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>8. AI Providers, API Keys &amp; Safe Security Boundaries</strong>
              <span class="studio-badge">Multi-Provider</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Connect any modern LLM backend with enterprise-grade secret protection:</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Supported Providers:</strong> Agent Router, AWS Bedrock, OpenAI, Anthropic Claude, DeepSeek, Google Gemini, Local Ollama, and OpenAI-compatible endpoints.</li>
              <li><strong>Fail-Closed Security:</strong> API keys are stored server-side and never leaked in plaintext to client requests or browser logs.</li>
              <li><strong>Loopback Defense:</strong> Privileged file operations, terminal execution, and settings modifications require session token authentication.</li>
              <li><strong>Multi-Model Arena:</strong> Compare multiple models on the same prompt simultaneously in the <strong>Multi-Model Arena</strong> tab.</li>
            </ul>
          </div>
        </details>

        <!-- 9. Android & Mobile Touch Coding -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>9. Android &amp; Mobile Touch Coding Features</strong>
              <span class="studio-badge ok">Touch Ready</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Engineered from the ground up for phone and tablet pair programming:</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Apple-Style Bottom Sheets:</strong> Teach Skill and Skills Hub modals smoothly slide up from the bottom on touch devices with native drag grabbers and 44px tap targets.</li>
              <li><strong>Virtual Coding Toolbar:</strong> Quick-insert programming keys (<code>{</code>, <code>}</code>, <code>(</code>, <code>)</code>, <code>;</code>, <code>=</code>, <code>=&gt;</code>, <code>"</code>, <code>$</code>, <code>Tab</code>) directly above your mobile keyboard without switching keyboard layouts.</li>
              <li><strong>Keyboard-Resilient Layout:</strong> 16px minimum font size on touch inputs prevents iOS Safari auto-zooming and layout distortion.</li>
              <li><strong>Clean Navigation:</strong> Bottom navigation bar provides one-touch access to Chat, Editor, Split, Files, Terminal, Settings, and Guide.</li>
            </ul>
          </div>
        </details>

        <!-- 10. Developer Tools & Services Hub -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <strong>10. Developer Tools, Terminal &amp; Connectors Hub</strong>
              <span class="studio-badge">Integrated</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <p style="margin:0 0 8px 0;font-size:12.5px;line-height:1.5;">Built-in tools accessible from the IDE and Agent Hooks:</p>
            <ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--studio-dim);">
              <li><strong>Built-in Terminal:</strong> Run builds, npm scripts, git commands, and test suites directly from the browser or mobile terminal tab.</li>
              <li><strong>REST API Client:</strong> Send GET/POST requests, inspect response headers, and preview JSON without switching to external tools.</li>
              <li><strong>Database Inspector:</strong> Run ad-hoc SQL queries and inspect SQLite/Postgres tables.</li>
              <li><strong>Agent Hooks &amp; SDK:</strong> Extend your agent with custom Node.js middleware in <code>studio/hook.mjs</code> (e.g. pre-prompt filters, tool approvals, auto-formatting).</li>
            </ul>
          </div>
        </details>

        <!-- 11. Keyboard Shortcuts Cheat Sheet -->
        <details class="studio-accordion">
          <summary class="studio-accordion-summary">
            <div class="studio-accordion-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:6px;"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8"/><line x1="10" y1="8" x2="10" y2="8"/><line x1="14" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="18" y2="12"/><line x1="10" y1="16" x2="14" y2="16"/></svg>
              <strong>11. Keyboard Shortcuts Cheat Sheet</strong>
              <span class="studio-badge">Hotkeys</span>
            </div>
            <span class="studio-accordion-chevron">▾</span>
          </summary>
          <div class="studio-accordion-content">
            <table style="width:100%;border-collapse:collapse;font-size:12px;line-height:1.6;">
              <thead>
                <tr style="border-bottom:1.5px solid var(--studio-border);text-align:left;">
                  <th style="padding:6px 8px;">Shortcut</th>
                  <th style="padding:6px 8px;">Action</th>
                  <th style="padding:6px 8px;">Scope</th>
                </tr>
              </thead>
              <tbody>
                <tr style="border-bottom:1px solid var(--studio-border);">
                  <td style="padding:6px 8px;"><code>Ctrl+Enter</code> / <code>Cmd+Enter</code></td>
                  <td style="padding:6px 8px;">Send message to active agent</td>
                  <td style="padding:6px 8px;color:var(--studio-dim);">Chat Input</td>
                </tr>
                <tr style="border-bottom:1px solid var(--studio-border);">
                  <td style="padding:6px 8px;"><code>Ctrl+P</code> / <code>Cmd+P</code></td>
                  <td style="padding:6px 8px;">Quick Jump to File</td>
                  <td style="padding:6px 8px;color:var(--studio-dim);">Global</td>
                </tr>
                <tr style="border-bottom:1px solid var(--studio-border);">
                  <td style="padding:6px 8px;"><code>Ctrl+Shift+A</code></td>
                  <td style="padding:6px 8px;">Open Agent Studio Command Center</td>
                  <td style="padding:6px 8px;color:var(--studio-dim);">Global</td>
                </tr>
                <tr style="border-bottom:1px solid var(--studio-border);">
                  <td style="padding:6px 8px;"><code>Ctrl+,</code></td>
                  <td style="padding:6px 8px;">Open All IDE &amp; Studio Settings</td>
                  <td style="padding:6px 8px;color:var(--studio-dim);">Global</td>
                </tr>
                <tr style="border-bottom:1px solid var(--studio-border);">
                  <td style="padding:6px 8px;"><code>Ctrl+Shift+M</code></td>
                  <td style="padding:6px 8px;">Open Memory Manager (LTM + STM)</td>
                  <td style="padding:6px 8px;color:var(--studio-dim);">Global</td>
                </tr>
                <tr style="border-bottom:1px solid var(--studio-border);">
                  <td style="padding:6px 8px;"><code>Ctrl+Shift+H</code></td>
                  <td style="padding:6px 8px;">Open User Guide &amp; Documentation</td>
                  <td style="padding:6px 8px;color:var(--studio-dim);">Global</td>
                </tr>
                <tr style="border-bottom:1px solid var(--studio-border);">
                  <td style="padding:6px 8px;"><code>Ctrl+Shift+S</code></td>
                  <td style="padding:6px 8px;">Open ADK Skills Hub</td>
                  <td style="padding:6px 8px;color:var(--studio-dim);">Global</td>
                </tr>
                <tr style="border-bottom:1px solid var(--studio-border);">
                  <td style="padding:6px 8px;"><code>Escape</code></td>
                  <td style="padding:6px 8px;">Close Studio Modal or Dismiss Dropdown</td>
                  <td style="padding:6px 8px;color:var(--studio-dim);">Modal</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </div>
    `;

    main.querySelector('#guide-expand-all').onclick = () => {
      main.querySelectorAll('details.studio-accordion').forEach(d => d.open = true);
    };
    main.querySelector('#guide-collapse-all').onclick = () => {
      main.querySelectorAll('details.studio-accordion').forEach(d => d.open = false);
    };
  }

  // ── Keyboard Shortcuts ────────────────────────────────────────────────────
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      window.openAgentStudio('providers');
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      window.openAgentStudio('memory');
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      window.openAgentStudio('guide');
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (typeof window.openSkillsHubModal === 'function') {
        window.openSkillsHubModal();
      } else {
        window.openAgentStudio('skills');
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      window.openAgentStudio('settings');
    } else if (e.key === 'Escape') {
      if (document.getElementById('studio-nav')?.classList.contains('mobile-open')) {
        window.closeStudioDrawer();
      } else if (document.getElementById('studio-quick-files-dropdown')?.open) {
        window.closeQuickFilesDropdown();
      } else if (document.getElementById('studio-backdrop')?.classList.contains('open')) {
        closeStudio();
      }
    }
  });

  document.addEventListener('click', (e) => {
    const dd = document.getElementById('studio-quick-files-dropdown');
    if (dd && dd.open && !dd.contains(e.target)) {
      dd.open = false;
    }
  });

  // ── Boot & SSE Live Updates ───────────────────────────────────────────────
  function boot() {
    mountIDEChrome();
    refreshStudio(false);
    try {
      const es = new EventSource('/api/studio/events');
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'memory' || data.type === 'config' || data.type === 'chat') {
            refreshStudio(false);
          }
        } catch (e) {}
      };
    } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

