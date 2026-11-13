---
name: git-flow
description: Clean git version control workflows: conventional commits, safe branch creation, pre-commit secret hygiene, and GitHub push guidance. Use whenever committing code, creating branches, or staging changes.
---

# Git Flow & Commit Hygiene Playbook

This skill instructs the agent on proper git workflow, fail-closed security hygiene, and clean commit discipline.

## 1. Pre-Commit Security Check (MANDATORY)

Before staging (`git add`) or committing:
1. Run `git status --ignored` to verify that sensitive files are excluded:
   * `.env` and `.env.*`
   * `.agents/`
   * `studio/secrets.json`
   * `studio/logs/` & `studio/memory/`
   * `sessions_db.json` & SQLite databases (`*.db`, `workspace.db`)
2. Never commit raw API keys, bearer tokens, or user chat histories.

## 2. Conventional Commit Standards

Format commits with standard prefixes:
- `feat:` for new capabilities or user-facing features
- `fix:` for bug fixes and patches
- `refactor:` for code restructuring without changing external behavior
- `perf:` for performance optimizations and context caching
- `docs:` for README or documentation updates
- `test:` for diagnostic scripts or unit tests

## 3. GitHub Push Procedure

When the user requests pushing to GitHub:
```bash
git add .
git commit -m "<type>: <concise description>"
git branch -M main
git push -u origin main
```

