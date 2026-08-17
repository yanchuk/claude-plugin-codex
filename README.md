# claude-plugin-codex

## Install

Add the public marketplace:

```bash
codex plugin marketplace add yanchuk/claude-plugin-codex
```

Then open Codex's plugin directory, find `Claude Plugin Codex`, and install
`Claude`.

Start a new Codex thread and verify the install:

```text
$claude setup
```

If Codex was already running, start a new thread or restart Codex before using
`$claude`.

## What It Is

If you already use Codex and Claude Code, this plugin brings Claude Code into
your Codex workflow. Codex stays in charge of the thread. Claude Code gives a
second pass through the local `claude` CLI.

Use it for four things:

- a normal read-only Claude review
- a more skeptical adversarial review
- a quick second opinion while Codex keeps working
- a rescue pass when a Codex thread stalls or needs another agent

This is the inverse of
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc). That
plugin pulls Codex into Claude Code. This one pulls local Claude Code into
Codex.

## Status

Alpha. The Codex marketplace flow has been verified with Codex CLI `0.130.0`.
The stable command form is `$claude`. If your Codex UI exposes the skill as
`/claude`, you can use that as an alias.

## Core Commands

- `$claude setup` checks whether Claude Code is installed, authenticated, and
  supports the needed CLI features.
- `$claude review` runs the short structured read-only review route for local
  git state.
- `$claude adversarial-review` asks Claude to challenge a plan or diff.
- `$claude advise` asks Claude for a quick second opinion.
- `$claude do` gives Claude a prepared coding, exploration, verifier, scout, or
  synthesis task.
- `$claude rescue` hands Claude a debugging or implementation task. It is
  read-only unless you pass `--write`.
- `$claude monitor` polls a background Claude job and reports whether Claude is
  active, stale, or finished.
- `$claude status`, `$claude result`, and `$claude cancel` manage Claude jobs.

Longer jobs can run in the background:

```text
$claude advise --background should this VAD tuning loop collect N=5 now?
$claude do --background --model sonnet map the auth module and return file:line citations
$claude rescue --background --model opus investigate the flaky integration test
$claude monitor <job-id>
$claude result <job-id>
```

Slash-style aliases are best-effort. Codex plugin manifests do not yet expose a
documented custom slash-command API, so `$claude` is the portable form. If your
Codex build passes slash-style text to skills, these forms map to the same
commands:

```text
/claude setup
/claude:advise should this plan use a background worker?
/claude:do --background --model sonnet map the auth module
/claude:rescue --background investigate the flaky integration test
/claude:review --base main
/claude:adversarial-review challenge the state management assumptions
```

## When To Use It

A good default pattern is simple:

- Run `$claude review` for a normal second pass.
- Run `$claude adversarial-review` when the change is high stakes.
- Run `$claude advise --background` when you want another model to check a
  plan, tradeoff, or evidence bundle.
- Run `$claude do --background` when the user wants Claude to perform a
  specific prepared task.
- Run `$claude rescue --background` when Codex stalls or you want Claude to
  take a deeper pass.

Adversarial review is especially useful for migrations, auth changes, infra
scripts, refactors, and work where the danger is hidden assumptions rather than
syntax errors.

## Requirements

- Codex with plugin marketplace support.
- Claude Code installed and authenticated on the same machine.
- Node.js 18.18 or newer.

## Local Development

From a local checkout:

```bash
codex plugin marketplace add ./
```

After installation, new Codex sessions should load the skill as
`claude-code-advisor:claude`. Codex writes an enabled plugin entry similar to:

```toml
[plugins."claude-code-advisor@claude-plugin-codex"]
enabled = true
```

## Usage

Use `$claude` in a Codex thread:

```text
$claude setup
$claude advise --background should this plan use a background worker?
$claude do --background --model sonnet map this package and cite file:line call sites
$claude do --background --model opus debug this cross-module failure with a prepared task
$claude rescue --background --model opus investigate the flaky integration test
$claude monitor <job-id>
$claude rescue --write fix the failing test with the smallest safe patch
$claude review --base main
$claude adversarial-review challenge the state management assumptions
$claude status
$claude result <job-id>
$claude cancel <job-id>
```

