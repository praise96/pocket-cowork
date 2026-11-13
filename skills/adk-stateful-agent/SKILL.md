---
name: adk-stateful-agent
description: >-
  Advanced architectural and implementation knowledge for building stateful AI agents,
  based on the Google Agent Development Kit (ADK) and Antigravity masterclasses.
  Covers the Agent Harness pattern, two-tier memory architecture (Session State + Long-Term Memory),
  context caching optimization, multimodal vector search (text, video, PDF in unified embedding space),
  progressive disclosure for agent skills, and stateful multi-turn evaluation.
  Use whenever designing, building, debugging, or optimizing AI agents, agent runtimes, memory systems,
  multimodal RAG pipelines, or tool calling harnesses.
---

# ADK Stateful Agent & Multimodal Memory Playbook

This skill encapsulates the core architectural patterns and implementation standards taught in the Google Cloud / DeepMind Agent Development Kit (ADK) and Antigravity masterclasses:
- *Memory & Assembly — RAG, Vector Search, and the ADK*
- *Stateful Interactions — Runtimes, Multimodal RAG, and Evaluation*

---

## 1. Core Architecture: The Agent Harness Pattern

An AI agent is **never** just a raw model call. An enterprise-grade agent consists of three distinct layers orchestrated by an **Agent Harness**:

```
 ┌─────────────────────────────────────────────────────────────┐
 │                         CLIENT LAYER                        │
 │           (Web IDE, Mobile App, PWA, Terminal, Voice)       │
 └──────────────────────────────┬──────────────────────────────┘
                                │ (Sessions & Streams)
 ┌──────────────────────────────▼──────────────────────────────┐
 │                        AGENT HARNESS                        │
 │  • Session Manager & State Externalizer                    │
 │  • Two-Tier Memory Service (LTM + STM)                     │
 │  • Skill Registry & Progressive Disclosure Loader           │
 │  • Tool Dispatcher & Sandboxed Execution                    │
 │  • Context Assembler & Caching Optimizer                    │
 └──────────────────────────────┬──────────────────────────────┘
                                │ (Formatted Prompts + Tools)
 ┌──────────────────────────────▼──────────────────────────────┐
 │                      FOUNDATION MODELS                      │
 │     (Gemini 2.5/Flash/Pro, Claude, GPT, Local Ollama)       │
 └─────────────────────────────────────────────────────────────┘
```

### Key Principles of the Harness:
1. **Decouple Client from Compute:** The client (e.g. mobile phone, web browser) never executes agent tools directly. The harness runs in a secure, sandboxed environment (PC host, Docker, or Cloud Run instance).
2. **Stateless Compute with Externalized State:** Worker nodes must remain stateless. All session logs and state are persisted to an external database (SQLite, Cloud Spanner, Postgres) so any worker can resume any conversation turn instantly.
3. **Fail-Closed Execution:** Dangerous operations (file modification, shell command execution) must be filtered by role permissions and verified with sandboxing checks.

---

## 2. Two-Tier Memory Architecture

Solving the *"goldfish memory"* problem without overflowing the LLM context window requires separating memory into two distinct tiers:

```
                      User Turn
                         │
                         ▼
        ┌───────────────────────────────────┐
        │        Active Turn Handler        │
        └───────┬───────────────────┬───────┘
                │                   │
      [1. Working State]    [2. Extract Facts]
                │                   │
                ▼                   ▼
    ┌──────────────────────┐ ┌──────────────────────────────────┐
    │  TIER 1: SESSION     │ │  TIER 2: LONG-TERM MEMORY        │
    │  (Ephemeral State)   │ │  (Durable Semantic Store)        │
    ├──────────────────────┤ ├──────────────────────────────────┤
    │ • Current conversation│ │ • Durable user facts & preferences│
    │   messages & turns   │ │ • Project tech stack & constraints│
    │ • Scratchpad notes   │ │ • Architecture decisions         │
    │ • Recent tool logs   │ │ • Auto-captured [[remember:...]] │
    │ • Active goal steps  │ │ • Cross-session persistence      │
    └──────────────────────┘ └──────────────────────────────────┘
```

### Tier 1: Session State (`ADK Session`)
* **Lifespan:** The duration of an active user goal or conversation thread.
* **Storage:** In-memory or cached session row (`sessions_db.json` / SQLite session table).
* **Purge Policy:** Can be archived or truncated (e.g. sliding window of the last 15–40 turns).

