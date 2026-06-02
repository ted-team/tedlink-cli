"use strict";

const http = require("http");
const { URL } = require("url");

function httpRequest(decisionUrl, method, pathSuffix, contentType = null, body = null) {
  return httpRequestRaw(decisionUrl, method, pathSuffix, contentType, body)
    .then(({ body: responseBody }) => responseBody);
}

function httpRequestRaw(decisionUrl, method, pathSuffix, contentType = null, body = null) {
  const { host, port, basePath } = parseUrl(decisionUrl);
  const bodyBuffer = body ? Buffer.from(body) : Buffer.alloc(0);
  const { headers, tokenSource } = requestHeaders(host, port, contentType, bodyBuffer);

  const options = {
    host,
    port,
    method,
    path: `${basePath}${pathSuffix}`,
    headers,
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(httpError(statusCode, responseBody, tokenSource));
          return;
        }
        resolve({ body: responseBody, statusCode });
      });
    });
    req.on("error", reject);
    if (bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

function httpStreamSseEvents(
  decisionUrl,
  method,
  pathSuffix,
  contentType = null,
  body = null,
  onEvent = null,
) {
  const { host, port, basePath } = parseUrl(decisionUrl);
  const bodyBuffer = body ? Buffer.from(body) : Buffer.alloc(0);
  const { headers, tokenSource } = requestHeaders(host, port, contentType, bodyBuffer);

  const options = {
    host,
    port,
    method,
    path: `${basePath}${pathSuffix}`,
    headers,
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const statusCode = res.statusCode || 0;
      const chunks = [];
      const events = [];
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (statusCode < 200 || statusCode >= 300) {
          chunks.push(Buffer.from(chunk, "utf8"));
          return;
        }
        buffer += chunk;
        buffer = drainSseBuffer(buffer, (event) => {
          events.push(event);
          if (onEvent) {
            onEvent(event);
          }
        });
      });
      res.on("end", () => {
        if (statusCode < 200 || statusCode >= 300) {
          reject(httpError(statusCode, Buffer.concat(chunks), tokenSource));
          return;
        }
        drainSseBuffer(`${buffer}\n\n`, (event) => {
          events.push(event);
          if (onEvent) {
            onEvent(event);
          }
        });
        resolve(events);
      });
    });
    req.on("error", reject);
    if (bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

function requestHeaders(host, port, contentType, bodyBuffer) {
  const headers = {
    Host: `${host}:${port}`,
    Connection: "close",
  };
  const tokenSource = authTokenFromEnv();
  const token = tokenSource.value;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  if (bodyBuffer.length > 0) {
    headers["Content-Length"] = String(bodyBuffer.length);
  }
  return { headers, tokenSource };
}

function httpError(statusCode, responseBody, tokenSource) {
  const authHint = tokenSource.value
    ? ` TEDLINK_AUTH_TOKEN/TEDLINK_TOKEN was sent from ${tokenSource.name}.`
    : " TEDLINK_AUTH_TOKEN/TEDLINK_TOKEN is not set in the CLI process.";
  return new Error(
    `HTTP ${statusCode}: ${responseBody.toString("utf8").replace(/\n/g, " ")}${authHint}`,
  );
}

function drainSseBuffer(buffer, onEvent) {
  let remaining = buffer;
  while (true) {
    const match = remaining.match(/\r?\n\r?\n/);
    if (!match || match.index === undefined) {
      return remaining;
    }
    const block = remaining.slice(0, match.index);
    remaining = remaining.slice(match.index + match[0].length);
    const event = parseSseBlock(block);
    if (event) {
      onEvent(event);
    }
  }
}

function parseSseBlock(block) {
  const dataLines = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) {
    return null;
  }
  const raw = dataLines.join("\n");
  try {
    return JSON.parse(raw);
  } catch {
    return { event: "raw", content: raw };
  }
}

function authTokenFromEnv() {
  const authToken = envValue("TEDLINK_AUTH_TOKEN");
  if (authToken) {
    return { name: "TEDLINK_AUTH_TOKEN", value: authToken };
  }
  const legacyToken = envValue("TEDLINK_TOKEN");
  if (legacyToken) {
    return { name: "TEDLINK_TOKEN", value: legacyToken };
  }
  return { name: "", value: null };
}

function parseUrl(url) {
  const parsed = new URL(String(url).trim());
  if (parsed.protocol !== "http:") {
    throw new Error("only http:// URLs are supported");
  }
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 80;
  const basePath = parsed.pathname === "/" ? "" : parsed.pathname;
  return { host, port, basePath };
}

function envValue(name) {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

module.exports = {
  httpRequest,
  httpStreamSseEvents,
  parseUrl,
  authTokenFromEnv,
  parseSseBlock,
};
