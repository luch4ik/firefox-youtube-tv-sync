"use strict";

const HELPER_URL = "http://127.0.0.1:49314";
const CLIENT_HEADER_NAME = "X-Firefox-Cast-Client";
const CLIENT_HEADER_VALUE = "chrome-extension";
const ALLOWED_PATHS = ["/health", "/devices", "/cast", "/youtube-remote/status", "/youtube-remote/command"];

function isAllowedPath(path) {
  return typeof path === "string" &&
    path.startsWith("/") &&
    ALLOWED_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}?`));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "cast-helper-request") {
    return false;
  }
  if (!isAllowedPath(message.path)) {
    sendResponse({ error: "Blocked helper path" });
    return false;
  }

  fetch(`${HELPER_URL}${message.path}`, {
    method: message.method || "GET",
    headers: {
      "Content-Type": "application/json",
      [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE,
    },
    body: message.body ? JSON.stringify(message.body) : undefined,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      sendResponse({ error: payload.error || `Request failed with ${response.status}` });
    } else {
      sendResponse(payload);
    }
  }).catch((error) => {
    sendResponse({ error: error.message || "Network request failed" });
  });

  return true; // Keep the message channel open for async sendResponse
});
