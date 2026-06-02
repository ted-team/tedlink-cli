"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE_DIR_NAME = ".tedlink";
const STORE_FILE_NAME = "sessions.json";

function tedlinkHome() {
  const configured = process.env.TEDLINK_HOME;
  if (configured && configured.trim()) {
    return expandHome(configured.trim());
  }
  const home = process.env.HOME || os.homedir();
  return path.join(home, STORE_DIR_NAME);
}

function sessionStorePath() {
  return path.join(tedlinkHome(), STORE_FILE_NAME);
}

function loadSessionStore(filePath = sessionStorePath()) {
  if (!fs.existsSync(filePath)) {
    return { version: 1, sessions: [] };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`failed to read TedLink session store ${filePath}: ${err.message}`);
  }
  const sessions = Array.isArray(data.sessions) ? data.sessions.map(normalizeStoredSession).filter(Boolean) : [];
  return { version: 1, sessions };
}

function saveSessionStore(store, filePath = sessionStorePath()) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const normalized = {
    version: 1,
    sessions: Array.isArray(store.sessions)
      ? store.sessions.map(normalizeStoredSession).filter(Boolean)
      : [],
  };
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
}

function upsertSession(record, filePath = sessionStorePath()) {
  const store = loadSessionStore(filePath);
  const normalized = normalizeStoredSession(record);
  if (!normalized) {
    throw new Error("cannot persist TedLink session without session_id");
  }
  const nextSessions = store.sessions.filter((item) => item.session_id !== normalized.session_id);
  nextSessions.unshift(normalized);
  store.sessions = nextSessions;
  saveSessionStore(store, filePath);
  return normalized;
}

function updateSessionRecord(sessionId, patch, filePath = sessionStorePath()) {
  const store = loadSessionStore(filePath);
  const index = store.sessions.findIndex((item) => item.session_id === sessionId);
  if (index < 0) {
    return null;
  }
  const next = normalizeStoredSession({ ...store.sessions[index], ...patch });
  store.sessions[index] = next;
  saveSessionStore(store, filePath);
  return next;
}

function listSessions(filePath = sessionStorePath()) {
  const store = loadSessionStore(filePath);
  return store.sessions.slice().sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

function findSession(sessionId, filePath = sessionStorePath()) {
  const target = String(sessionId || "").trim();
  if (!target) {
    return null;
  }
  return listSessions(filePath).find((item) => item.session_id === target) || null;
}

function latestSession(filePath = sessionStorePath()) {
  const sessions = listSessions(filePath);
  return sessions.length > 0 ? sessions[0] : null;
}

function buildSessionRecord({
  sessionId,
  prompt,
  decisionUrl,
  workspaceDir,
  outputDir = null,
  user = "",
  mac = "",
  state = "",
  createdAt = null,
  updatedAt = null,
}) {
  const now = new Date().toISOString();
  return normalizeStoredSession({
    session_id: sessionId,
    prompt,
    prompt_summary: promptSummary(prompt),
    decision_url: decisionUrl,
    workspace_dir: workspaceDir,
    output_dir: outputDir,
    user,
    mac,
    state,
    created_at: createdAt || now,
    updated_at: updatedAt || now,
  });
}

function normalizeStoredSession(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sessionId = String(value.session_id || "").trim();
  if (!sessionId) {
    return null;
  }
  const prompt = String(value.prompt || "");
  return {
    session_id: sessionId,
    prompt,
    prompt_summary: String(value.prompt_summary || promptSummary(prompt)),
    decision_url: String(value.decision_url || ""),
    workspace_dir: String(value.workspace_dir || ""),
    output_dir: value.output_dir ? String(value.output_dir) : null,
    user: String(value.user || ""),
    mac: String(value.mac || ""),
    state: String(value.state || ""),
    created_at: String(value.created_at || ""),
    updated_at: String(value.updated_at || value.created_at || ""),
  };
}

function promptSummary(value, limit = 80) {
  const compact = String(value || "").split(/\s+/).filter(Boolean).join(" ");
  if (compact.length <= limit) {
    return compact;
  }
  return compact.slice(0, Math.max(0, limit - 3)) + "...";
}

function expandHome(input) {
  if (input === "~") {
    return process.env.HOME || os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(process.env.HOME || os.homedir(), input.slice(2));
  }
  return input;
}

module.exports = {
  tedlinkHome,
  sessionStorePath,
  loadSessionStore,
  saveSessionStore,
  upsertSession,
  updateSessionRecord,
  listSessions,
  findSession,
  latestSession,
  buildSessionRecord,
  promptSummary,
};