### Tier 2: Long-Term Memory Service
* **Lifespan:** Permanent across all sessions, server reboots, and client disconnects.
* **Auto-Extraction:** During every turn, extract durable facts from unstructured user text (e.g., founder name, project tech stack, production credentials, coding preferences).
* **Directives:** Support inline memory directives (e.g., `[[remember: <fact>]]` for durable facts; `[[note: <text>]]` for session-only scratchpads).
* **Fresh Session Injection:** On every new session, recall the top-K relevant facts and inject them into the system prompt:
  ```markdown
  ## PERSISTENT PROJECT KNOWLEDGE
  - Active workspace: "my-project"
  - Technology stack: Node.js 22, SQLite, Tailwind CSS
  - User preference: Mobile-first, strict TypeScript, no inline styles
  ```

---

## 3. Context Caching Optimization (Implicit & Explicit)

Context length is one of the highest cost and latency drivers in multi-turn agents.

### The Problem:
In naive multi-turn agents, turn 10 re-sends turns 1 through 9. Each new turn re-bills all previous tokens from scratch, resulting in quadratic token costs and escalating response times.

### The ADK Caching Solution:
1. **Stable System Prefix:** Keep the system instructions, tools declarations, and static workspace indexing at the exact beginning of the prompt. Do not insert dynamic timestamps or random IDs *before* the static block.
2. **Implicit Context Caching:** When consecutive requests share an identical prompt prefix (typically $\ge 32\text{k}$ tokens in Gemini), the inference engine automatically matches the prefix cache, yielding:
   * Up to **75% discount** on input tokens.
   * Drastically lower time-to-first-token (TTFT).
3. **Explicit Context Caching:** For massive static references (e.g. documentation corpuses or codebase indexes), create an explicit named cache and pass the cache handle in subsequent turn payloads.

---

## 4. Multimodal Vector Search & Unified Embeddings

### Unified Multimodal Embedding Space:
Rather than running separate search engines for text, PDFs, video, and audio, modern ADK systems map all assets into a **single unified vector space**:

```
   Text Document  ──┐
   PDF Page       ──┼───> [ Multimodal Embedding Model ] ───> Unified Vector Space (e.g., 768 / 1536 dims)
   Video Frame    ──┤         (Gemini Embeddings)
   Audio Snippet  ──┘
                                                                       ▲
                                                                       │ (Cosine Similarity)
   User Query ("Show me the onboarding UI diagram") ───────────────────┘
```

### Retrieval & Grounding Rules:
1. **Semantic Chunking:** Break documents at natural boundaries (markdown headers, code functions, video chapter markers) rather than raw arbitrary token splits.
2. **Hybrid Search:** Combine dense vector search (cosine similarity for conceptual matching) with sparse keyword search (BM25 for exact function names, variables, or error codes).
3. **Attribution & Grounding:** Always return retrieved chunks with exact source citations (`file_path`, `line_numbers`, or `video_timestamp [MM:SS]`).

---

## 5. Agent Skills via Progressive Disclosure

To prevent bloating the context window, skills follow the **Three-Phase Progressive Disclosure Lifecycle**:

1. **Discovery (Low-Cost Metadata):**
   * The agent loads only the skill YAML frontmatter:
     * `name` (unique hyphenated identifier)
     * `description` (precise trigger criteria detailing *when* the agent should invoke it)
   * Token cost: $\sim 50$ tokens per skill, enabling dozens of skills in one agent.
2. **Activation (On-Demand Loading):**
   * When the user's intent matches the skill's `description`, the agent uses its file-read tool to load the complete `SKILL.md` body into context.
3. **Execution (Runbooks & Scripts):**
   * The agent executes the step-by-step instructions.
   * If the skill contains executable scripts (`scripts/run.py`), the agent runs them directly using its terminal tool.

---

## 6. Verification and Evaluation Checklist

When building or updating an agent or skill, verify against these criteria:

- [ ] **Stateless Runtime:** Can the server reboot or handle requests across worker processes without losing session memory?
- [ ] **Memory Segregation:** Are transient conversational ramblings kept in Session State while durable project facts are stored in Long-Term Memory?
- [ ] **Prompt Stability:** Is the static prompt prefix kept clean and immutable to maximize context cache hit rates?
- [ ] **Tool Grounding:** Does the agent cite real files, tools, and terminal logs rather than inventing or hallucinating answers?
- [ ] **Progressive Disclosure:** Are domain instructions partitioned into on-demand `SKILL.md` files rather than crammed into one massive system prompt?

