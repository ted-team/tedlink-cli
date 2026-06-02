"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { sanitizeResultFolderComponent, resultOutputDir, unpackResultArchive, normalizeMacIdentity } = require("../src/output");
const { renderStatusLine } = require("../src/status");
const { taskLine } = require("../src/tasks");
const { buildSubmitPayload, parseSubmitResponse, parseSseEvents, normalizeV3SubmitResponse } = require("../src/api");
const { authTokenFromEnv } = require("../src/http");
const { isTerminalSessionState, isPauseSessionState } = require("../src/flow");
const { parseArgs, resolveResumeSession } = require("../src/cli");
const { buildSessionRecord, latestSession, listSessions, promptSummary, upsertSession } = require("../src/session_store");

runTest("sanitizes result folder names", () => {
  assert.equal(sanitizeResultFolderComponent("五管OTA设计"), "五管ota设计");
  assert.equal(resultOutputDir("/tmp/workspace", "五管OTA设计", "session-full-prompt"), "/tmp/workspace/.tedlink/五管ota设计");
});

runTest("normalizes mac identity", () => {
  assert.equal(normalizeMacIdentity("aa:bb:cc:dd:ee:ff"), "aa_bb_cc_dd_ee_ff");
});

runTest("renders status line", () => {
  const status = {
    process: { summary: "", total: 2, completed: 1, failed: 0, subtask_total: 0, subtask_completed: 0 },
    todos: [{ subtasks: [] }, { subtasks: [] }],
  };
  assert.equal(renderStatusLine(status), "2 todo(s), 1 completed");
});

runTest("formats task line", () => {
  const line = taskLine({
    title: "交付结果文件",
    state: "syncing",
    stage: "syncing",
    owner_node: "tedagent-sess-1",
    artifacts: ["secret.json"],
    subtasks: [],
    detail: { requested_outputs: [] },
  });
  assert.equal(line, "[writing_files] 交付结果文件 owner=tedlink artifacts=json (1 file)");
});

runTest("parses legacy submit response", () => {
  const result = parseSubmitResponse(Buffer.from(JSON.stringify({
    sessionid: "s1",
    status: "pending",
  })), "prompt");
  assert.equal(result.session.session_id, "s1");
  assert.equal(result.session.prompt, "prompt");
  assert.equal(result.session.state, "pending");
});

runTest("unpacks tar archives safely", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tedlink-cli-"));
  const archive = testTarArchive([["artifacts/report.md", Buffer.from("ok")]]);
  const written = unpackResultArchive(root, archive);
  assert.deepEqual(written, ["artifacts/report.md"]);
  assert.equal(fs.readFileSync(path.join(root, "artifacts", "report.md"), "utf8"), "ok");
});

runTest("unpacks gzip tar archives from tedlink-server", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tedlink-cli-gz-"));
  const archive = zlib.gzipSync(testTarArchive([["output_plots/result.txt", Buffer.from("ok")]]));
  const written = unpackResultArchive(root, archive);
  assert.deepEqual(written, ["output_plots/result.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "output_plots", "result.txt"), "utf8"), "ok");
});

runTest("parses tedlink-server SSE data events", () => {
  const events = parseSseEvents(Buffer.from([
    'data: {"event":"plan","content":"step"}',
    "",
    'data: {"event":"status_update","status":"WAITING_EXECUTOR","progress":30}',
    "",
  ].join("\n")));
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "plan");
  assert.equal(events[1].progress, 30);
});

runTest("raises tedlink-server SSE error events", () => {
  assert.throws(() => normalizeV3SubmitResponse(
    { session_id: "s1", prompt: "prompt" },
    [{ event: "error", content: "Claude API request failed" }],
  ), /Claude API request failed/);
});

runTest("normalizes staged executor history into activity", () => {
  const { parseSessionStatusResponse } = require("../src/api");
  const status = parseSessionStatusResponse(Buffer.from(JSON.stringify({
    session_id: "s1",
    status: "EXECUTING",
    progress: 20,
    workspace_path: "/tmp/work",
    artifact_dir: "artifacts",
    initial_prompt: "按照计算参考文档执行参数计算",
    history_summary: [
      {
        role: "executor",
        created_at: "2026-06-02T00:00:00Z",
        content: [
          "[PLAN]",
          "1. 创建 calculation_record.md",
          "[TASK]",
          "运行第一轮仿真",
          "[TOOLS]",
          "第一轮参数 gm/id=12，增益不足，下一轮增大尾电流。",
          "[SUBTASK]",
          "更新 DESIGN_MAP 参数",
          "[COMPLETED]",
          "完成第一轮记录。",
        ].join("\n"),
      },
    ],
  })));
  assert.deepEqual(status.activity.map((item) => item.action), ["plan", "task", "tool", "subtask", "completed"]);
  assert.match(status.activity[2].message, /下一轮增大尾电流/);
});

runTest("normalizes markdown staged executor history into activity", () => {
  const { parseSessionStatusResponse } = require("../src/api");
  const status = parseSessionStatusResponse(Buffer.from(JSON.stringify({
    session_id: "s1",
    status: "EXECUTING",
    workspace_path: "/tmp/work",
    history_summary: [
      {
        role: "executor",
        content: [
          "## Plan",
          "- Goal: 执行参数计算",
          "## Task",
          "- Current task: 第一轮仿真",
          "## Progress",
          "- Key result: 增益不足",
          "- Next direction: 增大尾电流",
          "## Completed",
          "- Result: 已记录 calculation_record.md",
        ].join("\n"),
      },
    ],
  })));
  assert.deepEqual(status.activity.map((item) => item.action), ["plan", "task", "tool", "completed"]);
  assert.match(status.activity[2].message, /Next direction/);
});

