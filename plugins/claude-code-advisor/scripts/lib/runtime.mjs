import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_VERSION = 1;
export const REVIEW_SEVERITIES = new Set(["BLOCKER", "MAJOR", "MINOR"]);
export const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
export const LOCAL_READ_TOOLS = "Read,Glob,Grep";
export const WEB_READ_TOOLS = `${LOCAL_READ_TOOLS},WebFetch,WebSearch`;

function readToolsForMode(mode, allowWeb = false) {
  if (allowWeb || mode === "advise") {
    return WEB_READ_TOOLS;
  }
  return LOCAL_READ_TOOLS;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sanitizeSegment(value) {
  return String(value || "none")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "none";
}

export function resolveStateRoot(env = process.env) {
  return env.CLAUDE_COMPANION_STATE_ROOT || path.join(os.homedir(), ".codex", "claude-plugin-codex");
}

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
}

export function resolveStateDir(workspaceRoot, env = process.env, stateRoot = resolveStateRoot(env)) {
  const canonical = path.resolve(workspaceRoot);
  const base = sanitizeSegment(path.basename(canonical) || "workspace");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const thread = env.CODEX_THREAD_ID ? `thread-${sanitizeSegment(env.CODEX_THREAD_ID)}` : "workspace";
  return path.join(stateRoot, `${base}-${hash}`, thread);
}

export function resolveWorkspaceIndexDir(workspaceRoot, env = process.env, stateRoot = resolveStateRoot(env)) {
  const canonical = path.resolve(workspaceRoot);
  const base = sanitizeSegment(path.basename(canonical) || "workspace");
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return path.join(stateRoot, `${base}-${hash}`);
}

export function emptyState() {
  return { version: STATE_VERSION, jobs: [], capabilities: null };
}

export function loadState(stateDir) {
  const stateFile = path.join(stateDir, "state.json");
  if (!fs.existsSync(stateFile)) {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...emptyState(),
      ...parsed,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      capabilities: parsed.capabilities ?? null
    };
  } catch {
    return emptyState();
  }
}

export function saveState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);
  const next = {
    ...emptyState(),
    ...state,
    jobs: [...(state.jobs || [])].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
  };
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(stateFile, 0o600);
  return next;
}

export function generateJobId(prefix = "claude") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function upsertJob(state, patch) {
  const timestamp = nowIso();
  const jobs = [...(state.jobs || [])];
  const index = jobs.findIndex((job) => job.id === patch.id);
  if (index === -1) {
    jobs.unshift({ createdAt: timestamp, updatedAt: timestamp, ...patch });
  } else {
    jobs[index] = { ...jobs[index], ...patch, updatedAt: timestamp };
  }
  return { ...state, jobs };
}

export function selectResumeCandidate(jobs, env = process.env, options = {}) {
  const explicitJobId = options.explicitJobId || options.jobId || null;
  const codexThreadId = env.CODEX_THREAD_ID || null;
  let candidate = null;

  if (explicitJobId) {
    candidate = jobs.find((job) => job.id === explicitJobId) || null;
  } else if (codexThreadId) {
    candidate =
      jobs.find(
        (job) =>
          job.codexThreadId === codexThreadId &&
          job.claudeSessionId &&
          !["running", "queued"].includes(job.status)
      ) || null;
  }

  if (!candidate) {
    return null;
  }

  if (candidate.write && !options.write) {
    throw new Error("Refusing to resume a write-capable Claude session from a read-only command. Pass --write --resume.");
  }

  return candidate;
}

export function buildClaudeArgs(options) {
  const {
    mode,
    prompt,
    outputFormat = "text",
    maxTurns = 3,
    write = false,
    resumeSessionId = null,
    model = null,
    effort = null,
    allowMcp = false,
    allowWeb = false
  } = options;

  if (write === "implicit") {
    throw new Error("Write-capable Claude work requires explicit --write.");
  }
  if (!prompt || !String(prompt).trim()) {
    throw new Error("A prompt is required.");
  }

  const args = [];
  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }
  args.push("-p", prompt);
  args.push("--output-format", outputFormat);
  args.push("--max-turns", String(maxTurns));
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (!allowMcp) {
    args.push("--mcp-config", EMPTY_MCP_CONFIG, "--strict-mcp-config");
  }
  args.push("--no-chrome");

  if (write) {
    args.push("--permission-mode", "default");
  } else if (mode === "review" || mode === "adversarial-review") {
    args.push("--tools", "", "--permission-mode", "plan");
  } else {
    args.push("--tools", readToolsForMode(mode, allowWeb), "--permission-mode", "plan");
  }

  return args;
}

