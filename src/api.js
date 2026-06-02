"use strict";

const { httpRequest, httpStreamSseEvents } = require("./http");
const {
  normalizeRequestResponse,
  normalizeSessionStatus,
  normalizeSessionInfo,
  normalizeWorkspaceInfo,
} = require("./models");

function submitRequest(
  decisionUrl,
  prompt,
  sessionId,
  user,
  mac,
  autoPlan,
  autoDispatch,
  deliverResultFiles,
  files,
  sharedFiles,
  localWorkspaceDir,
  clientHeartbeatRequired,
  onEvent = null,
) {
  const payload = buildSubmitPayload(
    prompt,
    sessionId,
    user,
    mac,
    autoPlan,
    autoDispatch,
    deliverResultFiles,
    files,
    sharedFiles,
    localWorkspaceDir,
    clientHeartbeatRequired,
  );
  const sessionPromise = sessionId
    ? recoverSession(decisionUrl, sessionId, mac)
    : createSession(decisionUrl, user, mac, prompt);
  return sessionPromise
    .then((session) => executeChat(
      decisionUrl,
      session.session_id,
      prompt,
      payload.api_key,
      payload.base_url,
      payload.model,
      null,
      onEvent,
    )
      .then((streamEvents) => normalizeV3SubmitResponse({
        ...payload,
        session_id: session.session_id,
        server_workspace_path: session.workspace_path || "",
      }, streamEvents)));
}

function buildSubmitPayload(
  prompt,
  sessionId,
  user,
  mac,
  autoPlan,
  autoDispatch,
  deliverResultFiles,
  files,
  sharedFiles,
  localWorkspaceDir,
  clientHeartbeatRequired,
) {
  return {
    prompt,
    session_id: sessionId ?? null,
    user,
    mac,
    base_url: envValue("ANTHROPIC_BASE_URL") || undefined,
    api_key: envValue("ANTHROPIC_AUTH_TOKEN") || envValue("ANTHROPIC_API_KEY") || undefined,
    model: envValue("ANTHROPIC_MODEL") || "claude-sonnet-4-6",
    auto_plan: autoPlan,
    auto_dispatch: autoDispatch,
    deliver_result_files: deliverResultFiles,
    files,
    shared_files: sharedFiles,
    local_workspace_dir: localWorkspaceDir,
    client_heartbeat_required: clientHeartbeatRequired,
    goal: prompt,
  };
}

async function pollSession(decisionUrl, sessionId, timeoutMs, pollIntervalMs, onEvent) {
  let lastActivity = Date.now();
  while (true) {
    const status = await sessionStatus(decisionUrl, sessionId, false, true);
    onEvent({ type: "Status", status });
    if (isTerminalState(status.session.state)) {
      onEvent({ type: "Done", status });
      return status;
    }
    if (Date.now() - lastActivity > timeoutMs) {
      break;
    }
    lastActivity = Date.now();
    await sleep(pollIntervalMs);
  }
  throw new Error("session stream ended before terminal status");
}

function createSession(decisionUrl, user, mac, initialPrompt = "") {
  return httpRequest(
    decisionUrl,
    "POST",
    "/api/v3/session/create",
    "application/json",
    Buffer.from(JSON.stringify({
      username: user,
      mac_address: mac,
      initial_prompt: initialPrompt,
    })),
  ).then(parseJsonResponse("/api/v3/session/create"));
}

function recoverSession(decisionUrl, sessionId, mac) {
  return httpRequest(
    decisionUrl,
    "POST",
    "/api/v3/session/recover",
    "application/json",
    Buffer.from(JSON.stringify({ session_id: sessionId, mac_address: mac })),
  ).then(parseJsonResponse("/api/v3/session/recover"));
}

async function executeChat(
  decisionUrl,
  sessionId,
  prompt,
  anthropicApiKey,
  anthropicBaseUrl,
  anthropicModel,
  skillCodeBlock = null,
  onEvent = null,
) {
  return await httpStreamSseEvents(
    decisionUrl,
    "POST",
    "/api/v3/execute/chat",
    "application/json",
    Buffer.from(JSON.stringify({
      session_id: sessionId,
      prompt,
      skill_code_block: skillCodeBlock,
      anthropic_api_key: anthropicApiKey || "",
      anthropic_base_url: anthropicBaseUrl || "",
      anthropic_model: anthropicModel || "claude-sonnet-4-6",
    })),
    onEvent,
  );
}