If your Codex build shows `/claude` in the slash menu, it is an alias for the
same skill.

## Monitoring

Use background mode when Claude may need more than one short answer:

```text
$claude rescue --background --model opus investigate the flaky integration test
$claude monitor <job-id>
```

MCP is off by default. If the workspace or an ancestor directory has
`.mcp.json`, the companion refuses background mode because Claude Code can
still open an interactive MCP permission picker before returning an answer.
Use foreground mode, or pass `--allow-mcp` only after the user explicitly asks
Claude to use MCP.

The monitor checks Claude every 30 seconds by default. It keeps raw logs in
JSON output, but the human view shows the useful signal: whether Claude is
active, the last meaningful line, how long output has been stale, and what to
do next.

`status` and `monitor` save the latest useful Claude output, so `result` can
recover it later even if you cancel the job or Claude's live log socket is gone.

Foreground `advise` and `rescue` calls have a two-minute timeout. If one times
out, the companion records the timed-out attempt and starts one background job
for the same prompt. Use `--background` up front for real advisor work; use
`--no-background-fallback` only when you want a timeout to fail fast.

## Safety

Review and adversarial review are read-only. `advise` and `rescue` are also
read-only unless you pass `--write`. Write-capable Claude work is recorded as a
separate job type.

`$claude do --model sonnet` is for prepared junior-agent work. Before using it,
Codex should apply `tasks-for-sonnet` and turn the request into a bounded task:
role, absolute paths, word cap, What Must Be True, Known Constraints, Mechanical
Verification, and Stop Conditions. Use it for scouts, mappers, verifiers,
single-concern reviewers, synthesis, or fully specified scaffolding. Do not use
Sonnet for broad application code that needs judgment.

`$claude do --model opus` is the backup for complex Claude tasks: ambiguous
debugging, broad refactors, architecture changes, auth, money, migrations, PII,
provider reliability, AI runtime paths, or work that needs the same level of
judgment you would reserve for GPT-5.5. Still prepare a specific task with
paths, constraints, allowed write scope, verification, and stop conditions.

Foreground `$claude advise`, `$claude do --model opus`, and
`$claude rescue --model opus` use a larger default turn budget for prepared
work. Pass `--max-turns <n>` to override it. `$claude review` and
`$claude adversarial-review` stay tight and structured with a single default
turn.

Managed Claude jobs ignore inherited MCP server config by default. This keeps
advisor and rescue runs from blocking on an interactive "enable MCP servers?"
prompt inside Codex.

The companion enforces this with strict non-interactive flags:

```bash
--mcp-config '{"mcpServers":{}}' --strict-mcp-config --no-chrome
```

Background mode has an extra guard: if the current directory or any ancestor
contains `.mcp.json`, background launch is blocked unless you pass
`--allow-mcp`. Do that only after the user explicitly asks Claude to use MCP.

Read-only prepared local tasks (`do` and `rescue`) use `Read,Glob,Grep` by
default. Web tools stay available for `advise`. For local prepared tasks, pass
`--allow-web` only when the task needs external URLs or docs; this keeps local
code reviews from stopping at a `WebFetch` permission prompt.

The plugin does not force Sonnet for advisor, review, adversarial-review, or
rescue work. It lets Claude Code use your configured default model unless you
explicitly pass another model. It uses xhigh effort by default for Claude
advisor work. Sonnet belongs in junior-agent delegation workflows, not in the
default advisor path.

The companion runtime tracks jobs by workspace and Codex thread ID when Codex
provides one. If it cannot safely infer a thread, it requires an explicit job
ID before resuming work.

Claude Code must already be installed and authenticated on the host:

```bash
claude auth login
```

## Privacy

This plugin does not run a hosted service. It runs the local Claude Code CLI on
your machine. Your local Claude Code installation and Anthropic account handle
prompts, file context, and command output sent to Claude Code.

The plugin stores job metadata and results under your local Codex home directory
so `$claude status`, `$claude result`, and `$claude cancel` can work across
turns. It does not intentionally collect analytics, phone home, or send data to
the repository owner.