export function buildBackgroundArgs({
  prompt,
  name,
  mode = "advise",
  write = false,
  model = null,
  effort = null,
  allowMcp = false,
  allowWeb = false
}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("A prompt is required.");
  }
  const args = ["--bg"];
  if (name) {
    args.push("--name", name);
  }
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (!allowMcp) {
    args.push("--mcp-config", EMPTY_MCP_CONFIG, "--strict-mcp-config");
  }
  args.push("--no-chrome");
  if (!write) {
    args.push("--tools", readToolsForMode(mode, allowWeb), "--permission-mode", "plan");
  }
  args.push(prompt);
  return args;
}

export function parseBackgroundLaunch(stdout) {
  const text = String(stdout || "");
  return text.match(/backgrounded\s+.\s+([a-zA-Z0-9_-]+)/)?.[1] ?? null;
}

function assertString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Review finding is missing ${field}.`);
  }
}

export function validateReviewPayload(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed.startsWith("{")) {
    throw new Error("Invalid JSON review output.");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid JSON review output: ${error.message}`);
  }

  if (!Array.isArray(parsed.findings)) {
    throw new Error("Review output must include a findings array.");
  }

  for (const finding of parsed.findings) {
    if (!REVIEW_SEVERITIES.has(finding?.severity)) {
      throw new Error("Review finding has unsupported severity.");
    }
    assertString(finding.title, "title");
    assertString(finding.fact, "fact");
    assertString(finding.recommendation, "recommendation");
  }

  return parsed;
}

export function parseClaudeJsonResult(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith("{")) {
    throw new Error("Invalid JSON Claude output.");
  }
  const envelope = JSON.parse(text);
  const sessionId = envelope.session_id || envelope.sessionId || null;
  const contentRaw = typeof envelope.result === "string" ? normalizeClaudeResult(envelope.result) : text;
  const content = typeof envelope.result === "string" ? JSON.parse(contentRaw) : envelope;
  return {
    envelope,
    content,
    contentRaw,
    sessionId
  };
}

function normalizeClaudeResult(raw) {
  const trimmed = String(raw || "").trim();
  const toolCalls = trimmed.match(/^<function_calls>[\s\S]*?<\/function_calls>\s*/);
  const withoutToolCalls = toolCalls ? trimmed.slice(toolCalls[0].length).trim() : trimmed;
  try {
    JSON.parse(withoutToolCalls);
    return withoutToolCalls;
  } catch {
    const candidates = extractJsonObjects(withoutToolCalls);
    if (candidates.length > 1) {
      throw new Error("Ambiguous JSON Claude result: multiple complete objects were returned.");
    }
    return candidates[0] || withoutToolCalls;
  }
}

function extractJsonObjects(value) {
  const text = String(value || "");
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1).trim());
        start = -1;
      }
    }
  }
  return objects;
}

export function buildReviewPrompt({ kind, targetLabel, gitContext, focus = "" }) {
  const reviewKind = kind === "adversarial-review" ? "adversarial reviewer" : "code reviewer";
  const focusLine = focus ? `Focus: ${focus}\n` : "";
  return [
    `You are a skeptical ${reviewKind}.`,
    "This is a read-only review. Do not edit files, run commands, or suggest you are about to make changes.",
    "Return JSON only with this exact shape:",
    '{"findings":[{"severity":"BLOCKER|MAJOR|MINOR","title":"...","fact":"...","recommendation":"..."}]}',
    "Use BLOCKER only for issues that must be resolved or explicitly waived before proceeding.",
    focusLine,
    `Target: ${targetLabel}`,
    "Git context:",
    gitContext || "No git context was available."
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderHuman(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "jobId" in value && "status" in value && "output" in value) {
    const output = String(value.output || "").trim();
    if (value.status === "completed") {
      return output ? `${output}\n` : `Claude job ${value.jobId} completed.\n`;
    }
    if (value.status === "running") {
      return `Claude job ${value.jobId} is running${value.claudeSessionId ? ` as ${value.claudeSessionId}` : ""}.\n`;
    }
    return [`Claude job ${value.jobId} ${value.status}.`, output].filter(Boolean).join("\n") + "\n";
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}
