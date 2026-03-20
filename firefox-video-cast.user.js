// ==UserScript==
// @name         Firefox Floating Cast Button
// @namespace    https://local.nvx/firefox-cast-button
// @version      0.1.0
// @description  Adds a floating cast button over HTML5 videos and sends the video to a local cast helper.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const HELPER_URL = "http://127.0.0.1:49314";
  const STORAGE_KEY = "firefox-cast-button:last-device-id";
  const BUTTON_SIZE = 42;
  const CLIENT_HEADER_NAME = "X-Firefox-Cast-Client";
  const CLIENT_HEADER_VALUE = "firefox-extension";

  const state = {
    activeVideo: null,
    hoveredVideo: null,
    devices: [],
    pickerOpen: false,
  };

  const style = document.createElement("style");
  style.textContent = `
    #ff-cast-button {
      position: fixed;
      z-index: 2147483646;
      width: ${BUTTON_SIZE}px;
      height: ${BUTTON_SIZE}px;
      border: 0;
      border-radius: 999px;
      background: rgba(14, 22, 38, 0.88);
      color: #f7fbff;
      display: none;
      align-items: center;
      justify-content: center;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32);
      backdrop-filter: blur(12px);
      cursor: pointer;
      transition: transform 120ms ease, background 120ms ease, opacity 120ms ease;
      opacity: 0.95;
    }
    #ff-cast-button:hover {
      transform: scale(1.05);
      background: rgba(25, 45, 73, 0.96);
    }
    #ff-cast-button svg {
      width: 22px;
      height: 22px;
      pointer-events: none;
    }
    #ff-cast-picker {
      position: fixed;
      z-index: 2147483647;
      min-width: 240px;
      max-width: 320px;
      display: none;
      color: #f5f8fb;
      background: rgba(13, 19, 30, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(16px);
      padding: 12px;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    #ff-cast-picker h2 {
      margin: 0 0 10px;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .ff-cast-device,
    .ff-cast-action {
      width: 100%;
      border: 0;
      border-radius: 12px;
      text-align: left;
      background: rgba(255, 255, 255, 0.04);
      color: inherit;
      padding: 10px 12px;
      margin: 0 0 8px;
      cursor: pointer;
      transition: background 120ms ease;
    }
    .ff-cast-device:hover,
    .ff-cast-action:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .ff-cast-device small,
    .ff-cast-status small {
      display: block;
      color: rgba(245, 248, 251, 0.68);
      margin-top: 2px;
      font-size: 11px;
    }
    .ff-cast-device.is-default {
      outline: 1px solid rgba(127, 192, 255, 0.45);
      background: rgba(52, 117, 171, 0.18);
    }
    .ff-cast-status {
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.04);
      font-size: 13px;
      line-height: 1.35;
      margin-bottom: 8px;
    }
    #ff-cast-toast {
      position: fixed;
      z-index: 2147483647;
      left: 50%;
      bottom: 28px;
      transform: translateX(-50%);
      display: none;
      min-width: 220px;
      max-width: min(90vw, 560px);
      border-radius: 14px;
      background: rgba(15, 21, 33, 0.96);
      color: #f5f8fb;
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.35);
      padding: 12px 16px;
      font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
    }
    #ff-cast-toast[data-kind="error"] {
      background: rgba(87, 20, 20, 0.96);
    }
  `;
  document.documentElement.appendChild(style);

  const button = document.createElement("button");
  button.id = "ff-cast-button";
  button.type = "button";
  button.title = "Cast video";
  button.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M1.5 18.5a4 4 0 0 1 4 4h-4zm0-7a11 11 0 0 1 11 11h-3a8 8 0 0 0-8-8zm0-7a18 18 0 0 1 18 18h-3a15 15 0 0 0-15-15zm17 0h4v4h-4zm-8 0h6v6h-2v-4h-4z"/>
    </svg>
  `;
  document.documentElement.appendChild(button);

  const picker = document.createElement("div");
  picker.id = "ff-cast-picker";
  document.documentElement.appendChild(picker);

  const toast = document.createElement("div");
  toast.id = "ff-cast-toast";
  document.documentElement.appendChild(toast);

  function isVideoUsable(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return false;
    }
    const rect = video.getBoundingClientRect();
    return rect.width >= 160 && rect.height >= 90 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function findBestVideo() {
    if (state.hoveredVideo && isVideoUsable(state.hoveredVideo)) {
      return state.hoveredVideo;
    }

    let best = null;
    let bestScore = 0;
    const videos = document.querySelectorAll("video");
    for (const video of videos) {
      if (!isVideoUsable(video)) {
        continue;
      }
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      const playingBoost = !video.paused && !video.ended ? 1.4 : 1;
      const score = area * playingBoost;
      if (score > bestScore) {
        bestScore = score;
        best = video;
      }
    }
    return best;
  }

  function positionButton() {
    const video = findBestVideo();
    state.activeVideo = video;
    if (!video) {
      if (!state.pickerOpen) {
        button.style.display = "none";
      }
      return;
    }

    const rect = video.getBoundingClientRect();
    button.style.display = "flex";
    button.style.top = `${Math.max(12, rect.top + 14)}px`;
    button.style.left = `${Math.max(12, rect.right - BUTTON_SIZE - 14)}px`;

    if (state.pickerOpen) {
      positionPicker();
    }
  }

  function positionPicker() {
    const buttonRect = button.getBoundingClientRect();
    const left = Math.min(buttonRect.left, window.innerWidth - 340);
    const top = Math.min(buttonRect.bottom + 10, window.innerHeight - 20 - picker.offsetHeight);
    picker.style.left = `${Math.max(12, left)}px`;
    picker.style.top = `${Math.max(12, top)}px`;
  }

  function showToast(message, kind = "info") {
    toast.dataset.kind = kind;
    toast.textContent = message;
    toast.style.display = "block";
    window.clearTimeout(showToast.timerId);
    showToast.timerId = window.setTimeout(() => {
      toast.style.display = "none";
    }, 3600);
  }

  showToast.timerId = null;

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      const hasGM = typeof GM_xmlhttpRequest === "function";
      const url = `${HELPER_URL}${path}`;
      const headers = {
        "Content-Type": "application/json",
        [CLIENT_HEADER_NAME]: CLIENT_HEADER_VALUE,
      };

      if (hasGM) {
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data: body ? JSON.stringify(body) : undefined,
          onload(response) {
            try {
              const parsed = JSON.parse(response.responseText || "{}");
              if (response.status >= 200 && response.status < 300) {
                resolve(parsed);
              } else {
                reject(new Error(parsed.error || `Request failed with ${response.status}`));
              }
            } catch (error) {
              reject(error);
            }
          },
          onerror() {
            reject(new Error("Could not reach the local cast helper."));
          },
        });
        return;
      }

      fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })
        .then(async (response) => {
          const parsed = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(parsed.error || `Request failed with ${response.status}`);
          }
          resolve(parsed);
        })
        .catch(reject);
    });
  }

  function absoluteUrl(value) {
    if (!value) {
      return "";
    }
    try {
      return new URL(value, location.href).toString();
    } catch {
      return value;
    }
  }

  function detectSiteHint() {
    const host = location.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
      return "youtube";
    }
    return "";
  }

  function getVideoPayload(video) {
    const source = video.querySelector("source[src]");
    const poster = absoluteUrl(video.poster || document.querySelector('meta[property="og:image"]')?.content || "");
    const title = document.querySelector('meta[property="og:title"]')?.content || document.title || "Firefox video";
    const mediaUrl = absoluteUrl(video.currentSrc || video.src || source?.src || "");
    const contentType = source?.type || "";
    const siteHint = detectSiteHint();

    return {
      media_url: mediaUrl,
      content_type: contentType,
      title,
      tab_title: document.title || "",
      page_url: location.href,
      poster_url: poster,
      site_hint: siteHint,
    };
  }

  function hidePicker() {
    state.pickerOpen = false;
    picker.style.display = "none";
  }

  function rememberDefaultDevice(name) {
    localStorage.setItem(STORAGE_KEY, name);
  }

  function renderPicker(contentHtml) {
    picker.innerHTML = contentHtml;
    picker.style.display = "block";
    state.pickerOpen = true;
    positionPicker();
  }

  function renderDevices(devices) {
    const lastDeviceId = localStorage.getItem(STORAGE_KEY);
    const rows = devices
      .map((device) => {
        const isDefault = device.id === lastDeviceId;
        const subtitle = [device.model_name, device.manufacturer, device.protocol?.toUpperCase()]
          .filter(Boolean)
          .join(" • ");
        return `
          <button class="ff-cast-device ${isDefault ? "is-default" : ""}" type="button" data-device-id="${escapeHtml(device.id)}" data-device-name="${escapeHtml(device.name)}">
            ${escapeHtml(device.name)}
            <small>${escapeHtml(subtitle || "Video target")}</small>
          </button>
        `;
      })
      .join("");

    renderPicker(`
      <h2>Cast This Video</h2>
      ${rows || '<div class="ff-cast-status">No cast devices found.<small>Make sure the TV is on the same Wi-Fi and the local helper is running.</small></div>'}
      <button class="ff-cast-action" type="button" data-refresh="1">Refresh devices</button>
    `);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function openPicker() {
    if (!state.activeVideo) {
      showToast("No HTML5 video is currently active on this page.", "error");
      return;
    }

    const payload = getVideoPayload(state.activeVideo);
    if (!payload.media_url && payload.site_hint !== "youtube") {
      showToast("This page does not expose a direct media URL for casting.", "error");
      return;
    }

    if (payload.media_url.startsWith("blob:") && payload.site_hint !== "youtube") {
      showToast("This player uses a blob URL. Direct cast handoff will not work here.", "error");
      return;
    }

    renderPicker(`
      <h2>Cast This Video</h2>
      <div class="ff-cast-status">Looking for TVs…<small>The helper scans Cast devices on your local network.</small></div>
    `);

    try {
      const response = await request("GET", "/devices", null);
      state.devices = response.devices || [];
      renderDevices(state.devices);
    } catch (error) {
      renderPicker(`
        <h2>Cast This Video</h2>
        <div class="ff-cast-status">
          ${escapeHtml(error.message || "Failed to load devices.")}
          <small>Start <code>cast_helper.py</code> and keep the TV on the same network.</small>
        </div>
      `);
    }
  }

  async function sendToDevice(deviceId, deviceName) {
    if (!state.activeVideo) {
      showToast("No active video found.", "error");
      return;
    }

    const payload = getVideoPayload(state.activeVideo);
    payload.device_id = deviceId;
    payload.device_name = deviceName;

    renderPicker(`
      <h2>Cast This Video</h2>
      <div class="ff-cast-status">Sending to ${escapeHtml(deviceName)}…</div>
    `);

    try {
      const response = await request("POST", "/cast", payload);
      rememberDefaultDevice(deviceId);
      hidePicker();
      showToast(response.message || `Casting on ${deviceName}`);
    } catch (error) {
      showToast(error.message || `Could not cast to ${deviceName}`, "error");
      await openPicker();
    }
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (state.pickerOpen) {
      hidePicker();
      return;
    }
    openPicker();
  });

  picker.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("button") : null;
    if (!target) {
      return;
    }

    const deviceId = target.dataset.deviceId;
    const deviceName = target.dataset.deviceName;
    if (deviceId && deviceName) {
      sendToDevice(deviceId, deviceName);
      return;
    }

    if (target.dataset.refresh) {
      request("GET", "/devices?refresh=1", null)
        .then((response) => {
          state.devices = response.devices || [];
          renderDevices(state.devices);
        })
        .catch((error) => {
          showToast(error.message || "Refresh failed.", "error");
        });
    }
  });

  document.addEventListener("pointermove", (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    const video = path.find((node) => node instanceof HTMLVideoElement) || null;
    state.hoveredVideo = isVideoUsable(video) ? video : null;
    positionButton();
  }, { passive: true });

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Node)) {
      return;
    }
    if (state.pickerOpen && !picker.contains(event.target) && !button.contains(event.target)) {
      hidePicker();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.pickerOpen) {
      hidePicker();
    }
  });

  window.addEventListener("scroll", positionButton, { passive: true });
  window.addEventListener("resize", positionButton, { passive: true });
  window.setInterval(positionButton, 1000);
  positionButton();
})();
