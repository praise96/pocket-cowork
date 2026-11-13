---
name: python-runner
description: Run Python scripts, manage virtual environments, install packages via pip, and execute automated tests on PC or Android. Use whenever running Python code, installing dependencies, or debugging tracebacks.
---

# Python Runner & Dependency Playbook

This skill guides the agent in running, testing, and managing Python environments on both Desktop (Windows/Linux/Mac) and Mobile (Android Termux).

## 1. Environment Detection

Before executing Python code:
1. Check the operating system and shell environment:
   * **Windows (Desktop):** Use `python -c "..."` or `python main.py`. If `pip` is not directly on PATH, use `python -m pip install <package>`.
   * **Android (Termux):** Use `python main.py` or `python3 main.py`. Packages are installed via `pkg install python` or `pip install <package>`.
   * **Linux/Mac:** Use `python3 main.py`.

## 2. Best Practices

- **Zero-Crash Execution:** Always test code with `python -c "..."` or run unit tests before reporting success to the user.
- **Dependency Isolation:** If working in a dedicated project directory, prefer running in a virtual environment (`python -m venv .venv`).
- **Traceback Analysis:** When an `ImportError` or `ModuleNotFoundError` occurs, extract the exact missing package name and provide the exact install command (e.g. `python -m pip install <package>`).
- **Output Truncation:** For long terminal outputs, pipe through `head` or slice within script to avoid context window blowup.