## State Storage

By default the companion stores state under:

```text
~/.codex/claude-plugin-codex
```

Set `CLAUDE_COMPANION_STATE_ROOT` to use another local directory:

```bash
CLAUDE_COMPANION_STATE_ROOT=/path/to/writable/state \
  node plugins/claude-code-advisor/scripts/claude-companion.mjs setup --json
```

This is useful in sandboxed Codex environments where the default Codex home
path is readable but not writable. The state root should be local, private, and
excluded from version control because it can contain job prompts, Claude output,
workspace paths, and review results.

## Terms

This project is provided under the MIT License. You are responsible for how you
use Codex, Claude Code, and any data you send through those tools.

## How It Works

The `claude` skill routes each request to:

```bash
node "<plugin root>/scripts/claude-companion.mjs" <subcommand> <args>
```

The companion owns:

- command parsing
- Claude CLI invocation
- capability detection
- job state
- foreground and background lifecycle
- review JSON validation
- safety boundaries for read-only versus write-capable work

## Development

Use Node.js 24 for development. The repository includes `.node-version` for
compatible version managers, and CI also checks Node.js 20 and 22 compatibility.

```bash
npm test
npm run validate
```

Optional smoke test against the installed Claude CLI:

```bash
npm run test:smoke
CLAUDE_PLUGIN_CODEX_RUN_BG_SMOKE=1 npm run test:smoke
```

Optional end-to-end smoke test against an installed Codex plugin:

```bash
npm run test:e2e:codex
```

This requires `codex plugin marketplace add ./`, `Claude` installed from
Codex's plugin directory, and a logged-in Claude Code CLI. It starts a fresh
`codex exec` session and verifies that `$claude advise --model sonnet` routes
through the installed skill. The test uses Codex's `workspace-write` sandbox,
supplies a private temporary companion state root inside the checkout, and
removes that state before checking the worktree. Sonnet is used only for this
small routing test.

## Current Limits

- The plugin depends on the installed Claude Code CLI contract. Run
  `$claude setup` after upgrading Claude Code.
- Background mode is optional. If the companion cannot verify `claude --bg`,
  `claude agents`, `claude logs`, `claude attach`, and `claude stop`, it
  degrades to foreground-only behavior.
- Background mode refuses the current directory and ancestor directories with
  `.mcp.json` unless `--allow-mcp` is explicit. This avoids Claude Code's
  interactive MCP picker inside Codex, including nested worktrees under a repo
  that has MCP config.
- Read-only prepared local tasks disable web tools by default. `advise` remains
  web-capable. Use `--allow-web` for `do` or `rescue` only when the task needs
  web access.
- Foreground prepared task routes use a larger default turn budget than
  structured review. If Claude reports that it hit the max-turn limit, rerun
  with `--max-turns <higher>` or narrow the task.
- Working-tree structured reviews stop when untracked files exist because their
  contents are absent from a Git diff and review mode cannot read the workspace.
  Stage the intended files before rerunning the review.
- `$claude monitor` checks a background job every 30 seconds by default. It
  reads `claude logs` and `claude agents --json --all`, filters routine terminal
  noise, and marks repeated output as stale after two minutes.
- Structured review extracts a single complete JSON object from Claude's
  `--output-format json` result envelope, tolerating leading status prose or
  tool-call markup while rejecting ambiguous multiple objects. The extracted
  review payload is still validated strictly, and the companion retries once
  before failing.

## Troubleshooting

If Codex shows `Unable to load skill contents` after an update, restart Codex
or start a new thread. Codex may still point at an older cached skill path after
a plugin version bump. If the error remains, remove and reinstall the
`claude-plugin-codex` marketplace.

If `$claude setup` or a companion command fails with a write permission error
under `~/.codex/claude-plugin-codex`, rerun it with `CLAUDE_COMPANION_STATE_ROOT`
pointing at a writable directory. Within that root, the companion restricts its
workspace and thread directories to mode `0700` and state/pointer files to mode
`0600`. Do not point it at the project repository unless you also ignore that
path in Git.

## License

MIT.
