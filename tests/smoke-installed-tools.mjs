import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const companion = fileURLToPath(
  new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url)
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

console.log(run("claude", ["--version"]));

if (process.env.CLAUDE_PLUGIN_CODEX_RUN_BG_SMOKE === "1") {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-codex-smoke-"));
  const env = { ...process.env, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  let launched = null;
  let terminal = false;
  try {
    launched = JSON.parse(
      run(process.execPath, [
        companion,
        "do",
        "--background",
        "--model",
        "sonnet",
        "--effort",
        "low",
        "--json",
        "Reply exactly PASS. Do not inspect or modify files."
      ], { env })
    );
    if (launched.status !== "running" || !launched.claudeSessionId) {
      throw new Error(`Companion did not launch a background job:\n${JSON.stringify(launched)}`);
    }
    run(process.execPath, [companion, "monitor", launched.jobId, "--max-checks", "1", "--json"], { env });
    const stopped = JSON.parse(run(process.execPath, [companion, "cancel", launched.jobId, "--json"], { env }));
    if (!["cancelled", "completed"].includes(stopped.status)) {
      throw new Error(`Companion returned an unexpected terminal status:\n${JSON.stringify(stopped)}`);
    }
    terminal = true;
    const result = JSON.parse(run(process.execPath, [companion, "result", launched.jobId, "--json"], { env }));
    if (result.job.status !== stopped.status) {
      throw new Error(`Companion did not persist the terminal status:\n${JSON.stringify(result)}`);
    }
    console.log(`background companion lifecycle ok: ${launched.claudeSessionId}`);
  } finally {
    if (launched?.claudeSessionId && !terminal) {
      try {
        run("claude", ["stop", launched.claudeSessionId], { env, timeout: 10_000 });
      } catch {
        // Preserve the original smoke failure; this is only best-effort orphan cleanup.
      }
    }
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
} else {
  console.log("Skipping background smoke; set CLAUDE_PLUGIN_CODEX_RUN_BG_SMOKE=1 to run it.");
}
