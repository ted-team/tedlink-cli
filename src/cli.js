"use strict";

const fs = require("fs");
const path = require("path");
const { submitRequest, sessionStatus, downloadResultArchive } = require("./api");
const {
  defaultMac,
  defaultUser,
  normalizeMacIdentity,
  resultOutputDir,
  sessionPromptSummary,
  unpackResultArchive,
  collectFiles,
  resolvePath,
  expanduserPath,
} = require("./output");
const {
  isTerminalSessionState,
  isPauseSessionState,
  annotateResultDelivery,
  buildSkillResult,
  printLocalSummary,
  printResultDelivery,
  printStatusSummary,
  printStatusPhase,
} = require("./flow");
const {
  buildSessionRecord,
  findSession,
  latestSession,
  listSessions,
  sessionStorePath,
  updateSessionRecord,
  upsertSession,
} = require("./session_store");

const SESSION_FILE_NAME = ".session";
const LOCAL_POLL_INTERVAL_MS = 5000;
let currentStreamSection = "";

function printHelp() {
  console.log(`TedLink CLI

Usage:
  tedlink [options]
  tedlink session list [--output text|json]

Options:
  --prompt <TEXT>
  --prompt-file <PATH>
  --prompt-stdin
  --dir <PATH>
  --shared-dir <PATH>
  --output-dir <PATH>
  --session-id <SESSION_ID>
  --resume [SESSION_ID]
  --new
  --status <SESSION_ID>
  --submit-only
  --refresh-status
  --user <USER>
  --mac <MAC>
  --auto-plan
  --no-auto-plan
  --auto-dispatch
  --no-auto-dispatch
  --deliver-result-files
  --no-deliver-result-files
  --upload-workspace
  --no-upload-workspace
  --timeout-sec <SECONDS>
  --poll-interval-ms <MILLIS>
  --heartbeat-sec <SECONDS>
  --output <text|json>
  --quiet
`);
}

async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.command === "session-list") {
    return runSessionList(args);
  }
  if (args._positionals.length > 0) {
    throw new Error(`unexpected positional argument: ${args._positionals[0]}`);
  }
  if (args.status) {
    return runStatus(args, args.status);
  }
  const prompt = await resolvePrompt(args);
  if (args.resume) {
    return runResumeSession(args, prompt);
  }
  if (prompt !== null) {
    if (args.submit_only) {
      return runSubmitOnly(args, prompt);
    }
    return runLocalSession(args, prompt);
  }
  const workspaceDir = resolvePath(expanduserPath(args.dir));
  if (fs.existsSync(localSessionPath(workspaceDir))) {
    return runLocalSession(args, null);
  }
  throw new Error("missing prompt and no recoverable TedLink task in this directory");
}