function sessionStatus(decisionUrl, sessionId, clientHeartbeat, refresh, mac = null) {
  void clientHeartbeat;
  void refresh;
  const sessionMac = mac || envValue("TEDLINK_MAC") || "unknown_mac";
  return recoverSession(decisionUrl, sessionId, sessionMac)
    .then((value) => normalizeV3SessionStatus(value));
}

function downloadResultArchive(decisionUrl, sessionId, targetDir) {
  return httpRequest(
    decisionUrl,
    "GET",
    `/api/v3/sync/download?session_id=${encodeURIComponent(sessionId)}&target_dir=${encodeURIComponent(targetDir)}`,
  );
}

function cancelSession(decisionUrl, sessionId, reason) {
  const payload = {
    session_id: sessionId,
    reason,
  };
  return httpRequest(
    decisionUrl,
    "POST",
    "/sessions/cancel",
    "application/json",
    Buffer.from(JSON.stringify(payload)),
  ).then(() => undefined);
}

function isTerminalState(state) {
  return ["completed", "completed_with_warnings", "failed", "cancelled"].includes(String(state || "").trim().toLowerCase());
}

function envValue(name) {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function sessionStatusJson(decisionUrl, pathSuffix) {
  const response = await httpRequest(decisionUrl, "GET", pathSuffix);
  return JSON.parse(response.toString("utf8"));
}

function parseJsonResponse(endpoint) {
  return (response) => {
    try {
      return JSON.parse(Buffer.from(response).toString("utf8"));
    } catch {
      throw new Error(`invalid JSON response from ${endpoint}: ${responsePreview(response)}`);
    }
  };
}

function parseSseEvents(response) {
  const text = Buffer.from(response).toString("utf8");
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) {
      continue;
    }
    const raw = dataLines.join("\n");
    try {
      events.push(JSON.parse(raw));
    } catch {
      events.push({ event: "raw", content: raw });
    }
  }
  return events;
}

function normalizeV3SubmitResponse(payload, streamEvents) {
  const errorEvent = streamEvents.find((event) => event.event === "error");
  if (errorEvent) {
    throw new Error(String(errorEvent.content || "tedlink-server execution failed"));
  }
  const finalStatus = [...streamEvents]
    .reverse()
    .find((event) => event.event === "status_update");
  return normalizeRequestResponse({
    session: normalizeSessionInfo({
      session_id: payload.session_id,
      prompt: payload.prompt,
      state: finalStatus ? String(finalStatus.status || "EXECUTING").toLowerCase() : "executing",
      workspace: normalizeWorkspaceInfo({
        session_dir: payload.server_workspace_path || "",
        workspace_dir: payload.server_workspace_path || payload.local_workspace_dir || "",
      }),
      metadata: {
        prompt_summary: payload.prompt,
        tedlink_v3_events: streamEvents,
      },
    }),
  });
}

function normalizeV3SessionStatus(value) {
  const sessionId = String(value.session_id || "");
  const state = String(value.status || "").toLowerCase();
  const progress = Number(value.progress || 0);
  const progressSummary = progress > 0 ? `${state || "unknown"} ${progress}%` : (state || "unknown");
  const history = Array.isArray(value.history_summary) ? value.history_summary : [];
  const prompt = firstNonEmptyString(
    value.initial_prompt,
    value.prompt_summary,
    firstUserHistoryContent(history),
  );
  const activityEvents = history.flatMap(historyActivityEvents);
  return normalizeSessionStatus({
    session: {
      session_id: sessionId,
      prompt,
      state,
      workspace: {
        session_dir: value.workspace_path || "",
        workspace_dir: value.workspace_path || "",
      },
      metadata: {
        prompt_summary: value.prompt_summary || prompt,
        server_context: value.context_info || {},
      },
    },
    todos: [
      {
        title: "tedlink-server workflow",
        state: state === "completed" ? "completed" : "running",
        stage: state,
        owner_node: "tedlink-server",
        message: progressSummary,
        artifacts: value.artifact_dir ? [value.artifact_dir] : [],
      },
    ],
    process: {
      state,
      summary: progressSummary,
      total: 1,
      completed: state === "completed" ? 1 : 0,
      failed: ["failed", "cancelled"].includes(state) ? 1 : 0,
    },
    activity: activityEvents,
    result_files: value.artifact_dir ? [{ path: value.artifact_dir }] : [],
    result_archive: value.artifact_dir
      ? {
          format: "tar.gz",
          content_type: "application/octet-stream",
          download_path: "/api/v3/sync/download",
          download_token: value.artifact_dir,
          file_count: 1,
        }
      : null,
  });
}

