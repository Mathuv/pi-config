# Destructive Confirm

A Pi extension that detects destructive tool calls and asks for explicit confirmation before allowing them to run.

It is designed to fail safe: Deny is the default selection, Escape blocks, non-interactive sessions block, and timeout mode (when enabled) blocks on timeout.

## Features

- Intercepts only `bash`, `write`, and `edit` tool calls.
- Detects risky shell commands such as file deletion, destructive SQL, HTTP DELETE requests, destructive git operations, and destructive cloud/CLI actions.
- Blocks `write` and `edit` calls whose target path resolves outside the current working directory.
- Uses Pi's native `ctx.ui.select()` confirmation UI.
- Defaults to no timer: prompts wait until the user chooses.
- Optional 15-second timeout mode for auto-deny prompts.
- Session-local enable/disable and timeout toggles.
- Footer status shows whether protection is on, off, or running with timeout mode.

## Confirmation flow

When a destructive action is detected, the prompt shows:

1. **Deny (default)** — block the current action and keep protection enabled.
2. **Allow once** — allow only the current action and keep protection enabled.
3. **Allow and disable protection for this session…** — open a second confirmation prompt.

The disable option requires a second explicit confirmation:

1. **Cancel (keep protection on)** — block the current action and keep protection enabled.
2. **Yes, allow and disable for session** — allow the current action and disable protection until the session ends.

Deny remains the safe default throughout the flow. Pressing Enter on the default option denies. Pressing Escape denies. If timeout mode is enabled and the prompt times out, it denies.

## Commands

| Command | Description |
|---------|-------------|
| `/destructive-confirm` | Toggle destructive confirmation on/off for the current session. |
| `/dc` | Alias for `/destructive-confirm`. |
| `/destructive-confirm-timeout` | Toggle 15-second timeout mode on/off for the current session. |
| `/dc-timeout` | Alias for `/destructive-confirm-timeout`. |

All command state is session-local and resets when Pi restarts.

## Footer status

| Status | Meaning |
|--------|---------|
| `🔒∞ DC` | Protection is enabled and prompts wait indefinitely. This is the default. |
| `🔒⏱ DC` | Protection is enabled and timeout mode is on. Prompts auto-deny after 15 seconds. |
| `🔓 DC` | Protection is disabled for the current session. |

## What gets flagged

### Bash commands

The extension flags these command patterns:

- File deletion/truncation: `rm`, `rm -rf`, `shred`, `truncate`
- Destructive SQL: `DROP TABLE`, `DROP DATABASE`, `DROP SCHEMA`, `DELETE FROM`, `UPDATE ... SET`, `TRUNCATE`
- HTTP DELETE via `curl -X DELETE` or `curl --request DELETE`
- Destructive git operations: `git reset --hard`, `git push --force`, `git push -f`, `git branch -D`, `git branch --delete`, `git commit --amend`
- Destructive CLIs: `gcloud ... delete`, `kubectl delete`, `jira delete`, `gh pr close`, `gh pr merge`, `gh pr delete`

### File operations

For `write` and `edit`, the extension resolves the target path against the current working directory. Paths outside the working directory are blocked unless explicitly allowed.

Examples:

| Working directory | Target path | Result |
|-------------------|-------------|--------|
| `/repo` | `src/app.ts` | Allowed without prompt. |
| `/repo` | `/repo/src/app.ts` | Allowed without prompt. |
| `/repo` | `../notes.txt` | Confirmation required. |
| `/repo` | `/tmp/file.txt` | Confirmation required. |

## Installation

Install this extension in a Pi agent config directory:

```bash
mkdir -p ~/.pi/agent/extensions/destructive-confirm
cp index.ts ~/.pi/agent/extensions/destructive-confirm/index.ts
```

Then restart Pi or run `/reload` in an active Pi session.

If this extension is published as a standalone repository, clone it directly into Pi's extension directory:

```bash
git clone <repo-url> ~/.pi/agent/extensions/destructive-confirm
```

## Development

Run the test suite from this directory with Node's built-in test runner:

```bash
node --test index.test.ts
```

The tests cover risk detection, path containment, confirmation defaults, timeout behavior, session disable flow, command registration, and footer status.

## Safety model

This extension is a guardrail, not a sandbox. It reduces accidental destructive actions from agent tool calls by adding a confirmation gate. It does not replace backups, source control, least-privilege credentials, or review of commands before allowing them.
