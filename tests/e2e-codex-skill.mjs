import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.ok(fs.existsSync(path.join(repoRoot, "package.json")), "E2E repository root is invalid.");
const skillMarker = "claude-code-advisor:claude";
const advisePrompt = [
  "Use $claude advise --model sonnet --max-turns 1 --timeout-ms 120000 to ask Claude Code to reply with exactly PASS.",
  "Do not modify files.",
  "Return only a concise PASS/FAIL summary with the key command result."
].join(" ");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
    ...options
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseJsonLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const promptInput = run("codex", ["debug", "prompt-input", "Check Claude plugin availability."]);
assert.match(
  promptInput,
  new RegExp(skillMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  "Codex prompt input does not include the installed claude-code-advisor skill. Run `codex plugin marketplace add ./`, install Claude in Codex, and start a fresh Codex session."
);

const statusBefore = run("git", ["status", "--short"]);
const stateRoot = fs.mkdtempSync(path.join(repoRoot, ".claude-plugin-codex-e2e-state-"));
let execOutput;
try {
  execOutput = run("codex", ["exec", "--sandbox", "workspace-write", "--cd", repoRoot, "--json", advisePrompt], {
    input: "",
    env: { ...process.env, CLAUDE_COMPANION_STATE_ROOT: stateRoot }
  });
} finally {
  fs.rmSync(stateRoot, { recursive: true, force: true });
}
const events = parseJsonLines(execOutput);
const adviseCommand = events.find((event) => {
  return event.type === "item.completed"
    && event.item?.type === "command_execution"
    && event.item.command?.includes("claude-companion.mjs")
    && event.item.command?.includes("advise")
    && event.item.command?.includes("--model sonnet");
});

assert.ok(adviseCommand, "Codex did not route $claude advise --model sonnet through claude-companion.mjs.");
assert.equal(
  adviseCommand.item.exit_code,
  0,
  `claude-companion advise failed.\nCommand: ${adviseCommand.item.command}\nOutput:\n${adviseCommand.item.aggregated_output}`
);

assert.match(adviseCommand.item.aggregated_output, /PASS|completed/i);

const statusAfter = run("git", ["status", "--short"]);
assert.equal(statusAfter, statusBefore, "Codex E2E smoke changed the repository working tree.");

console.log("codex skill routing ok: Claude advise used --model sonnet");
