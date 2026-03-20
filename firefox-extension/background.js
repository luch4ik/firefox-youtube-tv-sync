"use strict";

const HELPER_URL = "http://127.0.0.1:49314";
const CLIENT_HEADER_NAME = "X-Firefox-Cast-Client";
const CLIENT_HEADER_VALUE = "firefox-extension";
const ALLOWED_PATHS = ["/health", "/devices", "/cast", "/youtube-remote/status", "/youtube-remote/command"];

function isAllowedPath(path) {
  return typeof path === "string" &&
    path.startsWith("/") &&
    ALLOWED_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}?`));
}

browser.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "cast-helper-request") {
    return undefined;
  }
  if (!isAllowedPath(message.path)) {
    return Promise.reject(new Error("Blocked helper path"));
  }

  return fetch(`${HELPER_URL}${message.path}`, {
    method: message.method || "GET",
    headers: {
      "Content-Type": "application/json",
      [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE,
    },
    body: message.body ? JSON.stringify(message.body) : undefined,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Request failed with ${response.status}`);
    }
    return payload;
  });
});