runTest("defaults Claude model to claude-sonnet-4-6", () => {
  const previous = process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_MODEL;
  try {
    const payload = buildSubmitPayload("prompt", null, "user", "mac", true, true, true, [], [], ".", false);
    assert.equal(payload.model, "claude-sonnet-4-6");
  } finally {
    restoreEnv("ANTHROPIC_MODEL", previous);
  }
});

runTest("reads decision url from environment only", () => {
  const previous = process.env.TEDLINK_BASE_URL;
  process.env.TEDLINK_BASE_URL = "http://127.0.0.1:9543";
  try {
    const args = parseArgs(["--prompt", "hello"]);
    assert.equal(args.decision_url, "http://127.0.0.1:9543");
    assert.throws(() => parseArgs(["--decision-url", "http://x", "--prompt", "hello"]), /unrecognized option/);
  } finally {
    if (previous === undefined) {
      delete process.env.TEDLINK_BASE_URL;
    } else {
      process.env.TEDLINK_BASE_URL = previous;
    }
  }
});

runTest("parses session list command", () => {
  const args = parseArgs(["session", "list", "--output", "json"]);
  assert.equal(args.command, "session-list");
  assert.equal(args.output, "json");
});

runTest("parses resume flag with optional session id", () => {
  let args = parseArgs(["--resume", "--prompt", "继续优化"]);
  assert.equal(args.resume, true);
  assert.equal(args.resume_session_id, null);
  args = parseArgs(["--resume", "s1", "--prompt", "继续优化"]);
  assert.equal(args.resume, true);
  assert.equal(args.resume_session_id, "s1");
  args = parseArgs(["--resume=s2", "--prompt", "继续优化"]);
  assert.equal(args.resume, true);
  assert.equal(args.resume_session_id, "s2");
});

runTest("persists session list records with prompt summaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tedlink-store-"));
  const storePath = path.join(root, "sessions.json");
  const record = buildSessionRecord({
    sessionId: "s1",
    prompt: "帮我设计一个五管运算放大器，要求有网表和仿真波形和报告",
    decisionUrl: "http://127.0.0.1:9543",
    workspaceDir: "/tmp/work",
    state: "executing",
  });
  upsertSession(record, storePath);
  const sessions = listSessions(storePath);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_id, "s1");
  assert.equal(sessions[0].prompt_summary, promptSummary(record.prompt));
});

runTest("resolves latest resume session from TEDLINK_HOME", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tedlink-home-"));
  const previousHome = process.env.TEDLINK_HOME;
  process.env.TEDLINK_HOME = root;
  try {
    upsertSession(buildSessionRecord({
      sessionId: "old",
      prompt: "old prompt",
      decisionUrl: "http://old",
      workspaceDir: "/tmp/old",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }));
    upsertSession(buildSessionRecord({
      sessionId: "new",
      prompt: "new prompt",
      decisionUrl: "http://new",
      workspaceDir: "/tmp/new",
      updatedAt: "2026-01-02T00:00:00.000Z",
    }));
    assert.equal(latestSession().session_id, "new");
    assert.equal(resolveResumeSession({ resume_session_id: null }).session_id, "new");
    assert.equal(resolveResumeSession({ resume_session_id: "old" }).session_id, "old");
  } finally {
    restoreEnv("TEDLINK_HOME", previousHome);
  }
});

runTest("completed with warnings is terminal", () => {
  assert.equal(isTerminalSessionState("completed_with_warnings"), true);
});

runTest("waiting executor and waiting input are pause states", () => {
  assert.equal(isPauseSessionState("WAITING_EXECUTOR"), true);
  assert.equal(isPauseSessionState("waiting_input"), true);
  assert.equal(isPauseSessionState("running"), false);
});

runTest("uses TEDLINK_AUTH_TOKEN for HTTP auth", () => {
  const previousAuth = process.env.TEDLINK_AUTH_TOKEN;
  const previousLegacy = process.env.TEDLINK_TOKEN;
  process.env.TEDLINK_AUTH_TOKEN = "auth-token";
  process.env.TEDLINK_TOKEN = "legacy-token";
  try {
    assert.deepEqual(authTokenFromEnv(), { name: "TEDLINK_AUTH_TOKEN", value: "auth-token" });
  } finally {
    restoreEnv("TEDLINK_AUTH_TOKEN", previousAuth);
    restoreEnv("TEDLINK_TOKEN", previousLegacy);
  }
});

function runTest(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  }
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function testTarArchive(entries) {
  const parts = [];
  for (const [entryPath, content] of entries) {
    const header = Buffer.alloc(512);
    Buffer.from(entryPath).copy(header, 0, 0, Math.min(Buffer.byteLength(entryPath), 100));
    const size = Buffer.from(`${content.length.toString(8).padStart(11, "0")}\0`);
    size.copy(header, 124);
    header[156] = "0".charCodeAt(0);
    parts.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) {
      parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
