"use strict";

function defaultWorkspaceInfo() {
  return {
    session_dir: "",
    workspace_dir: "",
  };
}

function defaultSessionInfo() {
  return {
    session_id: "",
    prompt: "",
    state: "",
    workspace: defaultWorkspaceInfo(),
    metadata: {},
  };
}

function defaultTaskDetail() {
  return {
    requested_outputs: [],
    observed_outputs: [],
    decision_sync: {},
    client_delivery: {},
    server_delivery: {},
  };
}

function normalizeSubtaskSnapshot(value = {}) {
  return {
    subtask_id: String(value.subtask_id || ""),
    title: String(value.title || ""),
    status: String(value.status || ""),
    active_form: String(value.active_form || ""),
    updated_at: String(value.updated_at || ""),
  };
}

function normalizeTaskSnapshot(value = {}) {
  return {
    title: String(value.title || ""),
    state: String(value.state || ""),
    stage: String(value.stage || ""),
    owner_node: String(value.owner_node || ""),
    message: String(value.message || ""),
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.map((item) => String(item)) : [],
    subtasks: Array.isArray(value.subtasks) ? value.subtasks.map(normalizeSubtaskSnapshot) : [],
    detail: normalizeTaskDetail(value.detail || {}),
  };
}

function normalizeTaskDetail(value = {}) {
  return {
    requested_outputs: Array.isArray(value.requested_outputs)
      ? value.requested_outputs.map((item) => String(item))
      : [],
    observed_outputs: Array.isArray(value.observed_outputs)
      ? value.observed_outputs.map(normalizeObservedOutput)
      : [],
    decision_sync: value.decision_sync || {},
    client_delivery: value.client_delivery || {},
    server_delivery: value.server_delivery || {},
  };
}

function normalizeObservedOutput(value = {}) {
  return {
    kind: String(value.kind || ""),
    paths: Array.isArray(value.paths) ? value.paths.map((item) => String(item)) : [],
    evidence: Array.isArray(value.evidence) ? value.evidence.map((item) => String(item)) : [],
  };
}

function normalizeProcessSnapshot(value = {}) {
  return {
    state: String(value.state || ""),
    summary: String(value.summary || ""),
    total: toSize(value.total),
    completed: toSize(value.completed),
    failed: toSize(value.failed),
    subtask_total: toSize(value.subtask_total),
    subtask_completed: toSize(value.subtask_completed),
    subtask_failed: toSize(value.subtask_failed),
    current_task: value.current_task ? normalizeTaskSnapshot(value.current_task) : null,
  };
}

function normalizeResultFile(value = {}) {
  return {
    path: String(value.path || ""),
    md5: String(value.md5 || ""),
    size: toSize(value.size),
  };
}

function normalizeResultArchive(value = {}) {
  return {
    format: String(value.format || ""),
    content_type: String(value.content_type || ""),
    download_path: String(value.download_path || ""),
    download_token: String(value.download_token || ""),
    file_count: toSize(value.file_count),
  };
}

function normalizeActivityEvent(value = {}) {
  return {
    time: String(value.time || ""),
    actor: String(value.actor || ""),
    level: String(value.level || ""),
    action: String(value.action || ""),
    message: String(value.message || ""),
  };
}

function normalizeSessionInfo(value = {}) {
  return {
    session_id: String(value.session_id || ""),
    prompt: String(value.prompt || ""),
    state: String(value.state || ""),
    workspace: value.workspace ? normalizeWorkspaceInfo(value.workspace) : defaultWorkspaceInfo(),
    metadata: value.metadata || {},
  };
}

function normalizeWorkspaceInfo(value = {}) {
  return {
    session_dir: String(value.session_dir || ""),
    workspace_dir: String(value.workspace_dir || ""),
  };
}

function normalizeSessionStatus(value = {}) {
  return {
    session: normalizeSessionInfo(value.session || {}),
    todos: Array.isArray(value.todos) ? value.todos.map(normalizeTaskSnapshot) : [],
    process: normalizeProcessSnapshot(value.process || {}),
    activity: Array.isArray(value.activity) ? value.activity.map(normalizeActivityEvent) : [],
    result_files: Array.isArray(value.result_files) ? value.result_files.map(normalizeResultFile) : [],
    result_archive: value.result_archive ? normalizeResultArchive(value.result_archive) : null,
    error: String(value.error || ""),
  };
}

function normalizeRequestResponse(value = {}) {
  return {
    session: normalizeSessionInfo(value.session || {}),
    written_client_files: Array.isArray(value.written_client_files)
      ? value.written_client_files.map((item) => String(item))
      : [],
    written_shared_files: Array.isArray(value.written_shared_files)
      ? value.written_shared_files.map((item) => String(item))
      : [],
    client_node: value.client_node ?? null,
    auto_plan: value.auto_plan ?? null,
  };
}

function defaultSkillRunResult() {
  return {
    session_id: "",
    state: "",
    phase: "",
    progress: "",
    prompt: "",
    workspace_dir: "",
    result_output_dir: "",
    result_files_written: [],
    result_files: [],
    artifacts: [],
    activity: [],
    status: normalizeSessionStatus(),
  };
}

function toSize(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : 0;
}

module.exports = {
  defaultWorkspaceInfo,
  defaultSessionInfo,
  defaultTaskDetail,
  normalizeSubtaskSnapshot,
  normalizeTaskSnapshot,
  normalizeTaskDetail,
  normalizeObservedOutput,
  normalizeProcessSnapshot,
  normalizeResultFile,
  normalizeResultArchive,
  normalizeActivityEvent,
  normalizeSessionInfo,
  normalizeWorkspaceInfo,
  normalizeSessionStatus,
  normalizeRequestResponse,
  defaultSkillRunResult,
};
