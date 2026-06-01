"use strict";

const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sanitizeResultFolderComponent, resultOutputDir, unpackResultArchive, normalizeMacIdentity } = require("../src/output");
const { renderStatusLine } = require("../src/status");
const { taskLine } = require("../src/tasks");
const { parseSubmitResponse } = require("../src/api");
const { isTerminalSessionState } = require("../src/flow");
const { parseArgs } = require("../src/cli");

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

runTest("completed with warnings is terminal", () => {
  assert.equal(isTerminalSessionState("completed_with_warnings"), true);
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
