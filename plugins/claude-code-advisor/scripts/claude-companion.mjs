#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  buildBackgroundArgs,
  buildClaudeArgs,
  buildReviewPrompt,
  generateJobId,
  loadState,
  parseClaudeJsonResult,
  parseBackgroundLaunch,
  renderHuman,
  resolveStateDir,
  resolveStateRoot,
  resolveWorkspaceIndexDir,
  resolveWorkspaceRoot,
  saveState,
  selectResumeCandidate,
  upsertJob,
  validateReviewPayload
} from "./lib/runtime.mjs";

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_TASK_MAX_TURNS = 20;
const DEFAULT_REVIEW_MAX_TURNS = 1;
const DEFAULT_MONITOR_INTERVAL_MS = 30000;
const DEFAULT_MONITOR_CHECKS = 20;
const DEFAULT_STALE_AFTER_MS = 120000;
const DEFAULT_CLAUDE_EFFORT = "xhigh";
const SUPPORTED_MAJOR = 2;

function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (
      [
        "json",
        "background",
        "write",
        "resume",
        "fresh",
        "watch",
        "follow",
        "forever",
        "no-background-fallback",
        "allow-mcp",
        "allow-web"
      ].includes(key)
    ) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null) {
      throw new Error(`Missing value for --${key}.`);
    }
    options[key] = value;
    index += 1;
  }
  return { options, positionals };
}

