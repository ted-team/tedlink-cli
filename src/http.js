"use strict";

const http = require("http");
const { URL } = require("url");

function httpRequest(decisionUrl, method, pathSuffix, contentType = null, body = null) {
  const { host, port, basePath } = parseUrl(decisionUrl);
  const bodyBuffer = body ? Buffer.from(body) : Buffer.alloc(0);
  const headers = {
    Host: `${host}:${port}`,
    Connection: "close",
  };
  const token = envValue("TEDLINK_TOKEN");
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  if (bodyBuffer.length > 0) {
    headers["Content-Length"] = String(bodyBuffer.length);
  }

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
          reject(
            new Error(
              `HTTP ${statusCode}: ${responseBody.toString("utf8").replace(/\n/g, " ")}`,
            ),
          );
          return;
        }
        resolve(responseBody);
      });
    });
    req.on("error", reject);
    if (bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
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
  parseUrl,
};