function parseArgs(argv) {
  const args = {
    command: null,
    decision_url: envValue("TEDLINK_BASE_URL") || "http://49.232.144.199:9543",
    prompt: null,
    prompt_file: null,
    prompt_stdin: false,
    dir: ".",
    shared_dir: null,
    output_dir: null,
    session_id: null,
    resume: false,
    resume_session_id: null,
    new_session: false,
    status: null,
    submit_only: false,
    refresh_status: false,
    user: null,
    mac: null,
    auto_plan: true,
    no_auto_plan: false,
    auto_dispatch: true,
    no_auto_dispatch: false,
    deliver_result_files: true,
    no_deliver_result_files: false,
    upload_workspace: false,
    no_upload_workspace: false,
    timeout_sec: 300,
    poll_interval_ms: 500,
    heartbeat_sec: 20,
    output: "text",
    quiet: false,
    _positionals: [],
  };

  if (argv.length >= 2 && argv[0] === "session" && argv[1] === "list") {
    args.command = "session-list";
    argv = argv.slice(2);
  }

  const takesValue = new Set([
    "--prompt",
    "--prompt-file",
    "--dir",
    "--shared-dir",
    "--output-dir",
    "--session-id",
    "--status",
    "--user",
    "--mac",
    "--timeout-sec",
    "--poll-interval-ms",
    "--heartbeat-sec",
    "--output",
  ]);
  const boolFlags = new Set([
    "--prompt-stdin",
    "--new",
    "--submit-only",
    "--refresh-status",
    "--auto-plan",
    "--no-auto-plan",
    "--auto-dispatch",
    "--no-auto-dispatch",
    "--deliver-result-files",
    "--no-deliver-result-files",
    "--upload-workspace",
    "--no-upload-workspace",
    "--quiet",
  ]);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      args._positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("-")) {
      args._positionals.push(token);
      continue;
    }
    if (token.startsWith("--") && token.includes("=")) {
      const [flag, value] = token.split(/=(.*)/s, 2);
      if (flag === "--resume") {
        setArg(args, flag, value || true);
        continue;
      }
      if (!takesValue.has(flag)) {
        throw new Error(`unexpected value for ${flag}`);
      }
      setArg(args, flag, value);
      continue;
    }
    if (token === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        setArg(args, token, next);
        i += 1;
      } else {
        setArg(args, token, true);
      }
      continue;
    }
    if (boolFlags.has(token)) {
      setArg(args, token, true);
      continue;
    }
    if (!takesValue.has(token)) {
      throw new Error(`unrecognized option: ${token}`);
    }
    if (i + 1 >= argv.length) {
      throw new Error(`missing value for ${token}`);
    }
    setArg(args, token, argv[++i]);
  }

  args.timeout_sec = Number(args.timeout_sec);
  args.poll_interval_ms = Number(args.poll_interval_ms);
  args.heartbeat_sec = Number(args.heartbeat_sec);
  if (!Number.isFinite(args.timeout_sec) || args.timeout_sec < 0) {
    throw new Error("--timeout-sec must be a non-negative integer");
  }
  if (!Number.isFinite(args.poll_interval_ms) || args.poll_interval_ms < 0) {
    throw new Error("--poll-interval-ms must be a non-negative integer");
  }
  if (!Number.isFinite(args.heartbeat_sec) || args.heartbeat_sec < 0) {
    throw new Error("--heartbeat-sec must be a non-negative integer");
  }
  if (!["text", "json"].includes(String(args.output).toLowerCase())) {
    throw new Error("--output must be one of: text, json");
  }
  if (args.resume && args.new_session) {
    throw new Error("use only one of --resume or --new");
  }
  args.output = String(args.output).toLowerCase();
  return args;
}

function setArg(args, flag, value) {
  switch (flag) {
    case "--prompt":
      args.prompt = value;
      break;
    case "--prompt-file":
      args.prompt_file = value;
      break;
    case "--prompt-stdin":
      args.prompt_stdin = true;
      break;
    case "--dir":
      args.dir = value;
      break;
    case "--shared-dir":
      args.shared_dir = value;
      break;
    case "--output-dir":
      args.output_dir = value;
      break;
    case "--session-id":
      args.session_id = value;
      break;
    case "--resume":
      args.resume = true;
      if (value !== true) {
        args.resume_session_id = value;
      }
      break;
    case "--new":
      args.new_session = true;
      break;
    case "--status":
      args.status = value;
      break;
    case "--submit-only":
      args.submit_only = true;
      break;
    case "--refresh-status":
      args.refresh_status = true;
      break;
    case "--user":
      args.user = value;
      break;
    case "--mac":
      args.mac = value;
      break;
    case "--auto-plan":
      args.auto_plan = true;
      break;
    case "--no-auto-plan":
      args.no_auto_plan = true;
      break;
    case "--auto-dispatch":
      args.auto_dispatch = true;
      break;
    case "--no-auto-dispatch":
      args.no_auto_dispatch = true;
      break;
    case "--deliver-result-files":
      args.deliver_result_files = true;
      break;
    case "--no-deliver-result-files":
      args.no_deliver_result_files = true;
      break;
    case "--upload-workspace":
      args.upload_workspace = true;
      break;
    case "--no-upload-workspace":
      args.no_upload_workspace = true;
      break;
    case "--timeout-sec":
      args.timeout_sec = value;
      break;
    case "--poll-interval-ms":
      args.poll_interval_ms = value;
      break;
    case "--heartbeat-sec":
      args.heartbeat_sec = value;
      break;
    case "--output":
      args.output = value;
      break;
    case "--quiet":
      args.quiet = true;
      break;
    default:
      throw new Error(`unhandled option: ${flag}`);
  }
}

