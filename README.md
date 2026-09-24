# Pi Config

Adtrac team's [pi](https://github.com/earendil-works/pi) configuration — agents, skills, extensions, and prompts that shape how pi works the team.

## Setup

Clone this repo directly to `~/.pi/agent/` — pi auto-discovers everything from there (extensions, skills, agents, AGENTS.md, mcp.json). No symlinks, no manual wiring.

### Prerequisites

- **[git](https://git-scm.com/downloads)** — clone and update this config repo
- **[pi](https://github.com/earendil-works/pi)** — the coding agent itself
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — required by `extensions/uv.ts`; Pi routes bare `python` / `python3` calls through `uv run` and blocks `pip` / `poetry` workflows in favor of uv
- **[Node.js/npm/npx](https://nodejs.org/)** — required for `npx skills ...`, npm-based pi packages, and the Postgres MCP server entries in `mcp.json`
- **[cmux](https://www.cmux.dev/)** — recommended if you want the visible subagent workflow this config is built around

See [CLI tools](#cli-tools) for the full bootstrap list used by config files, MCP servers, extensions, and globally installed skills.

### Fresh machine

```bash
# 1. Install prerequisites: git, pi, uv, and optionally cmux

# 2. Clone this repo as your agent config
mkdir -p ~/.pi
git clone https://github.com/Adtrac/pi-config.git ~/.pi/agent

# 3. Run setup (installs packages and writes default settings if missing)
cd ~/.pi/agent && ./setup.sh

# 4. Install shared global skills used by this config
npx skills add forrestchang/andrej-karpathy-skills -g -a universal --skill karpathy-guidelines -y
npx skills add mattpocock/skills -g -a universal --skill grill-with-docs -y
npx skills add vercel-labs/agent-browser -g -a universal --skill agent-browser -y
npx skills add ast-grep/agent-skill -g -a universal --skill ast-grep -y
npx skills add upstash/context7 -g -a universal --skill find-docs -y
npx skills add code-and-sorts/awesome-copilot-agents -g -a universal --skill jira-cli -y
npx skills add Mathuv/awesome-codex-skills -g -a universal --skill gh-address-comments -y
npx skills add nicobailon/visual-explainer -g -a universal --skill visual-explainer -y

# 5. Optional: add personal instructions
cp APPEND_SYSTEM.example.md APPEND_SYSTEM.md
$EDITOR APPEND_SYSTEM.md

```

Add credentials to ~/.pi/agent/auth.json and restart pi or run `/login` slash command after running pi. If you use the optional Deepseek models in models.json, also provide DEEPSEEK_API_KEY in your environment.

### Shared global skills

This config references a few skills that better live outside this repo under `~/.agents/skills/`. Install them with the [Vercel Skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add forrestchang/andrej-karpathy-skills -g -a universal --skill karpathy-guidelines -y
npx skills add mattpocock/skills -g -a universal --skill grill-with-docs -y
npx skills add vercel-labs/agent-browser -g -a universal --skill agent-browser -y
npx skills add pproenca/dot-skills -g -a universal --skill ast-grep -y
npx skills add upstash/context7 -g -a universal --skill find-docs -y
npx skills add code-and-sorts/awesome-copilot-agents -g -a universal --skill jira-cli -y
npx skills add Mathuv/awesome-codex-skills -g -a universal --skill gh-address-comments -y
npx skills add nicobailon/visual-explainer -g -a universal --skill visual-explainer -y
```

Sources:

- [`forrestchang/andrej-karpathy-skills`](https://github.com/forrestchang/andrej-karpathy-skills): `karpathy-guidelines`
- [`mattpocock/skills`](https://github.com/mattpocock/skills): `grill-with-docs`
- [`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser): `agent-browser`
- [`ast-grep/agent-skill`](https://github.com/ast-grep/agent-skill): `ast-grep`
- [`upstash/context7`](https://github.com/upstash/context7): `find-docs`
- [`code-and-sorts/awesome-copilot-agents`](https://github.com/code-and-sorts/awesome-copilot-agents): `jira-cli`
- [`Mathuv/awesome-codex-skills`](https://github.com/Mathuv/awesome-codex-skills): `gh-address-comments`
- [`nicobailon/visual-explainer`](https://github.com/nicobailon/visual-explainer): `visual-explainer`

These skills are used by `AGENTS.md`, `agents.json`, and the default skill discovery list. Re-run the commands when bootstrapping a new machine or when refreshing shared global skills.

### CLI tools

This config assumes these command-line tools are available on `PATH`:

| Tool | Install/source |
|------|----------------|
| `git` | `brew install git` |
| `pi` | `curl -fsSL https://pi.dev/install.sh \| sh` |
| `node` | `brew install node` |
| `npm` | comes with [Node.js](https://nodejs.org/) |
| `npx` | comes with [Node.js](https://nodejs.org/) |
| `uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `cmux` | [cmux](https://cmux.com/) or [WezTerm](https://wezterm.org/) |
| `rtk` | `curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh \| sh` |
| `icm` | `curl -fsSL https://raw.githubusercontent.com/rtk-ai/icm/main/install.sh \| sh` |
| `gh` | `brew install gh` |
| `ctags` | [Universal Ctags](https://github.com/universal-ctags/ctags) |
| `ast-grep` | [ast-grep](https://github.com/ast-grep/ast-grep) |
| `agent-browser` | [agent-browser](https://github.com/vercel-labs/agent-browser) |
| `ctx7` | [context7](https://github.com/upstash/context7) |
| `jira` | [jira-cli](https://github.com/ankitpokhrel/jira-cli) |
| `glimpse` | [glimpse](https://github.com/HazAT/glimpse) - `npm install -g glimpseui` |


Sources in this repo:

- `setup.sh` / `settings.json`: `pi`, `git`, `node`, `npm`, `npx`
- `extensions/uv.ts` + `intercepted-commands/`: `uv` and a Python interpreter discoverable by `uv`
- `extensions/cmux/index.ts`: `cmux` when Pi runs inside cmux (`CMUX_SOCKET_PATH` set)
- `extensions/prompt-url-widget.ts`: `gh` for PR/issue URL metadata
- `mcp.json`: `npx` for Postgres MCP servers 
- `AGENTS.md`: `rtk` and `icm`
- [Mathuv/symbol-autocomplete](https://github.com/Mathuv/symbol-autocomplete): `ctags` preferred, `ast-grep` fallback
- Global skills: `agent-browser`, `ctx7` (`find-docs`), `jira`, `gh`, and optional `surf` for `visual-explainer`

Install examples for the non-core tools:

- [cmux](https://www.cmux.dev/) - install from upstream docs.
- [rtk + icm](https://github.com/rtk-ai/icm) - install from upstream docs.

MacOS comes pre-installed with BSD ctags, which does not support the `--output-format=json` mode required by symbol autocomplete. Install Universal Ctags and ensure it shadows `/usr/bin/ctags`.

### Personalization

`AGENTS.md` is shared team config and should stay team-neutral. Put personal identity, preferences, and workflow notes in `APPEND_SYSTEM.md` instead.

Pi loads `APPEND_SYSTEM.md` as extra system-prompt context. This file is ignored by git, so each team member can keep their own local version without changing shared config.

Start from the example:

```bash
cd ~/.pi/agent
cp APPEND_SYSTEM.example.md APPEND_SYSTEM.md
$EDITOR APPEND_SYSTEM.md
```

Example content:

```md
# Personal Instructions

I am `<github-username>` aka `<name>` on GitHub and other places.
Prefer concise answers.
```

After editing, restart pi or run `/reload`.

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

Specialized roles with baked-in identity, workflow, and review rubrics. Most agents now ship with the [pi-interactive-subagents](https://github.com/Mathuv/pi-interactive-subagents) package; local overrides live in `agents/`.

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
| **learn-codebase** | Onboarding to a new project, checking conventions |
| **session-reader** | Reading and analyzing pi session JSONL files |
| **skill-creator** | Scaffolding new agent skills |
| **write-todos** | Writing clear, actionable todos from a plan |
| **self-improve** | End-of-session retrospective — surfaces improvements and creates todos |
| **cmux** | Managing terminal sessions via cmux |
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
| [pi-interactive-subagents](https://github.com/Mathuv/pi-interactive-subagents) | Subagent tools + agent definitions + `/plan`, `/subagent`, `/iterate` commands |
| [pi-parallel](https://github.com/HazAT/pi-parallel) | Parallel web search, extract, research, and enrich tools |
| [pi-smart-sessions](https://github.com/Mathuv/pi-smart-sessions) | AI-generated session names |
| [pi-diff-review](https://github.com/badlogic/pi-diff-review) | Interactive diff review UI |
| [chrome-cdp-skill](https://github.com/pasky/chrome-cdp-skill) | Chrome DevTools Protocol CLI for visual testing |

---

## Credits

Extensions from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff): `answer`, `todos`

Skills from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff): `commit`, `github`

Skills from [getsentry/skills](https://github.com/getsentry/skills): `code-simplifier`
