"use strict";

const ARTIFACT_MAX_SUMMARY_ITEMS = 8;

function taskLines(task) {
  const lines = [taskLine(task)];
  for (const subtask of task.subtasks || []) {
    const title = subtaskTitle(subtask);
    if (!title) {
      continue;
    }
    const status = String(subtask.status || "").trim() || "pending";
    lines.push(`  - [${status}] ${title}`);
  }
  return lines;
}

function taskLine(task) {
  const title = String(task.title || "").trim() || "-";
  const state = String(task.state || "").trim();
  const stage = String(task.stage || "").trim();
  const stateLabel = progressLabel(state);
  const stageLabel = progressLabel(stage);
  const owner = ownerLabel(task.owner_node || "");
  const parts = [];
  if (!state && !stage) {
    parts.push("[unknown]");
  } else if (!stage || stage === state) {
    parts.push(`[${state ? stateLabel : "unknown"}]`);
  } else {
    parts.push(`[${state ? stateLabel : "unknown"}/${stageLabel}]`);
  }
  parts.push(title);
  if (owner !== "-") {
    parts.push(`owner=${owner}`);
  }
  if ((task.artifacts || []).length > 0) {
    parts.push(`artifacts=${artifactSummary(task.artifacts)}`);
  }
  const subtaskSummary = subtaskSummaryText(task.subtasks || []);
  if (subtaskSummary) {
    parts.push(`subtasks=${subtaskSummary}`);
  }
  const requested = requestedOutputsLabel(task);
  if (requested) {
    parts.push(`outputs=${requested}`);
  }
  return parts.join(" ");
}

function artifactSummary(artifacts) {
  const seen = new Set();
  const counts = new Map();
  for (const artifact of artifacts) {
    const value = String(artifact || "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const group = artifactGroup(value);
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  let parts = Array.from(counts.entries()).map(([group, count]) => {
    return `${group} (${count} ${count === 1 ? "file" : "files"})`;
  });
  if (parts.length > ARTIFACT_MAX_SUMMARY_ITEMS) {
    const omitted = parts.length - ARTIFACT_MAX_SUMMARY_ITEMS;
    parts = parts.slice(0, ARTIFACT_MAX_SUMMARY_ITEMS);
    parts.push(`... (${omitted} more groups)`);
  }
  return parts.join(",");
}

function artifactGroup(input) {
  const normalized = String(input || "").trim().replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
  if (!normalized) {
    return "artifact";
  }
  if (normalized.startsWith("layout/") || normalized.includes("/layout/")) {
    return "layout";
  }
  if (normalized.startsWith("waveform/") || normalized.includes("/waveform/")) {
    return "waveform";
  }
  if (normalized.startsWith("netlist/testbench_scs/") || normalized.includes("/netlist/testbench_scs/")) {
    return "netlist/testbench_scs";
  }
  if (normalized.startsWith("netlist/spectre/") || normalized.includes("/netlist/spectre/")) {
    return "netlist/spectre";
  }
  if (normalized.startsWith("netlist/") || normalized.includes("/netlist/")) {
    return "netlist";
  }
  if (normalized.startsWith("raw/") || normalized.includes("/raw/")) {
    return "raw";
  }
  const ext = normalized.split(".").pop();
  if (ext === "md") {
    return "report";
  }
  if (ext === "json") {
    return "json";
  }
  return "artifact";
}

function ownerLabel(value) {
  const text = String(value || "");
  if (text.startsWith("client-")) {
    return "local";
  }
  if (text.startsWith("server-") || text.startsWith("tedagent-")) {
    return "tedlink";
  }
  return "-";
}

function progressLabel(value) {
  return String(value || "").trim() === "syncing" ? "writing_files" : String(value || "").trim();
}

function requestedOutputsLabel(task) {
  if (!task.detail || !Array.isArray(task.detail.requested_outputs) || task.detail.requested_outputs.length === 0) {
    return "";
  }
  const labels = [];
  for (const item of task.detail.requested_outputs) {
    const label =
      item === "netlist"
        ? "netlist"
        : item === "simulation_waveform"
          ? "waveform"
          : item === "report"
            ? "report"
            : String(item);
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels.join(",");
}

function subtaskSummaryText(subtasks) {
  if (!subtasks || subtasks.length === 0) {
    return "";
  }
  const total = subtasks.length;
  const completed = subtasks.filter((subtask) => String(subtask.status || "").trim() === "completed").length;
  const failed = subtasks.filter((subtask) => String(subtask.status || "").trim() === "failed").length;
  const active = subtasks.find((subtask) => String(subtask.status || "").trim() === "in_progress");
  const parts = [`${completed}/${total}`];
  if (failed > 0) {
    parts.push(`${failed} failed`);
  }
  if (active) {
    const title = subtaskTitle(active);
    if (title) {
      parts.push(`active=${shorten(title, 80)}`);
    }
  }
  return parts.join(",");
}

function subtaskTitle(subtask) {
  const activeForm = String(subtask.active_form || "").trim();
  if (activeForm && String(subtask.status || "").trim() === "in_progress") {
    return activeForm;
  }
  return String(subtask.title || "").trim();
}

function shorten(value, limit) {
  const chars = Array.from(String(value || ""));
  if (chars.length <= limit) {
    return String(value || "");
  }
  return chars.slice(0, Math.max(0, limit - 3)).join("") + "...";
}

module.exports = {
  taskLines,
  taskLine,
  artifactSummary,
  artifactGroup,
  ownerLabel,
  progressLabel,
  requestedOutputsLabel,
  subtaskSummaryText,
  subtaskTitle,
  shorten,
};