function firstUserHistoryContent(history) {
  const entry = history.find((item) => item.role === "user" && item.content);
  return entry ? String(entry.content || "") : "";
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function historyActivityEvents(item) {
  const role = String(item.role || "").trim();
  const content = String(item.content || "").trim();
  if (!content || !["assistant", "executor"].includes(role)) {
    return [];
  }
  const time = String(item.created_at || "");
  const events = parseStageEvents(content).map((event) => ({
    time,
    actor: "executor",
    level: event.event === "failed" ? "error" : "info",
    action: event.event,
    message: event.content,
  }));
  if (events.length > 0) {
    return events;
  }
  return [{
    time,
    actor: "executor",
    level: "info",
    action: role === "assistant" ? "plan" : "progress",
    message: content,
  }];
}

function parseStageEvents(content) {
  const text = String(content || "");
  const markerPattern = /(?:^|\n)\s*(?:#{2,3}\s*(Plan|Task|Subtask|Progress|Completed|Failed)\b|\[(PLAN|TASK|SUBTASK|TOOLS?|COMPLETED|FAILED|RESPONSE)\])\s*/ig;
  const matches = Array.from(text.matchAll(markerPattern));
  if (matches.length === 0) {
    return [];
  }
  const events = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const next = matches[i + 1];
    const rawStage = String(match[1] || match[2] || "").toLowerCase();
    const body = text.slice(match.index + match[0].length, next ? next.index : text.length).trim();
    if (!body) {
      continue;
    }
    events.push({
      event: normalizeStageEvent(rawStage),
      content: body,
    });
  }
  return events;
}

function normalizeStageEvent(stage) {
  if (stage === "tools" || stage === "tool" || stage === "progress") {
    return "tool";
  }
  if (stage === "response") {
    return "completed";
  }
  return stage;
}

function parseSessionStatusResponse(response) {
  let value;
  try {
    value = JSON.parse(Buffer.from(response).toString("utf8"));
  } catch {
    throw new Error(`invalid JSON response from /sessions/status: ${responsePreview(response)}`);
  }
  if (typeof value.error === "string") {
    throw new Error(`TedLink status failed: ${value.error}; response=${responsePreview(response)}`);
  }
  if (value && typeof value.session_id === "string" && typeof value.status === "string") {
    return normalizeV3SessionStatus(value);
  }
  return normalizeSessionStatus(value);
}

function parseSubmitResponse(response, prompt) {
  let value;
  try {
    value = JSON.parse(Buffer.from(response).toString("utf8"));
  } catch {
    throw new Error(`invalid JSON response from /requests/submit: ${responsePreview(response)}`);
  }
  if (value && value.session) {
    return normalizeRequestResponse(value);
  }
  if (value && typeof value.sessionid === "string") {
    const state = typeof value.status === "string" ? value.status : "pending";
    return normalizeRequestResponse({
      session: normalizeSessionInfo({
        session_id: value.sessionid,
        prompt,
        state,
        workspace: normalizeWorkspaceInfo(),
        metadata: {},
      }),
    });
  }
  const message =
    (value && typeof value.error === "string" && value.error) ||
    (value && typeof value.message === "string" && value.message) ||
    (value && typeof value.detail === "string" && value.detail) ||
    "response did not include `session` or legacy `sessionid`";
  throw new Error(`TedLink submit failed: ${message}; response=${responsePreview(response)}`);
}

function responsePreview(response) {
  const text = Buffer.from(response).toString("utf8");
  const compact = text.split(/\s+/).join(" ");
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}

function buildSubmitPayloadForTest(...args) {
  return buildSubmitPayload(...args);
}

async function sleep(ms) {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = {
  submitRequest,
  buildSubmitPayload: buildSubmitPayloadForTest,
  createSession,
  recoverSession,
  executeChat,
  parseSseEvents,
  normalizeV3SubmitResponse,
  pollSession,
  sessionStatus,
  downloadResultArchive,
  cancelSession,
  isTerminalState,
  parseSessionStatusResponse,
  parseSubmitResponse,
  responsePreview,
  sessionStatusJson,
};
