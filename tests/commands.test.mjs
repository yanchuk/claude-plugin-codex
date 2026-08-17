import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const companion = fileURLToPath(
  new URL("../plugins/claude-code-advisor/scripts/claude-companion.mjs", import.meta.url)
);

function makeFakeClaude(scriptBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${scriptBody}\n`, "utf8");
  fs.chmodSync(bin, 0o755);
  return { dir, bin };
}

function makeFakeClaudeExpectingMaxTurns(expected) {
  return makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--max-turns");
  if (args[index + 1] !== ${JSON.stringify(String(expected))}) {
    console.error("expected --max-turns ${expected}, got " + args[index + 1]);
    process.exit(2);
  }
  console.log("ok");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
}

test("setup writes a capabilities manifest and degrades background when lifecycle is unavailable", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") { console.log("logged in"); process.exit(0); }
if (args[0] === "logs") process.exit(2);
if (args[0] === "stop") process.exit(2);
if (args[0] === "attach") process.exit(2);
if (args[0] === "agents") process.exit(2);
if (args.includes("-p")) { console.log("{}"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  fs.chmodSync(stateRoot, 0o755);
  const stdout = execFileSync(process.execPath, [companion, "setup", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.ready, true);
  assert.equal(payload.capabilities.print, true);
  assert.equal(payload.capabilities.background, false);
  assert.equal(fs.statSync(stateRoot).mode & 0o777, 0o755);
  const workspaceIndex = fs.readdirSync(stateRoot).find((entry) => entry.startsWith("claude-state-"));
  assert.ok(workspaceIndex);
  const indexDir = path.join(stateRoot, workspaceIndex);
  const latestStateFile = path.join(indexDir, "latest-state-dir");
  const stateDir = fs.readFileSync(latestStateFile, "utf8").trim();
  assert.equal(fs.statSync(indexDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(stateDir, "state.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(latestStateFile).mode & 0o777, 0o600);
});

test("review returns validated JSON and stores result", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  console.log(JSON.stringify({findings:[{severity:"MAJOR",title:"Gap",fact:"No test",recommendation:"Add test"}]}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = {
    ...process.env,
    PATH: `${fake.dir}:${process.env.PATH}`,
    CLAUDE_COMPANION_STATE_ROOT: stateRoot,
    CODEX_THREAD_ID: "thread-a"
  };
  const stdout = execFileSync(process.execPath, [companion, "review", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.result.findings[0].severity, "MAJOR");

  const result = execFileSync(process.execPath, [companion, "result", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(result).job.id, payload.jobId);
});

test("review base range includes the patch in the Claude prompt", () => {
  const promptLog = path.join(os.tmpdir(), `fake-review-base-${Date.now()}.log`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-p")) {
  fs.writeFileSync(${JSON.stringify(promptLog)}, args[args.indexOf("-p") + 1]);
  console.log(JSON.stringify({findings:[]}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-base-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "sample.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "sample.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(repo, "sample.txt"), "after-base-range\n", "utf8");
  execFileSync("git", ["add", "sample.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "change"], { cwd: repo });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));

  execFileSync(process.execPath, [companion, "review", "--base", base, "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: repo,
    encoding: "utf8"
  });

  assert.match(fs.readFileSync(promptLog, "utf8"), /after-base-range/);
});

test("working-tree review includes staged patch content", () => {
  const promptLog = path.join(os.tmpdir(), `fake-review-staged-${Date.now()}.log`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("-p")) {
  fs.writeFileSync(${JSON.stringify(promptLog)}, args[args.indexOf("-p") + 1]);
  console.log(JSON.stringify({findings:[]}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-staged-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "sample.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "sample.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "sample.txt"), "after-staging\n", "utf8");
  execFileSync("git", ["add", "sample.txt"], { cwd: repo });
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));

  execFileSync(process.execPath, [companion, "review", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: repo,
    encoding: "utf8"
  });

  assert.match(fs.readFileSync(promptLog, "utf8"), /after-staging/);
});

test("working-tree review refuses untracked files whose contents would be omitted", () => {
  const fake = makeFakeClaude(`
console.error("Claude should not run when untracked files are present");
process.exit(2);
`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claude-review-untracked-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "new-source.mjs"), "export const value = 1;\n", "utf8");
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));

  const reviewed = spawnSync(process.execPath, [companion, "review", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: repo,
    encoding: "utf8"
  });

  assert.notEqual(reviewed.status, 0);
  assert.match(reviewed.stderr, /Stage the intended files first/);
  assert.match(reviewed.stderr, /new-source\.mjs/);
});

test("background advise stores Claude session id and cancel calls claude stop", () => {
  const stopLog = path.join(os.tmpdir(), `fake-stop-${Date.now()}.log`);
  const fake = makeFakeClaude(`
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") { console.log("latest output"); process.exit(0); }
if (args[0] === "stop") { fs.writeFileSync(${JSON.stringify(stopLog)}, args[1]); console.log("stopped " + args[1]); process.exit(0); }
if (args[0] === "agents") { console.log("11 active agents"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");

  const cancel = execFileSync(process.execPath, [companion, "cancel", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(cancel).status, "cancelled");
  assert.equal(fs.readFileSync(stopLog, "utf8"), "bg123");

  const result = execFileSync(process.execPath, [companion, "result", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const stored = JSON.parse(result);
  assert.equal(stored.job.status, "cancelled");
  assert.equal(stored.result, "latest output");
  assert.equal(stored.job.lastMeaningfulOutput, "latest output");
});

test("cancel fails without persisting cancellation when Claude stop fails", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg-stop-fails (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") { console.log("still working"); process.exit(0); }
if (args[0] === "agents") { console.log(JSON.stringify([{ id: "bg-stop-fails", status: "running" }])); process.exit(0); }
if (args[0] === "stop") { console.error("stop failed"); process.exit(2); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = JSON.parse(execFileSync(
    process.execPath,
    [companion, "advise", "--background", "check architecture", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  ));

  const cancelled = spawnSync(
    process.execPath,
    [companion, "cancel", launched.jobId, "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );

  assert.notEqual(cancelled.status, 0);
  assert.match(cancelled.stderr, /stop failed/);
  const stored = JSON.parse(execFileSync(
    process.execPath,
    [companion, "result", launched.jobId, "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  ));
  assert.equal(stored.job.status, "running");
});

test("review defaults to a single Claude turn", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--max-turns");
  if (args[index + 1] !== "1") {
    console.error("expected --max-turns 1, got " + args[index + 1]);
    process.exit(2);
  }
  console.log(JSON.stringify({findings:[]}));
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "review", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
});

test("monitor polls Claude logs and active agent state", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") { console.log("\\u001b7\\u001b[31mprogress: still working\\u001b[39m\\u001b8"); process.exit(0); }
if (args[0] === "agents") { console.log("bg123 running"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const job = JSON.parse(launched);
  const watched = execFileSync(
    process.execPath,
    [companion, "monitor", job.jobId, "--interval-ms", "1", "--max-checks", "2", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const snapshots = watched.trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].active, true);
  assert.equal(snapshots[0].logs.output, "progress: still working");

  const result = execFileSync(process.execPath, [companion, "result", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const stored = JSON.parse(result);
  assert.equal(stored.result, "progress: still working");
  assert.equal(stored.job.lastMonitorSnapshot.summary.lastMeaningfulLine, "progress: still working");
});

test("monitor uses agents json state to mark a background job completed", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") { console.log("final answer available"); process.exit(0); }
if (JSON.stringify(args) === JSON.stringify(["agents", "--json", "--all"])) {
  console.log(JSON.stringify([{ id: "bg123", status: "idle", state: "done" }]));
  process.exit(0);
}
if (args[0] === "agents") { console.error("agents must be read with --json"); process.exit(2); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const job = JSON.parse(launched);
  const watched = execFileSync(process.execPath, [companion, "monitor", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const snapshot = JSON.parse(watched.trim());

  assert.equal(snapshot.active, false);
  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.agents.match.state, "done");

  const result = execFileSync(process.execPath, [companion, "result", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const stored = JSON.parse(result);
  assert.equal(stored.job.status, "completed");
  assert.equal(stored.result, "final answer available");
});

test("monitor summarizes meaningful progress and stale repeated logs", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") {
  console.log("Claude Code");
  console.log("✻ Thinking with xhigh effort");
  console.log("❯");
  console.log("progress: compiling tests");
  console.log("Zigzagging…");
  process.exit(0);
}
if (args[0] === "agents") { console.log("bg123 running"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const job = JSON.parse(launched);
  const watched = execFileSync(
    process.execPath,
    [
      companion,
      "monitor",
      job.jobId,
      "--interval-ms",
      "1",
      "--max-checks",
      "2",
      "--stale-after-ms",
      "0",
      "--json"
    ],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const snapshots = watched.trim().split(/\r?\n/).map((line) => JSON.parse(line));

  assert.equal(snapshots[0].summary.state, "active");
  assert.equal(snapshots[0].summary.lastMeaningfulLine, "progress: compiling tests");
  assert.equal(snapshots[0].summary.stale, false);
  assert.equal(snapshots[0].summary.suggestedAction, "Wait or keep monitoring.");
  assert.equal(snapshots[1].summary.stale, true);
  assert.match(snapshots[1].summary.suggestedAction, /stalled/i);

  const human = execFileSync(
    process.execPath,
    [companion, "monitor", job.jobId, "--interval-ms", "1", "--max-checks", "1"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  assert.match(human, /Last meaningful output: progress: compiling tests/);
  assert.doesNotMatch(human, /Thinking with xhigh effort/);
});

test("monitor treats cooked Claude background logs as completed and extracts the answer", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") { console.log("backgrounded · bg123 (idle - send a prompt to start)"); process.exit(0); }
if (args[0] === "logs") {
  console.log("Claude Codev2.1.132");
  console.log("Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.");
  console.log("at refresh (internal:util/colors:18:31)");
  console.log("at loadAssertionError (node:assert:28:96)");
  console.log("▝▜█████▛▘Opus 4.7 with xhigh effort");
  console.log("▘▘ ▝▝  ~/Documents/GitHub/claude-plugin-codex");
  console.log("❯ Return exactly PASS.");
  console.log("✳Hyperspacing…");
  console.log("Honking…2");
  console.log("Whisking…2");
  console.log("⏺PASS");
  console.log("✻Cogitated for 6s");
  console.log("❯");
  process.exit(0);
}
if (args[0] === "agents") { console.log("11 active agents"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const launched = execFileSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const job = JSON.parse(launched);
  const watched = execFileSync(process.execPath, [companion, "monitor", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const snapshot = JSON.parse(watched.trim());

  assert.equal(snapshot.active, false);
  assert.equal(snapshot.completed, true);
  assert.equal(snapshot.summary.state, "inactive");
  assert.equal(snapshot.summary.lastMeaningfulLine, "PASS");

  const result = execFileSync(process.execPath, [companion, "result", job.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const stored = JSON.parse(result);
  assert.equal(stored.job.status, "completed");
  assert.equal(stored.result, "PASS");
});

test("foreground advise defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "advise", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground do defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "do", "inspect local code", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground rescue defaults to a larger turn budget", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(20);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "rescue", "diagnose the failure", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground task max-turn override takes precedence over the default", () => {
  const fake = makeFakeClaudeExpectingMaxTurns(5);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(
    process.execPath,
    [companion, "do", "--max-turns", "5", "inspect local code", "--json"],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("foreground task max-turn failure includes rerun hint", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  console.error("Claude hit max turns before producing a result.");
  process.exit(1);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "do", "inspect local code", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "failed");
  assert.match(payload.output, /Claude hit the max-turn limit/);
  assert.match(payload.output, /--max-turns <higher>/);
});

test("foreground advise defaults to xhigh effort", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const index = args.indexOf("--effort");
  if (args[index + 1] !== "xhigh") {
    console.error("expected --effort xhigh, got " + args[index + 1]);
    process.exit(2);
  }
  console.log("ok");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "advise", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "ok");
});

test("background advise defaults to xhigh effort", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  const index = args.indexOf("--effort");
  if (args[index + 1] !== "xhigh") {
    console.error("expected --effort xhigh, got " + args[index + 1]);
    process.exit(2);
  }
  console.log("backgrounded · bg123 (idle - send a prompt to start)");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");
});

test("background advise refuses project MCP config unless explicitly allowed", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  console.error("background should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  fs.writeFileSync(path.join(stateRoot, ".mcp.json"), '{"mcpServers":{"playwright":{}}}\n', "utf8");
  const result = spawnSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.mcp\.json/);
  assert.match(result.stderr, /--allow-mcp/);
});

test("background advise refuses MCP config above a nested worktree", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  console.error("background should not launch");
  process.exit(2);
}
console.error("unsupported"); process.exit(2);
`);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "claude-parent-mcp-"));
  const child = path.join(parent, ".worktrees", "task");
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(parent, ".mcp.json"), '{"mcpServers":{"playwright":{}}}\n', "utf8");
  fs.writeFileSync(path.join(child, ".git"), "gitdir: ../.git/worktrees/task\n", "utf8");
  const result = spawnSync(process.execPath, [companion, "advise", "--background", "check architecture", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: parent },
    cwd: child,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.mcp\\.json`));
  assert.match(result.stderr, /--allow-mcp/);
});

test("background advise allows project MCP only with explicit opt-in", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  if (args.includes("--mcp-config") || args.includes("--strict-mcp-config")) {
    console.error("expected explicit MCP opt-in to avoid empty strict config");
    process.exit(2);
  }
  console.log("backgrounded · bg123 (idle - send a prompt to start)");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  fs.writeFileSync(path.join(stateRoot, ".mcp.json"), '{"mcpServers":{"playwright":{}}}\n', "utf8");
  const stdout = execFileSync(
    process.execPath,
    [companion, "advise", "--background", "--allow-mcp", "check architecture", "--json"],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");
});

test("read-only do defaults to local read-only tools without WebFetch", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  const tools = args[args.indexOf("--tools") + 1];
  if (tools !== "Read,Glob,Grep") {
    console.error("expected local read-only tools, got " + tools);
    process.exit(2);
  }
  console.log("done");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "do", "inspect local code", "--json"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "done");
});

test("foreground advise falls back to background on timeout", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args[0] === "--bg") {
  console.log("backgrounded · bg123 (idle - send a prompt to start)");
  process.exit(0);
}
if (args.includes("-p")) {
  setTimeout(() => process.exit(0), 5000);
} else {
  console.error("unsupported"); process.exit(2);
}
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(
    process.execPath,
    [companion, "advise", "--timeout-ms", "50", "check architecture", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);

  assert.equal(payload.status, "running");
  assert.equal(payload.claudeSessionId, "bg123");
  assert.match(payload.output, /Foreground Claude timed out/);

  const status = execFileSync(process.execPath, [companion, "status", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(status).job.fallbackReason, "foreground-timeout");
});

test("foreground advise can disable timeout background fallback", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  setTimeout(() => process.exit(0), 5000);
} else {
  console.error("unsupported"); process.exit(2);
}
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(
    process.execPath,
    [companion, "advise", "--timeout-ms", "50", "--no-background-fallback", "slow"],
    {
      env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
      cwd: stateRoot,
      encoding: "utf8"
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out/);
});

test("foreground advise prints human output by default", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) { console.log("human answer"); process.exit(0); }
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const stdout = execFileSync(process.execPath, [companion, "advise", "check architecture"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.equal(stdout, "human answer\n");
});

test("rescue runs as a managed task and preserves explicit write mode", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("default")) {
    console.error("expected write-capable default permission mode");
    process.exit(2);
  }
  console.log("rescued");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(process.execPath, [companion, "rescue", "--write", "fix the failing test", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^rescue-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "rescued");

  const result = execFileSync(process.execPath, [companion, "result", payload.jobId, "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  assert.equal(JSON.parse(result).job.write, true);
});

test("rescue is read-only unless --write is explicit", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.132 (Claude Code)"); process.exit(0); }
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("plan")) {
    console.error("expected plan permission mode");
    process.exit(2);
  }
  console.log("diagnosis only");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(process.execPath, [companion, "rescue", "diagnose the failure", "--json"], {
    env,
    cwd: stateRoot,
    encoding: "utf8"
  });
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^rescue-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "diagnosis only");
});

test("do runs a prepared Claude task and preserves explicit write mode", () => {
  const fake = makeFakeClaude(`
const args = process.argv.slice(2);
if (args.includes("-p")) {
  if (!args.includes("--permission-mode") || !args.includes("default")) {
    console.error("expected write-capable default permission mode");
    process.exit(2);
  }
  if (!args.includes("--model") || args[args.indexOf("--model") + 1] !== "sonnet") {
    console.error("expected explicit sonnet model");
    process.exit(2);
  }
  console.log("done");
  process.exit(0);
}
console.error("unsupported"); process.exit(2);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const env = { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot };
  const stdout = execFileSync(
    process.execPath,
    [companion, "do", "--write", "--model", "sonnet", "implement the prepared task", "--json"],
    { env, cwd: stateRoot, encoding: "utf8" }
  );
  const payload = JSON.parse(stdout);

  assert.match(payload.jobId, /^do-/);
  assert.equal(payload.status, "completed");
  assert.equal(payload.output, "done");
});

test("foreground timeout fails the job without hanging", () => {
  const fake = makeFakeClaude(`
setTimeout(() => {}, 5000);
`);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-state-"));
  const result = spawnSync(process.execPath, [companion, "advise", "--timeout-ms", "50", "--no-background-fallback", "slow"], {
    env: { ...process.env, PATH: `${fake.dir}:${process.env.PATH}`, CLAUDE_COMPANION_STATE_ROOT: stateRoot },
    cwd: stateRoot,
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out/);
});
