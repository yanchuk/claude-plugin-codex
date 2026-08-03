# Agent Instructions

This repo builds `claude-plugin-codex`, a Codex plugin that lets Codex consult
local Claude Code for advice, reviews, adversarial checks, and rescue tasks.
Codex remains the orchestrator.

## Scope

- Work only in this standalone repo.
- Do not modify `/Users/yanchuk/Documents/GitHub/skill-arsenal` for this
  project.
- Do not commit or push unless the latest user instruction explicitly asks for
  it.
- Keep plugin metadata public-release ready: `.codex-plugin/plugin.json`,
  `.agents/plugins/marketplace.json`, and `README.md` should stay consistent.
- Keep `package.json` and `plugins/claude-code-advisor/.codex-plugin/plugin.json`
  on the same version.

## Commands

- Run `npm run validate` before claiming the plugin is ready.
- Run `npm run test:smoke` after changes that touch Claude CLI invocation,
  runtime behavior, or install instructions.
- Run `npm run test:e2e:codex` after changes that affect Codex plugin routing,
  skill instructions, or public install behavior.

## Claude Model Policy

- Do not default Claude advisor, review, adversarial-review, rescue, or monitor
  work to Sonnet.
- Let Claude Code use the user's configured default model unless the user
  explicitly asks for another model.
- Use Fable only when the user explicitly asks for it; do not make it the
  advisor, review, rescue, or delegation default.
- Keep explicit model values as pass-through CLI arguments. Do not add a local
  allowlist that would reject full model names or future Claude Code aliases.
- Pass xhigh effort for Claude advisor, review, adversarial-review, rescue, and
  background work unless the user explicitly asks for another effort.
- Use Sonnet only for junior-agent delegation governed by the
  `tasks-for-sonnet` skill, where Sonnet acts as Hands, scout, verifier, or
  synthesis worker.

## Documentation

- Put public install instructions near the top of `README.md`.
- Write README and marketplace copy in plain, direct language.
- Do not document unsupported Codex plugin manifest fields as real features.
  `$claude` is the stable skill command. `/claude` and `/claude:rescue` are
  best-effort aliases only when Codex passes slash-style text through to the
  skill.

## Context7

Use the `ctx7` CLI for current documentation when working from docs for a
library, framework, SDK, API, CLI tool, or cloud service:

```bash
npx ctx7@latest library "<name>" "<question>"
npx ctx7@latest docs "<library-id>" "<question>"
```

Do not use Context7 for ordinary refactors, business-logic debugging, code
review, or scripts written from scratch.