function output(value, asJson) {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : renderHuman(value));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stripTerminalControl(value) {
  return String(value || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[78]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function normalizeLogLine(line) {
  return String(line || "")
    .trim()
    .replace(/^⏺\s*/, "")
    .trim();
}

function isCompletedLogOutput(output) {
  return /(?:^|\n)\s*[✢✳✶✻✽·]?\s*(?:cogitated|cooked|churned|worked) for \d+/i.test(String(output || ""));
}

function isMeaningfulLogLine(line) {
  const text = normalizeLogLine(line);
  if (!text) {
    return false;
  }
  const withoutSpinner = text.replace(/^[✢✳✶✻✽·\s]+/, "");
  if (text.length < 3) {
    return false;
  }
  if (/^[━─▐▛▜▝▘▌█\s]+$/.test(text)) {
    return false;
  }
  if (text.includes("~/") || /^~?\//.test(text) || /\/effort\b/i.test(text)) {
    return false;
  }
  if (/codex-[a-z]+-/i.test(text)) {
    return false;
  }
  if (/^[❯>]+$/.test(text)) {
    return false;
  }
  if (/^❯/.test(text)) {
    return false;
  }
  if (/^claude code$/i.test(text)) {
    return false;
  }
  if (/claude codev?\d/i.test(text)) {
    return false;
  }
  if (/^warning: the 'NO_COLOR' env is ignored/i.test(text) || /^at\s+/.test(text) || /\binternal:/.test(text)) {
    return false;
  }
  if (/fable|opus|sonnet|haiku|claude max/i.test(text)) {
    return false;
  }
  if (/thinking with .* effort/i.test(text)) {
    return false;
  }
  if (/^(zigzagging|hyperspacing|whisking|honking|thinking|cogitated|cooking|cooked|churned|worked)\b/i.test(withoutSpinner)) {
    return false;
  }
  if (/^[a-z]{1,3}$/i.test(withoutSpinner)) {
    return false;
  }
  if (/^[a-z]+…\d*$/i.test(withoutSpinner)) {
    return false;
  }
  if (/^\(\d+s\s+·\s+↓\d+\s+tokens\)$/i.test(withoutSpinner)) {
    return false;
  }
  if (/^running .* hook\b/i.test(withoutSpinner)) {
    return false;
  }
  if (/^ctx:\d+%/i.test(withoutSpinner)) {
    return false;
  }
  if (/^claude in chrome\b/i.test(withoutSpinner)) {
    return false;
  }
  if (/^try "/i.test(withoutSpinner)) {
    return false;
  }
  if (/plan mode on/i.test(text)) {
    return false;
  }
  if (/^(esc|ctrl|shift|enter|tab)\b/i.test(text)) {
    return false;
  }
  if (/^(mcp|warning: mcp|connecting|connected)\b/i.test(text)) {
    return false;
  }
  if (/^[.·*\-_=|/\\()[\]{}<>:;,'"~`!@#$%^&+\s]+$/.test(text)) {
    return false;
  }
  return true;
}

function extractMeaningfulLogLines(output) {
  return stripTerminalControl(output)
    .split(/\r?\n/)
    .map(normalizeLogLine)
    .filter(isMeaningfulLogLine);
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function runClaude(args, options = {}) {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const result = spawnSync("claude", args, {
    cwd: options.cwd || process.cwd(),
    env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`Claude command timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);
  }
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status ?? 0,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function isTimeoutError(error) {
  return /timed out after \d+ms/i.test(String(error?.message || error || ""));
}

function isMaxTurnLimitOutput(value) {
  const text = String(value || "");
  return /\b(?:hit|reached)\s+(?:the\s+)?max[- ]turns?\b/i.test(text) || /\bmax[- ]turn limit\b/i.test(text);
}

function resultWithMaxTurnHint(result) {
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (!isMaxTurnLimitOutput(combined)) {
    return result.stdout.trim();
  }
  return [
    (result.stdout || result.stderr || "").trim(),
    "Claude hit the max-turn limit. Rerun with `--max-turns <higher>` or narrow the task."
  ]
    .filter(Boolean)
    .join("\n");
}

function commandAvailable(commandArgs) {
  const result = runClaude(commandArgs, { timeoutMs: 10000 });
  return result.status === 0;
}

function parseClaudeVersion(stdout) {
  const version = String(stdout || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!version) {
    return { raw: String(stdout || "").trim(), supported: false };
  }
  const major = Number(version[1]);
  return {
    raw: String(stdout || "").trim(),
    major,
    minor: Number(version[2]),
    patch: Number(version[3]),
    supported: major === SUPPORTED_MAJOR || process.env.CLAUDE_PLUGIN_CODEX_ALLOW_UNKNOWN_CLAUDE === "1"
  };
}

function currentContext(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateRoot = resolveStateRoot(process.env);
  const stateDir = resolveStateDir(workspaceRoot, process.env, stateRoot);
  const indexDir = resolveWorkspaceIndexDir(workspaceRoot, process.env, stateRoot);
  return {
    cwd,
    workspaceRoot,
    stateRoot,
    stateDir,
    indexDir,
    state: loadState(stateDir)
  };
}

function findProjectMcpConfig(ctx) {
  const checked = new Set();
  let current = ctx.cwd;
  while (true) {
    const configPath = path.join(current, ".mcp.json");
    if (!checked.has(configPath) && fs.existsSync(configPath)) {
      return configPath;
    }
    checked.add(configPath);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function assertBackgroundMcpSafe(ctx, options = {}) {
  if (options["allow-mcp"]) {
    return;
  }
  const configPath = findProjectMcpConfig(ctx);
  if (!configPath) {
    return;
  }
  throw new Error(
    [
      `Refusing Claude background mode because ${configPath} exists.`,
      "Claude Code background mode can still open an MCP permission picker before noninteractive flags take effect.",
      "MCP is disabled unless the user explicitly asks for it.",
      "Run foreground, or pass --allow-mcp only after explicit user approval."
    ].join(" ")
  );
}

function persistContext(ctx, state) {
  const saved = saveState(ctx.stateDir, state);
  fs.mkdirSync(ctx.indexDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.indexDir, "latest-state-dir"), `${ctx.stateDir}\n`, "utf8");
  return saved;
}

function gitContext(cwd, options = {}) {
  const target = options.base ? `${options.base}...HEAD` : null;
  const args = target ? ["diff", "--stat", target] : ["status", "--short", "--untracked-files=all"];
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  const first = result.status === 0 ? result.stdout : result.stderr;
  const diffArgs = target ? ["diff", "--", target] : ["diff", "--"];
  const diff = spawnSync("git", diffArgs, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
  return [first, diff.status === 0 ? diff.stdout : ""].join("\n").trim();
}

function detectCapabilities() {
  const versionResult = runClaude(["--version"], { timeoutMs: 10000 });
  const version = parseClaudeVersion(versionResult.stdout || versionResult.stderr);
  const auth = runClaude(["auth", "status", "--text"], { timeoutMs: 10000 });
  const print = commandAvailable(["-p", "Return {}", "--output-format", "text", "--max-turns", "1", "--tools", ""]);
  const agents = commandAvailable(["agents", "--help"]);
  const logs = commandAvailable(["logs", "--help"]);
  const stop = commandAvailable(["stop", "--help"]);
  const attach = commandAvailable(["attach", "--help"]);
  const background = version.supported && agents && logs && stop && attach;
  return {
    version,
    auth: {
      loggedIn: auth.status === 0,
      detail: (auth.stdout || auth.stderr).trim()
    },
    print,
    agents,
    logs,
    stop,
    attach,
    background
  };
}

function handleSetup(argv) {
  const { options } = parseArgs(argv);
  const ctx = currentContext(options);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const capabilities = detectCapabilities();
  const ready = nodeMajor >= 18 && capabilities.version.supported && capabilities.auth.loggedIn && capabilities.print;
  const state = persistContext(ctx, { ...ctx.state, capabilities });
  output(
    {
      ready,
      node: { version: process.version, supported: nodeMajor >= 18 },
      capabilities: state.capabilities,
      stateDir: ctx.stateDir
    },
    options.json
  );
}

function createJob(ctx, kind, options = {}) {
  return {
    id: generateJobId(kind),
    kind,
    status: "running",
    write: Boolean(options.write),
    codexThreadId: process.env.CODEX_THREAD_ID || null,
    workspaceRoot: ctx.workspaceRoot,
    summary: options.summary || kind
  };
}

function completeJob(ctx, job, patch) {
  const state = upsertJob(ctx.state, { ...job, ...patch });
  ctx.state = persistContext(ctx, state);
  return ctx.state.jobs.find((item) => item.id === job.id);
}

function runForeground(ctx, kind, prompt, options = {}) {
  const job = createJob(ctx, kind, { write: options.write, summary: prompt.slice(0, 100) });
  ctx.state = persistContext(ctx, upsertJob(ctx.state, job));
  const resume = options.resume ? selectResumeCandidate(ctx.state.jobs.filter((item) => item.id !== job.id), process.env, options) : null;
  const args = buildClaudeArgs({
    mode: kind,
    prompt,
    outputFormat: options.outputFormat || "text",
    maxTurns: Number(options.maxTurns || DEFAULT_TASK_MAX_TURNS),
    write: Boolean(options.write),
    resumeSessionId: resume?.claudeSessionId ?? null,
    model: options.model || null,
    effort: options.effort || DEFAULT_CLAUDE_EFFORT,
    allowMcp: Boolean(options["allow-mcp"]),
    allowWeb: Boolean(options["allow-web"])
  });
  let result;
  try {
    result = runClaude(args, { cwd: ctx.cwd, timeoutMs: Number(options.timeoutMs || DEFAULT_TIMEOUT_MS) });
  } catch (error) {
    if (isTimeoutError(error) && !options["no-background-fallback"]) {
      completeJob(ctx, job, {
        status: "timed_out",
        stderr: error.message,
        result: error.message
      });
      if (ctx.state.capabilities && !ctx.state.capabilities.background) {
        throw error;
      }
      return runBackground(ctx, kind, prompt, {
        ...options,
        timeoutMs: options["background-timeout-ms"] || options.backgroundTimeoutMs || 30000,
        fallbackFromJobId: job.id,
        fallbackReason: "foreground-timeout",
        fallbackMessage: `Foreground Claude timed out after ${Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)}ms; launched a background job.`
      });
    }
    completeJob(ctx, job, {
      status: "failed",
      stderr: error.message,
      result: error.message
    });
    throw error;
  }
  const status = result.status === 0 ? "completed" : "failed";
  return completeJob(ctx, job, {
    status,
    stdout: result.stdout,
    stderr: result.stderr,
    claudeSessionId: resume?.claudeSessionId ?? null,
    result: result.status === 0 ? result.stdout.trim() : resultWithMaxTurnHint(result)
  });
}

function runBackground(ctx, kind, prompt, options = {}) {
  if (ctx.state.capabilities && !ctx.state.capabilities.background) {
    throw new Error("Claude background mode is unavailable. Run foreground or rerun setup after upgrading Claude Code.");
  }
  assertBackgroundMcpSafe(ctx, options);
  const job = createJob(ctx, kind, { write: options.write, summary: prompt.slice(0, 100) });
  const args = buildBackgroundArgs({
    prompt,
    name: `codex-${job.id}`,
    mode: kind,
    write: Boolean(options.write),
    model: options.model || null,
    effort: options.effort || DEFAULT_CLAUDE_EFFORT,
    allowMcp: Boolean(options["allow-mcp"]),
    allowWeb: Boolean(options["allow-web"])
  });
  const result = runClaude(args, { cwd: ctx.cwd, timeoutMs: Number(options.timeoutMs || 30000) });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Claude background launch failed.");
  }
  const claudeSessionId = parseBackgroundLaunch(result.stdout);
  if (!claudeSessionId) {
    throw new Error(`Could not parse Claude background session id from output:\n${result.stdout}`);
  }
  const next = completeJob(ctx, job, {
    status: "running",
    claudeSessionId,
    stdout: result.stdout,
    result: options.fallbackMessage ? `${options.fallbackMessage}\nClaude session: ${claudeSessionId}` : result.stdout.trim(),
    fallbackFromJobId: options.fallbackFromJobId || null,
    fallbackReason: options.fallbackReason || null
  });
  return next;
}

function handleTaskCommand(argv, kind) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  const prompt = positionals.join(" ").trim();
  const job = options.background
    ? runBackground(ctx, kind, prompt, options)
    : runForeground(ctx, kind, prompt, {
        ...options,
        outputFormat: options["output-format"] || "text",
        maxTurns: options["max-turns"],
        timeoutMs: options["timeout-ms"]
      });
  output(
    {
      jobId: job.id,
      status: job.status,
      claudeSessionId: job.claudeSessionId ?? null,
      output: job.result ?? job.stdout ?? ""
    },
    options.json
  );
}

function handleAdvise(argv) {
  handleTaskCommand(argv, "advise");
}

function handleRescue(argv) {
  handleTaskCommand(argv, "rescue");
}

function handleDo(argv) {
  handleTaskCommand(argv, "do");
}

function handleReview(argv, kind) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  const focus = positionals.join(" ").trim();
  const prompt = buildReviewPrompt({
    kind,
    targetLabel: options.base ? `${options.base}...HEAD` : "working tree",
    gitContext: gitContext(ctx.cwd, options),
    focus
  });
  const job = runForeground(ctx, kind, prompt, {
    ...options,
    outputFormat: "json",
    maxTurns: options["max-turns"] || DEFAULT_REVIEW_MAX_TURNS,
    timeoutMs: options["timeout-ms"]
  });
  if (job.status !== "completed") {
    output({ jobId: job.id, status: job.status, stderr: job.stderr }, options.json);
    process.exitCode = 1;
    return;
  }
  let parsed;
  let claudeJson;
  try {
    claudeJson = parseClaudeJsonResult(job.stdout);
    parsed = validateReviewPayload(claudeJson.contentRaw);
  } catch (error) {
    const retry = runForeground(ctx, kind, `${prompt}\n\nYour previous response was invalid: ${error.message}. Return JSON only.`, {
      ...options,
      outputFormat: "json",
      maxTurns: 1,
      timeoutMs: options["timeout-ms"]
    });
    claudeJson = parseClaudeJsonResult(retry.stdout);
    parsed = validateReviewPayload(claudeJson.contentRaw);
    Object.assign(job, retry);
  }
  const completed = completeJob(ctx, job, {
    result: parsed,
    claudeSessionId: claudeJson.sessionId ?? job.claudeSessionId ?? null,
    claudeEnvelope: claudeJson.envelope
  });
  output({ jobId: completed.id, status: completed.status, result: parsed }, options.json);
}

function findJob(ctx, reference) {
  if (!reference) {
    return ctx.state.jobs[0] || null;
  }
  return ctx.state.jobs.find((job) => job.id === reference || job.claudeSessionId === reference) || null;
}

function readLiveStatus(job, options = {}) {
  if (!job?.claudeSessionId) {
    return {
      checkedAt: new Date().toISOString(),
      active: false,
      available: false,
      error: "Job has no Claude background session id.",
      job
    };
  }
  const timeoutMs = Number(options["timeout-ms"] || 10000);
  const logs = runClaude(["logs", job.claudeSessionId], { timeoutMs });
  const agents = runClaude(["agents"], { timeoutMs });
  const agentsOutput = stripTerminalControl(`${agents.stdout || ""}${agents.stderr || ""}`);
  const logsOutput = stripTerminalControl(`${logs.stdout || ""}${logs.stderr || ""}`);
  const meaningfulLogLines = extractMeaningfulLogLines(logsOutput);
  const completed = isCompletedLogOutput(logsOutput);
  return {
    checkedAt: new Date().toISOString(),
    jobId: job.id,
    claudeSessionId: job.claudeSessionId,
    active: logs.status === 0 && !completed,
    completed,
    available: logs.status === 0 || agents.status === 0,
    logs: {
      available: logs.status === 0,
      output: logsOutput.trim(),
      meaningfulOutput: meaningfulLogLines.join("\n")
    },
    agents: {
      available: agents.status === 0,
      output: agentsOutput.trim()
    }
  };
}

function summarizeLiveStatus(snapshot, monitorState = {}, options = {}) {
  const staleAfterMs = Number(options["stale-after-ms"] ?? DEFAULT_STALE_AFTER_MS);
  const nowMs = Date.parse(snapshot.checkedAt) || Date.now();
  const meaningfulOutput = snapshot.logs?.meaningfulOutput || "";
  const meaningfulLines = meaningfulOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fingerprint = meaningfulLines.join("\n");
  const previousFingerprint = monitorState.meaningfulFingerprint || null;
  const isRepeatedMeaningfulOutput = Boolean(fingerprint && previousFingerprint === fingerprint);

  if (fingerprint && previousFingerprint !== fingerprint) {
    monitorState.meaningfulFingerprint = fingerprint;
    monitorState.meaningfulChangedAtMs = nowMs;
    monitorState.repeatedMeaningfulChecks = 0;
  } else if (fingerprint && previousFingerprint === fingerprint) {
    monitorState.repeatedMeaningfulChecks = (monitorState.repeatedMeaningfulChecks || 0) + 1;
  }

  const changedAtMs = monitorState.meaningfulChangedAtMs || nowMs;
  const staleForMs = isRepeatedMeaningfulOutput ? Math.max(0, nowMs - changedAtMs) : 0;
  const stale = Boolean(snapshot.active && fingerprint && isRepeatedMeaningfulOutput && staleForMs >= staleAfterMs);
  const lastMeaningfulLine = meaningfulLines.at(-1) || null;
  let state = snapshot.active ? "active" : "inactive";
  if (!snapshot.available) {
    state = "unavailable";
  } else if (stale) {
    state = "stale";
  }

  let suggestedAction = "Check the job result or cancel it.";
  if (state === "active") {
    suggestedAction = "Wait or keep monitoring.";
  } else if (state === "stale") {
    suggestedAction = "Claude may be stalled. Continue monitoring, inspect logs, or cancel the job.";
  } else if (state === "unavailable") {
    suggestedAction = "Check whether Claude Code is installed and the background session still exists.";
  }

  return {
    ...snapshot,
    summary: {
      state,
      active: snapshot.active,
      lastMeaningfulLine,
      stale,
      staleForMs,
      staleFor: formatDuration(staleForMs),
      suggestedAction
    }
  };
}

function persistMonitorSnapshot(ctx, job, snapshot) {
  const summary = snapshot.summary || summarizeLiveStatus(snapshot).summary;
  const meaningfulOutput = String(snapshot.logs?.meaningfulOutput || "").trim();
  const patch = {
    lastMonitoredAt: snapshot.checkedAt,
    lastMonitorSnapshot: {
      checkedAt: snapshot.checkedAt,
      active: snapshot.active,
      available: snapshot.available,
      summary,
      logsAvailable: Boolean(snapshot.logs?.available),
      agentsAvailable: Boolean(snapshot.agents?.available)
    }
  };
  if (snapshot.completed) {
    patch.status = "completed";
  }
  if (meaningfulOutput) {
    patch.lastMeaningfulOutput = meaningfulOutput;
    patch.result = meaningfulOutput;
  }
  return completeJob(ctx, job, patch);
}

function renderMonitorSnapshot(snapshot) {
  const summary = snapshot.summary || summarizeLiveStatus(snapshot).summary;
  const lines = [
    `[${snapshot.checkedAt}] Claude ${snapshot.claudeSessionId || snapshot.job?.id || "job"} is ${summary.state}.`
  ];
  if (snapshot.error) {
    lines.push(snapshot.error);
  }
  if (summary.lastMeaningfulLine) {
    lines.push(`Last meaningful output: ${summary.lastMeaningfulLine}`);
  } else if (snapshot.logs?.output) {
    lines.push("Recent logs contained only Claude status output.");
  } else if (snapshot.agents?.output) {
    lines.push(snapshot.agents.output);
  }
  if (summary.stale) {
    lines.push(`No new meaningful output for ${summary.staleFor}.`);
  }
  lines.push(`Action: ${summary.suggestedAction}`);
  return `${lines.join("\n")}\n`;
}

function writeMonitorSnapshot(snapshot, asJson) {
  process.stdout.write(asJson ? `${JSON.stringify(snapshot)}\n` : renderMonitorSnapshot(snapshot));
}

function handleMonitor(argv) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  let job = findJob(ctx, positionals[0]);
  if (!job) {
    throw new Error("No Claude job found.");
  }
  const intervalMs = Number(options["interval-ms"] || DEFAULT_MONITOR_INTERVAL_MS);
  const maxChecks = options.forever ? Infinity : Number(options["max-checks"] || DEFAULT_MONITOR_CHECKS);
  const monitorState = {};
  for (let index = 0; index < maxChecks; index += 1) {
    const snapshot = summarizeLiveStatus(readLiveStatus(job, options), monitorState, options);
    job = persistMonitorSnapshot(ctx, job, snapshot);
    writeMonitorSnapshot(snapshot, options.json);
    if (!snapshot.active) {
      break;
    }
    if (index < maxChecks - 1) {
      sleep(intervalMs);
    }
  }
}

function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  const job = findJob(ctx, positionals[0]);
  if (options.watch || options.follow) {
    handleMonitor(argv);
    return;
  }
  if (!job) {
    output({ jobs: ctx.state.jobs }, options.json);
    return;
  }
  const live = job.claudeSessionId ? summarizeLiveStatus(readLiveStatus(job, options), {}, options) : null;
  const updated = live ? persistMonitorSnapshot(ctx, job, live) : job;
  output({ job: updated, live }, options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  const job = findJob(ctx, positionals[0]);
  if (!job) {
    throw new Error("No Claude job found.");
  }
  output({ job, result: job.result ?? job.stdout ?? "" }, options.json);
}

function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv);
  const ctx = currentContext(options);
  const job = findJob(ctx, positionals[0]);
  if (!job) {
    throw new Error("No Claude job found.");
  }
  let latest = job;
  if (job.claudeSessionId) {
    try {
      const live = summarizeLiveStatus(readLiveStatus(job, options), {}, options);
      latest = persistMonitorSnapshot(ctx, job, live);
    } catch {
      latest = job;
    }
    runClaude(["stop", job.claudeSessionId], { timeoutMs: Number(options["timeout-ms"] || 10000) });
  }
  const cancelled = completeJob(ctx, latest, { status: "cancelled" });
  output({ jobId: cancelled.id, status: "cancelled" }, options.json);
}

function handleResumeCandidate(argv) {
  const { options } = parseArgs(argv);
  const ctx = currentContext(options);
  let candidate = null;
  try {
    candidate = selectResumeCandidate(ctx.state.jobs, process.env, { resume: true, write: Boolean(options.write) });
  } catch (error) {
    output({ available: false, error: error.message, candidates: ctx.state.jobs }, options.json);
    return;
  }
  output({ available: Boolean(candidate), candidate, candidates: candidate ? [] : ctx.state.jobs }, options.json);
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  claude-companion setup [--json]",
      "  claude-companion advise [--background] [--write] [--model <model>] [--max-turns <n>] [--effort <level>] [--allow-mcp] [--allow-web] [--no-background-fallback] [prompt]",
      "  claude-companion do [--background] [--write] [--model <model>] [--max-turns <n>] [--effort <level>] [--allow-mcp] [--allow-web] [prompt]",
      "  claude-companion rescue [--background] [--write] [--resume] [--model <model>] [--max-turns <n>] [--effort <level>] [--allow-mcp] [--allow-web] [--no-background-fallback] [prompt]",
      "  claude-companion review [--base <ref>] [--model <model>] [--max-turns <n>] [--effort <level>] [--json]",
      "  claude-companion adversarial-review [--base <ref>] [--model <model>] [--max-turns <n>] [--effort <level>] [focus] [--json]",
      "  claude-companion monitor [job-id] [--interval-ms <ms>] [--max-checks <n>] [--stale-after-ms <ms>] [--json]",
      "  claude-companion status [job-id] [--watch] [--json]",
      "  claude-companion result [job-id] [--json]",
      "  claude-companion cancel [job-id] [--json]",
      "  claude-companion resume-candidate [--json]",
      "",
      "Models are passed through to Claude Code. Examples: fable, opus, sonnet, or a full model name."
    ].join("\n") + "\n"
  );
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }
  switch (command) {
    case "setup":
      handleSetup(argv);
      break;
    case "advise":
      handleAdvise(argv);
      break;
    case "rescue":
      handleRescue(argv);
      break;
    case "do":
      handleDo(argv);
      break;
    case "review":
      handleReview(argv, "review");
      break;
    case "adversarial-review":
      handleReview(argv, "adversarial-review");
      break;
    case "status":
      handleStatus(argv);
      break;
    case "monitor":
      handleMonitor(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    case "resume-candidate":
      handleResumeCandidate(argv);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
