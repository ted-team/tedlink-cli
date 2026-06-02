"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

function expanduserPath(input) {
  const text = String(input || "");
  if (text === "~") {
    return process.env.HOME ? process.env.HOME : text;
  }
  if (text.startsWith("~/")) {
    return process.env.HOME ? path.join(process.env.HOME, text.slice(2)) : text;
  }
  return text;
}

function resolvePath(input) {
  const value = typeof input === "string" ? input : String(input || "");
  try {
    return fs.realpathSync(value);
  } catch {
    return path.isAbsolute(value) ? value : path.resolve(value);
  }
}

function unpackResultArchive(root, archive) {
  if (isGzipArchive(archive)) {
    return unpackResultArchive(root, zlib.gunzipSync(archive));
  }
  const written = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const filePath = tarHeaderPath(header);
    const size = tarHeaderSize(header);
    const typeflag = header[156];
    const dataEnd = offset + size;
    if (dataEnd > archive.length) {
      throw new Error("truncated tar archive");
    }
    if (typeflag === 0x30 || typeflag === 0) {
      const relative = safeRelativePath(filePath);
      if (relative) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, archive.subarray(offset, dataEnd));
        written.push(relative.split(path.sep).join("/"));
      }
    } else if (typeflag === 0x35) {
      const relative = safeRelativePath(filePath);
      if (relative) {
        fs.mkdirSync(path.join(root, relative), { recursive: true });
      }
    }
    offset = dataEnd + ((512 - (size % 512)) % 512);
  }
  return written;
}

function isGzipArchive(bytes) {
  return bytes && bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function resultOutputDir(workspaceDir, summary, sessionId) {
  return path.join(workspaceDir, ".tedlink", resultFolderName(summary, sessionId));
}

function sessionPromptSummary(status) {
  const metadata = status.session && status.session.metadata ? status.session.metadata : {};
  return String(metadata.prompt_summary || "");
}

function resultFolderName(summary, sessionId) {
  const sanitized = sanitizeResultFolderComponent(summary);
  if (sanitized) {
    return sanitized;
  }
  const fallbackId = sanitizeResultFolderComponent(sessionId);
  if (!fallbackId) {
    return "tedlink-result";
  }
  return `tedlink-${fallbackId}`;
}

function sanitizeResultFolderComponent(value) {
  const text = String(value || "").trim();
  let out = "";
  let lastWasSep = false;
  let count = 0;
  for (const ch of Array.from(text)) {
    if (count >= 32) {
      break;
    }
    if (/^[A-Za-z0-9]$/.test(ch)) {
      out += ch.toLowerCase();
      lastWasSep = false;
      count += 1;
    } else if (/\p{L}|\p{N}/u.test(ch)) {
      out += ch;
      lastWasSep = false;
      count += 1;
    } else if (!lastWasSep && out.length > 0) {
      out += "-";
      lastWasSep = true;
      count += 1;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

function tarHeaderPath(header) {
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  if (!prefix) {
    return name;
  }
  if (!name) {
    return prefix;
  }
  return `${prefix}/${name}`;
}

function tarHeaderSize(header) {
  const text = tarString(header.subarray(124, 136));
  if (!text) {
    return 0;
  }
  const parsed = parseInt(text.trim(), 8);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid tar entry size: ${text}`);
  }
  return parsed;
}

function tarString(bytes) {
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  return Buffer.from(bytes.subarray(0, end)).toString("utf8").trim();
}

function safeRelativePath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part && part !== "." && part !== "..");
  return parts.join(path.sep);
}

function defaultUser() {
  return process.env.USER || "unknown";
}

function collectFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) {
    return files;
  }
  collectFilesInner(root, root, files);
  return files;
}

function collectFilesInner(root, current, files) {
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort(sortStrings);
  for (const entryName of entries) {
    const fullPath = path.join(current, entryName);
    const relative = path.relative(root, fullPath).split(path.sep).join("/");
    if (isIgnoredSyncPath(relative)) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      collectFilesInner(root, fullPath, files);
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const bytes = fs.readFileSync(fullPath);
    files.push({
      path: relative,
      content_b64: bytes.toString("base64"),
      md5: md5Hex(bytes),
    });
  }
}

function isIgnoredSyncPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "__pycache__")) {
    return true;
  }
  const ext = path.extname(parts.length > 0 ? parts[parts.length - 1] : "");
  return ext === ".pyc";
}

function md5Hex(bytes) {
  return crypto.createHash("md5").update(bytes).digest("hex");
}

function defaultMac() {
  return systemMacAddress() || fallbackMac();
}

function normalizeMacIdentity(value) {
  const normalized = normalizeMac(value);
  return normalized || fallbackMac();
}

function systemMacAddress() {
  const netDir = "/sys/class/net";
  if (!fs.existsSync(netDir)) {
    return null;
  }
  const interfaces = fs.readdirSync(netDir).sort(sortStrings);
  for (const iface of interfaces) {
    if (iface === "lo") {
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(netDir, iface, "address"), "utf8");
      const normalized = normalizeMac(raw);
      if (normalized) {
        return normalized;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function fallbackMac() {
  const user = process.env.USER || "unknown";
  const host = process.env.HOSTNAME || "localhost";
  const normalized = normalizeMac(`${user}_${host}`);
  return normalized || "unknown_mac";
}

function normalizeMac(value) {
  if (isZeroMacPlaceholder(value)) {
    return "";
  }
  let out = "";
  let lastWasSep = false;
  for (const ch of String(value || "").toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      out += ch;
      lastWasSep = false;
    } else if (!lastWasSep) {
      out += "_";
      lastWasSep = true;
    }
  }
  return out.replace(/^_+|_+$/g, "");
}

function isZeroMacPlaceholder(value) {
  const compact = Array.from(String(value || ""))
    .filter((ch) => /[A-Za-z0-9]/.test(ch))
    .join("")
    .toLowerCase();
  return compact.length > 0 && Array.from(compact).every((ch) => ch === "0");
}

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function sortStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

module.exports = {
  expanduserPath,
  resolvePath,
  unpackResultArchive,
  resultOutputDir,
  sessionPromptSummary,
  defaultUser,
  collectFiles,
  defaultMac,
  normalizeMacIdentity,
  normalizeMac,
  isZeroMacPlaceholder,
  formatElapsed,
  resultFolderName,
  sanitizeResultFolderComponent,
  safeRelativePath,
  md5Hex,
};
