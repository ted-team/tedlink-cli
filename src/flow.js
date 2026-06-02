"use strict";

const { renderStatusLine } = require("./status");
const { progressLabel, taskLines } = require("./tasks");
const { formatElapsed } = require("./output");
const { normalizeSessionStatus } = require("./models");

function isTerminalSessionState(value) {
  return ["completed", "completed_with_warnings", "failed", "cancelled"].includes(String(value || "").trim().toLowerCase());
}

function isPauseSessionState(value) {
  return ["waiting_input", "waiting_executor"].includes(String(value || "").trim().toLowerCase());
}

function annotateResultDelivery(status, written) {
  if (!written || written.length === 0) {
    return;
  }
  const count = written.length;
  const message = `result files generated in workspace: ${count} ${count === 1 ? "file" : "files"}`;
  status.process.summary = appendProgressNote(status.process.summary || "", message);
  for (const task of status.todos) {
    if (task.state !== "completed") {
      continue;
    }
    task.stage = "delivered";
    task.message = message;
  }
  status.activity.push({
    time: "",
    actor: "client",
    level: "info",
    action: "result_files_written",
    message,
  });
}

function appendProgressNote(current, note) {
  const trimmed = String(current || "").trim();
  if (!trimmed) {
    return note;
  }
  if (trimmed.includes(note)) {
    return trimmed;
  }
  return `${trimmed}; ${note}`;
}

function heartbeatPhase(status) {
  const error = String(status.error || "").trim();
  if (error) {
    return shellSafeToken(error);
  }
  const processState = String(status.process.state || "").trim();
  if (processState) {
    return shellSafeToken(progressLabel(processState));
  }
  const runningTask = (status.todos || []).find((task) =>
    ["running", "waiting_input", "syncing"].includes(String(task.state || "")),
  );
  if (runningTask) {
    const stage = String(runningTask.stage || "").trim();
    if (stage) {
      return shellSafeToken(progressLabel(stage));
    }
    const state = String(runningTask.state || "").trim();
    if (state) {
      return shellSafeToken(progressLabel(state));
    }
  }
  if ((status.todos || []).some((task) => task.state === "queued")) {
    return "queued";
  }
  if ((status.todos || []).some((task) => task.state === "planned")) {
    return "planned";
  }
  return shellSafeToken(status.session.state || "");
}

function shellSafeToken(value) {
  let out = "";
  for (const ch of String(value || "").trim()) {
    if (/[A-Za-z0-9_.-]/.test(ch)) {
      out += ch;
    } else if (!out.endsWith("_")) {
      out += "_";
    }
  }
  const trimmed = out.replace(/^_+|_+$/g, "");
  return trimmed || "unknown";
}

function printStatusPhase(status) {
  console.log(`Phase: ${heartbeatPhase(status)}`);
  console.log(`Progress: ${renderStatusLine(status)}`);
}

function printResultDelivery(status, written, outputDir) {
  console.log();
  console.log("Results");
  console.log(`  - result folder: ${outputDir}`);
  if (written.length > 0) {
    for (const file of written) {
      console.log(`  - wrote ${file}`);
    }
    return;
  }
  const artifacts = status.todos.flatMap((task) => (task.artifacts || []).map(String));
  if (artifacts.length === 0) {
    console.log("  - no result files delivered");
    return;
  }
  const workspace = String(status.session.workspace.workspace_dir || "").trim();
  if (!workspace) {
    console.log("  - artifacts completed but no result files were delivered");
  } else {
    console.log(`  - artifacts are in task workspace: ${workspace}`);
  }
  for (const artifact of artifacts) {
    console.log(`    - ${artifact}`);
  }
}

function printStatusSummary(prompt, status) {
  console.log("TedLink Rust Client");
  console.log(`  session: ${status.session.session_id}`);
  console.log(`  state: ${status.session.state}`);
  const error = String(status.error || "").trim();
  if (error) {
    console.log(`  error: ${error}`);
  }
  console.log(`  prompt: ${String(prompt || "").trim()}`);
  console.log();
  console.log("Todos");
  if (!status.todos || status.todos.length === 0) {
    console.log("  - none");
  } else {
    for (const task of status.todos) {
      const lines = taskLines(task);
      lines.forEach((line, index) => {
        if (index === 0) {
          console.log(`  - ${line}`);
        } else {
          console.log(`    ${line}`);
        }
      });
    }
  }
  console.log();
}

function printLocalSummary(prompt, status, submittedAt) {
  console.log("TedLink Local Task");
  console.log(`  task: ${status.session.session_id}`);
  console.log(`  state: ${status.session.state}`);
  const error = String(status.error || "").trim();
  if (error) {
    console.log(`  error: ${error}`);
  }
  console.log(`  running: ${formatElapsed(Date.now() - submittedAt)}`);
  console.log(`  prompt: ${String(prompt || "").trim()}`);
  console.log();
  console.log("Todos");
  if (!status.todos || status.todos.length === 0) {
    console.log("  - none");
  } else {
    for (const task of status.todos) {
      const lines = taskLines(task);
      lines.forEach((line, index) => {
        if (index === 0) {
          console.log(`  - ${line}`);
        } else {
          console.log(`    ${line}`);
        }
      });
    }
  }
  console.log();
  console.log(`Progress: ${renderStatusLine(status)}`);
  if (status.activity && status.activity.length > 0) {
    console.log();
    console.log("Activity");
    for (const event of status.activity) {
      const message = String(event.message || "").trim();
      if (!message) {
        continue;
      }
      const actor = String(event.actor || "").trim() || "agent";
      const action = activityActionLabel(event.action);
      console.log(`  - ${actor} ${action} ${message}`);
    }
  }
}

function activityActionLabel(action) {
  switch (String(action || "").trim()) {
    case "claude_output":
    case "claude_message":
      return "output:";
    case "claude_tool_use":
    case "claude_tool_result":
    case "tool":
    case "tools":
      return "tool:";
    case "plan":
      return "plan:";
    case "task":
      return "task:";
    case "subtask":
      return "subtask:";
    case "progress":
      return "progress:";
    case "completed":
      return "completed:";
    case "failed":
      return "failed:";
    case "task_running":
      return "running:";
    case "task_completed":
      return "done:";
    case "task_failed":
      return "failed:";
    case "task_cancelled":
      return "cancelled:";
    case "sync_task_artifacts":
      return "artifacts:";
    case "result_files_written":
      return "files:";
    default:
      return "status:";
  }
}

function buildSkillResult(status, written, outputDir) {
  const artifacts = status.todos.flatMap((task) => (task.artifacts || []).map(String));
  return {
    session_id: status.session.session_id,
    state: status.session.state,
    phase: heartbeatPhase(status),
    progress: renderStatusLine(status),
    prompt: status.session.prompt,
    workspace_dir: status.session.workspace.workspace_dir || "",
    result_output_dir: String(outputDir),
    result_files_written: written,
    result_files: status.result_files || [],
    artifacts,
    activity: status.activity || [],
    status: normalizeSessionStatus(status),
  };
}

function resultArchiveToWritten(status, written) {
  return { status, written };
}

module.exports = {
  isTerminalSessionState,
  isPauseSessionState,
  annotateResultDelivery,
  appendProgressNote,
  heartbeatPhase,
  shellSafeToken,
  printStatusPhase,
  printResultDelivery,
  printStatusSummary,
  printLocalSummary,
  activityActionLabel,
  buildSkillResult,
  resultArchiveToWritten,
};
