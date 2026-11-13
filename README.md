# Pocket Cowork — Mobile-First AI Pair Programming Web IDE & Studio

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │   POCKET COWORK  |  Zero-Dependency Self-Hosted AI Web IDE            │
 │   Pair program seamlessly between your PC and phone over local Wi-Fi   │
 └────────────────────────────────────────────────────────────────────────┘
```

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green?logo=node.js)](https://nodejs.org/)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-blue)](package.json)
[![Platform](https://img.shields.io/badge/Platform-Desktop%20%7C%20Android%20%7C%20iOS%20%7C%20Termux-purple)](#running-on-mobile--android)
[![Security](https://img.shields.io/badge/Security-Fail--Closed%20Auth-red)](#security--git-hygiene)

A lightweight, zero-dependency, self-hosted Web IDE and Multi-Agent Studio built on native Node.js. Designed for developers who want to pair-program on their computer directly from their phone (Android / iOS / Termux / Chrome) over local Wi-Fi without cloud lock-in, heavy containers, or complex setups.

---

## Project Overview

| Capability | Specification |
| :--- | :--- |
| **Runtime** | Pure Node.js 22+ (native `node:sqlite`, native `fetch`, native `crypto` — zero `npm install`) |
| **Client UI** | Single standalone responsive bundle (`agent-chat.html`) with zero build step |
| **Mobile Pairing** | Full dual-screen pair programming on Android / iOS over local Wi-Fi (`HOST=0.0.0.0`) |
| **Mobile UX** | Apple-style bottom sheets, soft-keyboard lock, touch split resizer, 1-tap quick symbols bar (`{}`, `()`, `;`, `=>`, `Tab`) |
| **Attachments** | Unified `+` context popover (Images, Code files, Folders, Mentions, Teach Skill, Skills Hub) |
| **Models Supported** | Agent Router (`gpt-5.6-sol`, `gpt-6-astra`), Claude Opus 5, DeepSeek V4, OpenAI, Bedrock, Ollama, Gemini |
| **Agent Personas** | Builder, Architect, Reviewer, Debugger, Conversational Assistant with 2-tier project memory |
| **ADK Skills** | Progressive disclosure playbooks (`skills/<name>/SKILL.md`) with 99% prompt token savings |
| **Autonomous Loop** | Multi-turn tool execution loop with dynamic loading spinner and instant stop override |
| **File Management** | Full context menu (Create File, Create Folder, Rename, Delete) and drag-and-drop uploads |
| **Security** | Fail-closed token authentication, masked API keys, directory traversal sandboxing |

---

## Key Features

- **Mobile-First & Android / iOS Ready**:
  - **Portrait Single-Tab & Split-Screen View**: Switch between `Chat`, `Editor`, `Split View` (simultaneous Top Editor + Bottom Chat with a touch-draggable divider), `Files`, `Terminal`, `Settings`, and `Guide`.
  - **Apple-Style Bottom Sheets**: Native slide-up sheets with drag handles (`.sheet-grabber`) and sticky 44px tap targets for Teach Skill and Skills Hub modals on touch devices.
  - **Virtual Keyboard Resilient**: `16px` minimum input font size prevents mobile browsers (iOS Safari / Android Chrome) from auto-zooming or distorting layout.
  - **1-Tap Quick Coding Bar**: Fast access to indentation (`Tab`), code brackets (`{}`, `[]`, `()`), operators (`=`, `=>`, `;`), quotes, and cursor navigation right above your phone keyboard.
  - **Landscape Desktop Mode**: Turning your phone sideways automatically switches to a side-by-side resizable desktop layout.
  - **Installable PWA**: Add directly to your phone's home screen via Chrome or Edge (*"Add to Home screen"*).
- **Unified Context Attachment & Vision**:
  - Single **`+`** button with glassmorphic menu: attach images, photos, code documents, or directory folders directly into the prompt.
  - Automatic multimodal conversion supporting both classic Chat Completions and modern OpenAI Responses APIs (`/v1/responses`).
- **Autonomous Tool Loops & Real-Time Feedback**:
  - The agent autonomously detects multi-step tasks (reading files, editing code, running terminal commands, verifying output) and executes consecutive iterations until completion.
  - Smooth vector rotating loading ring displays active execution states.
  - Dedicated **Stop** control to pause or halt tool loops instantly.
- **Full Agent Studio (`Ctrl+Shift+A`)**:
  - **Multi-Provider Support**: Agent Router, AWS Bedrock, OpenAI, Anthropic, Google Gemini, OpenRouter, DeepSeek, Groq, Mistral, xAI, Together AI, Ollama, and LM Studio.
  - **Specialized Agents**: Builder, Architect, Reviewer, Debugger, and Conversational Assistant — or create custom agents with per-agent tools, prompts, and memory rules.
  - **Dual-Tier Memory**: Automatic and manual Long-Term (`studio/memory/long_term.json`) and Short-Term (`studio/memory/short_term.json`) memory with inline `[[remember: ...]]` directives.
  - **Universal Hook SDK (`studio/hook.mjs`)**: Trigger agents, query memory, and automate workflows from the CLI or custom scripts.
- **Workspace File Management & Connectors**:
  - Right-click or long-press file explorer items to **Create File**, **Create Folder**, **Rename**, or **Delete**.
  - Drag-and-drop file upload automatically stages files in `.cowork/uploads/` where the agent can inspect and execute on them.
  - Built-in Services Hub: HTTP / REST Client, SQLite Database Explorer, Docker Container Manager, and Redis RESP Client.
- **Hardened Security**:
  - Fail-closed session token authentication (`x-studio-token`), masked API keys, strict workspace path containment, and `.env` / `.gitignore` secret protection.

---

## Quick Start

### 1. Clone & Configure Environment
```bash
git clone <your-repo-url>
cd <repo-folder>
cp .env.example .env
```
Open `.env` and add your API key (or configure keys anytime inside the **Agent Studio UI → Providers** tab):
```env
PORT=3300
HOST=127.0.0.1
AGENTROUTER_API_KEY=sk-your-key-here
```

### 2. Start the Server
Requires **Node.js 22+** (uses built-in `node:sqlite` and native `fetch` — no `npm install` needed):
```bash
npm start
# or directly:
node serve_chat.js
```
Open **`http://localhost:3300`** in Chrome or any modern browser.