function envValue(name) {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function effectiveAutoPlan(args) {
  return args.auto_plan && !args.no_auto_plan;
}

function effectiveAutoDispatch(args) {
  return args.auto_dispatch && !args.no_auto_dispatch;
}

function effectiveDeliverResultFiles(args) {
  return args.deliver_result_files && !args.no_deliver_result_files;
}

function effectiveUploadWorkspace(args) {
  return args.upload_workspace && !args.no_upload_workspace;
}

async function runStatus(args, sessionId) {
  const mac = normalizeMacIdentity(args.mac || defaultMac());
  let status = await sessionStatus(
    args.decision_url,
    sessionId,
    false,
    args.refresh_status,
    mac,
  );
  if (effectiveDeliverResultFiles(args) && !args.refresh_status && isTerminalSessionState(status.session.state)) {
    status = await sessionStatus(args.decision_url, sessionId, false, true, mac);
  }
  const workspaceDir = resolvePath(expanduserPath(args.dir));
  const outputDir = args.output_dir
    ? resolvePath(expanduserPath(args.output_dir))
    : resultOutputDir(
        workspaceDir,
        sessionPromptSummary(status),
        status.session.session_id,
      );
  const written = effectiveDeliverResultFiles(args) && isTerminalSessionState(status.session.state)
    ? await downloadAndUnpackResultArchive(args.decision_url, status, outputDir)
    : [];
  annotateResultDelivery(status, written);
  persistStatusSession(args, status, workspaceDir, outputDir, mac);
  if (args.output === "text") {
    printStatusSummary(status.session.prompt, status);
    printStatusPhase(status);
    printResultDelivery(status, written, outputDir);
    return;
  }
  const result = buildSkillResult(status, written, outputDir);
  console.log(JSON.stringify(result, null, 2));
}

async function runSubmitOnly(args, prompt) {
  const user = args.user || defaultUser();
  const mac = normalizeMacIdentity(args.mac || defaultMac());
  const submittedAt = Date.now();
  const workspaceDir = resolvePath(expanduserPath(args.dir));
  const sharedDir = args.shared_dir ? resolvePath(expanduserPath(args.shared_dir)) : null;
  const files = effectiveUploadWorkspace(args) ? collectFiles(workspaceDir) : [];
  const sharedFiles = sharedDir ? collectFiles(sharedDir) : [];
  const session = await submitRequest(
    args.decision_url,
    prompt,
    args.session_id,
    user,
    mac,
    effectiveAutoPlan(args),
    effectiveAutoDispatch(args),
    effectiveDeliverResultFiles(args),
    files,
    sharedFiles,
    String(workspaceDir),
    false,
    args.output === "text" && !args.quiet ? printStreamEvent : null,
  );
  const initialStatus = {
    session: { ...session.session },
    todos: [],
    process: {},
    activity: [],
    result_files: [],
    result_archive: null,
    error: "",
  };
  const outputDir = args.output_dir
    ? String(resolvePath(expanduserPath(args.output_dir)))
    : null;
  upsertSession(buildSessionRecord({
    sessionId: session.session.session_id,
    prompt: session.session.prompt,
    decisionUrl: args.decision_url,
    workspaceDir: String(workspaceDir),
    outputDir,
    user,
    mac,
    state: session.session.state,
  }));
  if (args.output === "text" && !args.quiet) {
    printLocalSummary(session.session.prompt, initialStatus, submittedAt);
  }
  if (args.output === "text") {
    console.log("TedLink submitted");
    console.log(`  session: ${session.session.session_id}`);
    console.log(`  state: ${session.session.state}`);
    console.log(`  prompt: ${session.session.prompt.trim()}`);
    return;
  }
  console.log(JSON.stringify(session, null, 2));
}

async function runResumeSession(args, prompt) {
  const stored = resolveResumeSession(args);
  args.session_id = stored.session_id;
  if (stored.decision_url && stored.decision_url.trim()) {
    args.decision_url = stored.decision_url;
  }
  if (!args.output_dir && stored.output_dir) {
    args.output_dir = stored.output_dir;
  }
  const workspaceDir = resolvePath(expanduserPath(
    args.dir !== "." ? args.dir : (stored.workspace_dir || args.dir),
  ));
  const sessionPath = localSessionPath(workspaceDir);
  if (args.output === "text" && !args.quiet) {
    console.log("TedLink conversation resumed");
    console.log(`  session: ${stored.session_id}`);
    console.log(`  initial prompt: ${(stored.prompt_summary || stored.prompt || "").trim()}`);
    if (prompt) {
      console.log(`  follow-up: ${prompt.trim()}`);
    }
    console.log();
  }
  if (prompt === null) {
    const localSession = {
      session_id: stored.session_id,
      prompt: stored.prompt,
      decision_url: args.decision_url,
      output_dir: args.output_dir || stored.output_dir || null,
      created_unix_secs: currentUnixSecs(),
    };
    await writeLocalSession(sessionPath, localSession);
    return pollLocalSession(args, localSession, workspaceDir, sessionPath, Date.now());
  }
  const localSession = await submitLocalSession(
    args,
    prompt,
    workspaceDir,
    sessionPath,
    {
      initialPrompt: stored.prompt,
      preservePromptSummary: true,
      resumeSession: true,
      storedSession: stored,
    },
  );
  return pollLocalSession(args, localSession, workspaceDir, sessionPath, Date.now());
}

async function runLocalSession(args, prompt) {
  const submittedAt = Date.now();
  const workspaceDir = resolvePath(expanduserPath(args.dir));
  const sessionPath = localSessionPath(workspaceDir);
  let localSession = await readLocalSession(sessionPath);
  if (localSession) {
    if (shouldStartNewLocalSession(args, prompt, localSession)) {
      if (prompt === null) {
        throw new Error("missing prompt for new TedLink task in this directory");
      }
      localSession = await submitLocalSession(args, prompt, workspaceDir, sessionPath);
    } else {
      if (localSession.decision_url && localSession.decision_url.trim()) {
        args.decision_url = localSession.decision_url;
      }
      if (!args.output_dir && localSession.output_dir) {
        args.output_dir = localSession.output_dir;
      }
      if (args.output === "text" && !args.quiet) {
        console.log("TedLink task resumed");
        console.log(`  task: ${localSession.session_id}`);
        console.log(`  prompt: ${localSession.prompt.trim()}`);
        console.log();
      }
    }
  } else {
    if (prompt === null) {
      throw new Error("missing prompt and no recoverable TedLink task in this directory");
    }
    localSession = await submitLocalSession(args, prompt, workspaceDir, sessionPath);
  }

  return pollLocalSession(args, localSession, workspaceDir, sessionPath, submittedAt);
}

async function pollLocalSession(args, localSession, workspaceDir, sessionPath, submittedAt) {
  const mac = normalizeMacIdentity(args.mac || defaultMac());
  while (true) {
    let status = await sessionStatus(args.decision_url, localSession.session_id, false, true, mac);
    if (!status.session.prompt || !status.session.prompt.trim()) {
      status.session.prompt = localSession.prompt;
    }
    if (args.output === "text" && !args.quiet) {
      printLocalSummary(status.session.prompt, status, submittedAt);
      printStatusPhase(status);
    }
    if (isTerminalSessionState(status.session.state)) {
      await finishLocalSession(args, status, workspaceDir, sessionPath);
      return;
    }
    if (isPauseSessionState(status.session.state)) {
      if (args.output === "text" && !args.quiet) {
        console.log();
        console.log("TedLink paused");
        console.log(`  state: ${status.session.state}`);
        console.log("  run tedlink again with a follow-up prompt to continue this session");
      } else if (args.output === "json") {
        const result = buildSkillResult(status, [], workspaceDir);
        console.log(JSON.stringify(result, null, 2));
      }
      return;
    }
    await sleep(LOCAL_POLL_INTERVAL_MS);
  }
}

function resolveResumeSession(args) {
  const sessionId = String(args.resume_session_id || "").trim();
  const stored = sessionId ? findSession(sessionId) : latestSession();
  if (!stored) {
    if (sessionId) {
      throw new Error(`cannot resume unknown TedLink session: ${sessionId}`);
    }
    throw new Error(`cannot resume: no TedLink sessions in ${sessionStorePath()}`);
  }
  return stored;
}

function shouldStartNewLocalSession(args, prompt, existing) {
  if (args.new_session) {
    return prompt !== null;
  }
  if (prompt === null) {
    return false;
  }
  return normalizePromptForReuse(prompt) !== normalizePromptForReuse(existing.prompt);
}

function normalizePromptForReuse(value) {
  return String(value).trim().split(/\s+/).filter(Boolean).join(" ");
}

async function submitLocalSession(args, prompt, workspaceDir, sessionPath, options = {}) {
  const user = args.user || defaultUser();
  const mac = normalizeMacIdentity(args.mac || defaultMac());
  const sharedDir = args.shared_dir ? resolvePath(expanduserPath(args.shared_dir)) : null;
  const files = effectiveUploadWorkspace(args) ? collectFiles(workspaceDir) : [];
  const sharedFiles = sharedDir ? collectFiles(sharedDir) : [];
  const session = await submitRequest(
    args.decision_url,
    prompt,
    args.session_id,
    user,
    mac,
    effectiveAutoPlan(args),
    effectiveAutoDispatch(args),
    effectiveDeliverResultFiles(args),
    files,
    sharedFiles,
    String(workspaceDir),
    false,
    args.output === "text" && !args.quiet ? printStreamEvent : null,
  );
  const outputDir = args.output_dir
    ? String(resolvePath(expanduserPath(args.output_dir)))
    : null;
  const localSession = {
    session_id: session.session.session_id,
    prompt: options.initialPrompt || session.session.prompt,
    decision_url: args.decision_url,
    output_dir: outputDir,
    created_unix_secs: currentUnixSecs(),
  };
  await writeLocalSession(sessionPath, localSession);
  if (options.preservePromptSummary) {
    updateSessionRecord(session.session.session_id, {
      decision_url: args.decision_url,
      workspace_dir: String(workspaceDir),
      output_dir: outputDir,
      user,
      mac,
      state: session.session.state,
      updated_at: new Date().toISOString(),
    });
  } else {
    upsertSession(buildSessionRecord({
      sessionId: session.session.session_id,
      prompt: session.session.prompt,
      decisionUrl: args.decision_url,
      workspaceDir: String(workspaceDir),
      outputDir,
      user,
      mac,
      state: session.session.state,
    }));
  }
  if (args.output === "text" && !args.quiet) {
    const initialStatus = {
      session: { ...session.session },
      todos: [],
      process: {},
      activity: [],
      result_files: [],
      result_archive: null,
      error: "",
    };
    printLocalSummary(options.initialPrompt || session.session.prompt, initialStatus, Date.now());
    console.log(options.resumeSession ? "TedLink follow-up sent" : "TedLink task started");
    console.log("Polling every 5 seconds. If this process is interrupted, run tedlink again in this directory to continue.");
    console.log();
  }
  return localSession;
}

async function finishLocalSession(args, finalStatus, workspaceDir, sessionPath) {
  const outputDir = args.output_dir
    ? resolvePath(expanduserPath(args.output_dir))
    : resultOutputDir(
        workspaceDir,
        sessionPromptSummary(finalStatus),
        finalStatus.session.session_id,
      );
  let deliveryError = null;
  let written = [];
  try {
    if (effectiveDeliverResultFiles(args)) {
      written = await downloadAndUnpackResultArchive(args.decision_url, finalStatus, outputDir);
    }
    annotateResultDelivery(finalStatus, written);
    persistStatusSession(args, finalStatus, workspaceDir, outputDir);
    if (args.output === "text") {
      printResultDelivery(finalStatus, written, outputDir);
    } else {
      const result = buildSkillResult(finalStatus, written, outputDir);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    deliveryError = err;
  } finally {
    const cleanupError = await removeLocalSession(sessionPath).catch((err) => err);
    if (deliveryError) {
      throw deliveryError;
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

function runSessionList(args) {
  const sessions = listSessions();
  if (args.output === "json") {
    console.log(JSON.stringify({
      store_path: sessionStorePath(),
      sessions,
    }, null, 2));
    return;
  }
  console.log("TedLink Sessions");
  console.log(`  store: ${sessionStorePath()}`);
  if (sessions.length === 0) {
    console.log("  - none");
    return;
  }
  for (const session of sessions) {
    const summary = session.prompt_summary || "(no prompt summary)";
    const state = session.state ? ` state=${session.state}` : "";
    const workspace = session.workspace_dir ? ` dir=${session.workspace_dir}` : "";
    const updated = session.updated_at ? ` updated=${session.updated_at}` : "";
    console.log(`  - ${session.session_id}${state}${updated}`);
    console.log(`    prompt: ${summary}`);
    if (workspace) {
      console.log(`   ${workspace}`);
    }
  }
}

function persistStatusSession(args, status, workspaceDir, outputDir, mac = null) {
  const session = status.session || {};
  const sessionId = String(session.session_id || "").trim();
  if (!sessionId) {
    return;
  }
  const workspace = session.workspace && session.workspace.workspace_dir
    ? session.workspace.workspace_dir
    : String(workspaceDir || "");
  const prompt = String(session.prompt || "").trim();
  const existingRecord = findSession(sessionId);
  const initialPrompt = existingRecord && String(existingRecord.prompt || "").trim()
    ? String(existingRecord.prompt || "").trim()
    : prompt;
  const initialSummary = existingRecord && String(existingRecord.prompt_summary || "").trim()
    ? String(existingRecord.prompt_summary || "").trim()
    : (sessionPromptSummary(status) || initialPrompt);
  const now = new Date().toISOString();
  const patch = {
    prompt_summary: initialSummary,
    decision_url: args.decision_url,
    workspace_dir: workspace,
    output_dir: outputDir ? String(outputDir) : null,
    mac: mac || "",
    state: String(session.state || ""),
    updated_at: now,
  };
  if (initialPrompt) {
    patch.prompt = initialPrompt;
  }
  const existing = updateSessionRecord(sessionId, patch);
  if (existing) {
    return;
  }
  upsertSession(buildSessionRecord({
    sessionId,
    prompt: initialPrompt,
    decisionUrl: args.decision_url,
    workspaceDir: workspace,
    outputDir: outputDir ? String(outputDir) : null,
    mac: mac || "",
    state: String(session.state || ""),
    updatedAt: now,
  }));
}

async function resolvePrompt(args) {
  let sources = 0;
  if (args.prompt !== null) sources += 1;
  if (args.prompt_file !== null) sources += 1;
  if (args.prompt_stdin) sources += 1;
  if (sources > 1) {
    throw new Error("use only one of --prompt, --prompt-file, or --prompt-stdin");
  }
  if (args.prompt !== null) {
    return args.prompt;
  }
  if (args.prompt_file !== null) {
    const filePath = args.prompt_file;
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (err) {
      throw new Error(`failed to read prompt file ${filePath}`);
    }
  }
  if (args.prompt_stdin) {
    return await readStdin();
  }
  return null;
}

async function downloadAndUnpackResultArchive(decisionUrl, status, outputDir) {
  const resultArchive = status.result_archive;
  const targetDir = resultArchive && String(resultArchive.download_token || "").trim();
  if ((!status.result_files || status.result_files.length === 0) && !targetDir) {
    return [];
  }
  if (!resultArchive) {
    throw new Error("missing result archive metadata in terminal status");
  }
  if (!targetDir) {
    throw new Error("missing result archive target_dir in terminal status");
  }
  const archive = await downloadResultArchive(
    decisionUrl,
    status.session.session_id,
    targetDir,
  );
  return unpackResultArchive(outputDir, archive);
}

function printStreamEvent(event) {
  if (!event || typeof event !== "object") {
    return;
  }
  if (["plan", "tool", "task", "subtask", "completed", "failed"].includes(event.event)) {
    const content = String(event.content || "");
    printStreamSection(event.event);
    if (content) {
      process.stdout.write(content);
    }
    return;
  }
  if (event.event === "status_update") {
    console.log();
    console.log(`Status: ${event.status || ""} ${event.progress ?? ""}`.trim());
    return;
  }
  if (event.event === "tool_output") {
    const content = String(event.content || "").trim();
    if (content) {
      console.log();
      console.log(content);
    }
    return;
  }
  if (event.event === "error") {
    const content = String(event.content || "").trim();
    if (content) {
      console.log();
      console.log(`Error: ${content}`);
    }
  }
}

function printStreamSection(section) {
  if (section === currentStreamSection) {
    return;
  }
  currentStreamSection = section;
  const label = {
    plan: "## Plan",
    tool: "## Progress",
    task: "## Task",
    subtask: "## Subtask",
    completed: "## Completed",
    failed: "## Failed",
  }[section] || section;
  process.stdout.write(`\n${label}\n`);
}

function localSessionPath(workspaceDir) {
  return path.join(workspaceDir, SESSION_FILE_NAME);
}

async function readLocalSession(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const text = fs.readFileSync(filePath, "utf8");
  const session = JSON.parse(text);
  if (!String(session.session_id || "").trim()) {
    throw new Error(`${filePath} is missing session_id`);
  }
  return session;
}

async function writeLocalSession(filePath, session) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2));
}

async function removeLocalSession(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return;
    }
    throw new Error(`failed to remove ${filePath}`);
  }
}

function currentUnixSecs() {
  return Math.floor(Date.now() / 1000);
}

async function sleep(ms) {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

module.exports = {
  runCli,
  printHelp,
  parseArgs,
  effectiveAutoPlan,
  effectiveAutoDispatch,
  effectiveDeliverResultFiles,
  effectiveUploadWorkspace,
  localSessionPath,
  normalizePromptForReuse,
  shouldStartNewLocalSession,
  resolveResumeSession,
  resolvePrompt,
  currentUnixSecs,
};
