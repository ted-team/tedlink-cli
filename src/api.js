"use strict";

const { httpRequest } = require("./http");
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
  return httpRequest(
    decisionUrl,
    "POST",
    "/requests/submit",
    "application/json",
    Buffer.from(JSON.stringify(payload)),
  ).then((response) => parseSubmitResponse(response, prompt));
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

function sessionStatus(decisionUrl, sessionId, clientHeartbeat, refresh) {
  const heartbeat = clientHeartbeat ? "1" : "0";
  const refreshValue = refresh ? "1" : "0";
  const encoded = encodeURIComponent(sessionId);
  return httpRequest(
    decisionUrl,
    "GET",
    `/sessions/status?session_id=${encoded}&refresh=${refreshValue}&client_heartbeat=${heartbeat}`,
  ).then(parseSessionStatusResponse);
}

function downloadResultArchive(decisionUrl, sessionId, downloadToken) {
  return httpRequest(
    decisionUrl,
    "GET",
    `/sessions/result-archive?session_id=${encodeURIComponent(sessionId)}&download_token=${encodeURIComponent(downloadToken)}`,
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
  return ["completed", "failed", "cancelled"].includes(String(state || "").trim());
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