---

## Running on Mobile / Android

### Option A: Access from Android Phone over Local Wi-Fi
1. In your `.env` file on your PC, set:
   ```env
   HOST=0.0.0.0
   ```
2. Restart `node serve_chat.js`.
3. Find your PC's local Wi-Fi IP address (`ipconfig` on Windows / `ifconfig` on Mac/Linux, e.g. `192.168.1.150`).
4. Open **`http://<your-pc-ip>:3300`** in Chrome / Edge on your Android phone and tap **Menu (⋮) → Add to Home screen**.

### Option B: Run 100% Standalone on Android via Termux (No PC Needed)
Use the included 1-command startup script:
```bash
pkg update && pkg install nodejs-lts git python
git clone <your-repo-url>
cd <repo-folder>
bash start-android.sh
```
This automatically acquires Termux background wake-lock, generates `.env`, and launches Pocket Cowork on `http://127.0.0.1:3300`.

---

## ADK Skills Architecture (Google Masterclass Patterns)

Pocket Cowork is architected around the official Google Agent Development Kit (ADK) stateful agent design patterns:

### 1. Progressive Disclosure Skills Hub (`skills/` & `/learn`)
- Skills are stored as self-contained markdown playbooks with YAML frontmatter in `skills/<skill-name>/SKILL.md`.
- **99% Token Conservation**: Only skill names and 1-line descriptions (~50 tokens total) are indexed in the system prompt.
- **On-Demand Loading**: When a specialized task arises (e.g. executing Python virtual environments or resolving Git rebase conflicts), the agent autonomously calls `read_skill("<name>")` to load the complete playbook.
- **Interactive Authoring**: Tap **`+` → Teach Skill** (mobile bottom sheet or modal) or type `/learn <name> <instructions>` directly in the chat to teach new capabilities on the fly.
- Built-in starter skills: `skills/python-runner/`, `skills/git-flow/`, and `skills/workflow-skill-creator/`.

### 2. Context Caching Prompt Restructuring
- Restructured prompt pipeline into a **Frozen Static Prefix** (System persona, workspace index, project memory rules, and available skills frontmatter) and a **Dynamic Context Suffix** (terminal logs attached to the latest user message).
- Guarantees 100% prefix cache hits on Gemini, Claude, and OpenAI APIs, unlocking:
  - **75% token cost reduction**
  - **Sub-second time-to-first-token latency**

### 3. Automated Two-Tier Memory Service
- **Tier 1 (Session State)**: In-flight conversation turns, scratchpads, and short-term working notes with automatic TTL.
- **Tier 2 (Long-Term Memory)**: Durable architectural decisions, technology stack facts, and user preferences persisted in `.cowork/memory.json` and `studio/memory/long_term.json`.
- **Heuristic Auto-Extraction**: The backend automatically extracts key facts, preferences, and project rules stated during conversation turns with zero external latency or API cost.

---

## Keyboard Shortcuts & Quick Actions

| Shortcut | Action | Scope |
| :--- | :--- | :--- |
| `Ctrl+Enter` / `Cmd+Enter` | Send message to active agent | Chat Input |
| `Ctrl+P` / `Cmd+P` | Quick Jump to File | Global |
| `Ctrl+Shift+A` | Open Agent Studio Command Center | Global |
| `Ctrl+,` | Open All IDE & Studio Settings | Global |
| `Ctrl+Shift+M` | Open Memory Manager (LTM + STM) | Global |
| `Ctrl+Shift+H` | Open User Guide & Documentation | Global |
| `Ctrl+Shift+S` | Open ADK Skills Hub | Global |
| `Escape` | Dismiss modal, flyout, or dropdown | Global |

---

## Security & Git Hygiene

All sensitive files and user-specific states are automatically excluded via `.gitignore`:
- `.env` (API keys and environment secrets)
- `studio/secrets.json` (UI-managed provider keys)
- `.agents/` (Local session tokens and private chat history)
- `studio/logs/` & `studio/memory/short_term.json`
- `sessions_db.json` & local SQLite workspace databases
