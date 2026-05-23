# Pi Config

My personal [pi](https://github.com/earendil-works/pi) configuration — agents, skills, extensions, and prompts that shape how pi works for me.

## Setup

Clone this repo directly to `~/.pi/agent/` — pi auto-discovers everything from there (extensions, skills, agents, AGENTS.md, mcp.json). No symlinks, no manual wiring.

### Prerequisites

- **[git](https://git-scm.com/downloads)** — clone and update this config repo
- **[pi](https://github.com/earendil-works/pi)** — the coding agent itself
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — required by `extensions/uv.ts`; Pi routes bare `python` / `python3` calls through `uv run` and blocks `pip` / `poetry` workflows in favor of uv
- **[cmux](https://www.cmux.dev/)** — recommended if you want the visible subagent workflow this config is built around

### Fresh machine

```bash
# 1. Install prerequisites: git, pi, uv, and optionally cmux

# 2. Clone this repo as your agent config
mkdir -p ~/.pi
git clone git@github.com:Mathuv/pi-config ~/.pi/agent

# 3. Run setup (installs packages and writes default settings if missing)
cd ~/.pi/agent && ./setup.sh

```

Add credentials to ~/.pi/agent/auth.json and restart pi or run `/login` slash command after running pi. If you use the optional Deepseek models in models.json, also provide DEEPSEEK_API_KEY in your environment.


### Updating

```bash
cd ~/.pi/agent && git pull
```

---

## Architecture

This config uses **subagents** — visible pi sessions spawned in cmux terminals. Each subagent is a full pi session with its own identity, tools, and skills. The user can watch agents work in real-time and interact when needed.

### Key Concepts

- **Subagents** — visible cmux terminals running pi. Autonomous agents self-terminate via `subagent_done`. Interactive agents wait for the user.
- **Agent definitions** (`agents/*.md`) — one source of truth for model, tools, skills, and identity per role.
- **Plan workflow** — `/plan` spawns an interactive planner subagent, then orchestrates workers and reviewers.
- **Iterate pattern** — `/iterate` forks the session into a subagent for quick fixes without polluting the main context.

---

## Agents

Specialized roles with baked-in identity, workflow, and review rubrics. Most agents now ship with the [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) package; local overrides live in `agents/`.

| Agent | Source | Purpose |
|-------|--------|---------|
| **planner** | package | Interactive planning — clarifies WHAT to build and figures out HOW (lightweight requirements + approach + plan + todos) |
| **scout** | package | Fast codebase reconnaissance — gathers context without making changes |
| **worker** | package | Implements tasks from todos, commits with polished messages |
| **reviewer** | local | Reviews code for quality, security, correctness (Codex 5.4) |
| **visual-tester** | package | Visual QA — navigates web UIs via Chrome CDP, spots issues, produces reports |
| **claude-code** | package | Delegates autonomous tasks to Claude Code |
| **researcher** | local | Deep research using parallel.ai tools + Claude Code for code analysis |
| **autoresearch** | local | Autonomous experiment loop — runs, measures, and optimizes iteratively |

## Skills

Loaded on-demand when the context matches.

| Skill | When to Load |
|-------|-------------|
| **commit** | Making git commits (mandatory for every commit) |
| **code-simplifier** | Simplifying or cleaning up code |
| **frontend-design** | Building web components, pages, or apps |
| **github** | Working with GitHub via `gh` CLI |
| **iterate-pr** | Iterating on a PR until CI passes |
| **learn-codebase** | Onboarding to a new project, checking conventions |
| **session-reader** | Reading and analyzing pi session JSONL files |
| **skill-creator** | Scaffolding new agent skills |
| **write-todos** | Writing clear, actionable todos from a plan |
| **self-improve** | End-of-session retrospective — surfaces improvements and creates todos |
| **cmux** | Managing terminal sessions via cmux |
| **presentation-creator** | Creating data-driven presentation slides |
| **add-mcp-server** | Adding MCP server configurations |

## Extensions

| Extension | What it provides |
|-----------|------------------|
| **answer/** | `/answer` command + `Ctrl+.` — extracts questions into interactive Q&A UI |
| **cmux/** | cmux integration — notifications, sidebar, workspace tools |
| **cost/** | `/cost` command — API cost summary |
| **execute-command/** | `execute_command` tool — lets the agent self-invoke slash commands |
| **commit/** | `/commit-staged` and `/commit-all` — generate a Conventional Commit message from staged diff, require editable review, then commit |
| **todos/** | `/todos` command + `todo` tool — file-based todo management |
| **destructive-confirm/** | Safety gate for destructive `bash`/`write`/`edit` tool calls. See [`extensions/destructive-confirm/README.md`](extensions/destructive-confirm/README.md). |
| **uv.ts** | uv-first Python guardrail for the `bash` tool — prepends command shims, routes bare `python` / `python3` through `uv run`, and blocks `pip`, `pip3`, and `poetry`. Benefit: keeps agent Python usage portable and consistent across Pi sessions instead of depending on shell-local setup. |

## Commands

| Command | Description |
|---------|-------------|
| `/plan <description>` | Start a planning session — spawns planner subagent, then orchestrates execution |
| `/subagent <agent> <task>` | Spawn a subagent (e.g., `/subagent scout analyze the auth module`) |
| `/iterate [task]` | Fork session into interactive subagent for quick fixes |
| `/answer` | Extract questions into interactive Q&A |
| `/commit-staged [guidance]` | Generate a message from the current staged diff, let you edit it, then commit only the staged index |
| `/commit-all [guidance]` | Run `git add -A`, generate/edit a message from the resulting staged diff, then commit |
| `/todos` | Visual todo manager |
| `/cost` | API cost summary |

`/commit-staged` and `/commit-all` read the runtime policy from `~/.pi/agent/skills/commit/SKILL.md`. Arguments are message guidance only, not file selectors. Cancelling the editor aborts the commit; `/commit-all` keeps the `git add -A` staging intact. Neither command pushes, signs off, or adds breaking-change footers.

## Packages

Installed via `pi install`, managed in `settings.json`.

| Package | Description |
|---------|-------------|
| [pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) | Subagent tools + agent definitions + `/plan`, `/subagent`, `/iterate` commands |
| [pi-parallel](https://github.com/HazAT/pi-parallel) | Parallel web search, extract, research, and enrich tools |
| [pi-smart-sessions](https://github.com/HazAT/pi-smart-sessions) | AI-generated session names |
| [pi-diff-review](https://github.com/badlogic/pi-diff-review) | Interactive diff review UI |
| [chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) | Chrome DevTools Protocol CLI for visual testing |

---

## Credits

Extensions from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff): `answer`, `todos`

Skills from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff): `commit`, `github`

Skills from [getsentry/skills](https://github.com/getsentry/skills): `code-simplifier`
