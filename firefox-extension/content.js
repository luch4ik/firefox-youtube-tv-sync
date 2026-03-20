"use strict";

(() => {
  const STORAGE_DEVICE_ID_KEY = "firefox-cast-button:last-device-id";
  const STORAGE_DEVICE_NAME_KEY = "firefox-cast-button:last-device-name";
  const STORAGE_AUTO_FOLLOW_KEY = "firefox-cast-button:auto-follow";
  const BUTTON_SIZE = 42;
  const REMOTE_STATUS_POLL_MS = 1000;
  const REMOTE_PLAYER_POLL_MS = 250;
  const REMOTE_SYNC_GUARD_MS = 350;
  const REMOTE_COMMAND_SETTLE_MS = 1800;
  const LOCAL_PLAYER_GUARD_MS = 1400;
  const REMOTE_PLAYING_DRIFT_TOLERANCE_SECONDS = 0.12;
  const REMOTE_PAUSED_DRIFT_TOLERANCE_SECONDS = 0.03;

  const state = {
    activeVideo: null,
    hoveredVideo: null,
    pickerOpen: false,
    rafId: 0,
    buttonState: "idle",
    buttonStatusText: "",
    autoFollowEnabled: false,
    remoteStatus: null,
    remoteStatusReceivedAt: 0,
    remotePollTimerId: 0,
    remotePlayerPollTimerId: 0,
    remoteShadowVideo: null,
    remoteShadowRafId: 0,
    remoteSyncGuardUntil: 0,
    remoteCommandPendingUntil: 0,
    localPlayerGuardUntil: 0,
    youtubeSeekDragging: false,
    youtubeSeekBarElement: null,
    remotePlayAttemptAt: 0,
    remoteForcedMute: false,
    autoFollowVideoId: "",
    lastKnownPlayerVolume: null,
    lastKnownPlayerPlayback: null,
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
      transition: opacity 120ms ease;
    }
    #ff-cast-button[data-state="busy"] svg {
      opacity: 0.18;
    }
    #ff-cast-button[data-state="connected"] {
      background: rgba(19, 91, 54, 0.92);
      box-shadow: 0 12px 28px rgba(13, 69, 41, 0.36);
    }
    #ff-cast-button[data-state="error"] {
      background: rgba(101, 26, 26, 0.92);
    }
    #ff-cast-button[data-state="connected"]::after {
      content: "";
      position: absolute;
      right: 7px;
      bottom: 7px;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #6dffaf;
      box-shadow: 0 0 0 3px rgba(16, 30, 24, 0.72);
    }
    .ff-cast-spinner {
      position: absolute;
      inset: 10px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.18);
      border-top-color: rgba(255, 255, 255, 0.94);
      animation: ff-cast-spin 0.9s linear infinite;
      display: none;
      pointer-events: none;
    }
    #ff-cast-button[data-state="busy"] .ff-cast-spinner {
      display: block;
    }
    #ff-cast-status-badge {
      position: fixed;
      z-index: 2147483646;
      display: none;
      max-width: min(46vw, 240px);
      padding: 8px 10px;
      border-radius: 999px;
      background: rgba(13, 19, 30, 0.94);
      color: #f5f8fb;
      font: 12px/1.2 ui-sans-serif, system-ui, sans-serif;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(14px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    #ff-cast-status-badge[data-state="busy"] {
      background: rgba(34, 49, 78, 0.94);
    }
    #ff-cast-status-badge[data-state="connected"] {
      background: rgba(19, 91, 54, 0.94);
    }
    #ff-cast-status-badge[data-state="error"] {
      background: rgba(101, 26, 26, 0.94);
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
    .ff-cast-status[data-kind="connected"] {
      background: rgba(38, 94, 62, 0.24);
      border: 1px solid rgba(109, 255, 175, 0.16);
    }
    .ff-cast-status strong {
      display: block;
      margin-bottom: 2px;
      font-size: 13px;
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
    @keyframes ff-cast-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.documentElement.appendChild(style);

  const button = document.createElement("button");
  button.id = "ff-cast-button";
  button.type = "button";
  button.title = "Cast video";
  const buttonIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  buttonIcon.setAttribute("viewBox", "0 0 24 24");
  buttonIcon.setAttribute("aria-hidden", "true");
  const buttonIconPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  buttonIconPath.setAttribute("fill", "currentColor");
  buttonIconPath.setAttribute("d", "M1.5 18.5a4 4 0 0 1 4 4h-4zm0-7a11 11 0 0 1 11 11h-3a8 8 0 0 0-8-8zm0-7a18 18 0 0 1 18 18h-3a15 15 0 0 0-15-15zm17 0h4v4h-4zm-8 0h6v6h-2v-4h-4z");
  buttonIcon.appendChild(buttonIconPath);
  const buttonSpinner = document.createElement("span");
  buttonSpinner.className = "ff-cast-spinner";
  buttonSpinner.setAttribute("aria-hidden", "true");
  button.append(buttonIcon, buttonSpinner);
  document.documentElement.appendChild(button);

  const picker = document.createElement("div");
  picker.id = "ff-cast-picker";
  document.documentElement.appendChild(picker);

  const statusBadge = document.createElement("div");
  statusBadge.id = "ff-cast-status-badge";
  document.documentElement.appendChild(statusBadge);

  const toast = document.createElement("div");
  toast.id = "ff-cast-toast";
  document.documentElement.appendChild(toast);

  function showToast(message, kind = "info") {
    toast.dataset.kind = kind;
    toast.textContent = message;
    toast.style.display = "block";
    clearTimeout(showToast.timerId);
    showToast.timerId = window.setTimeout(() => {
      toast.style.display = "none";
    }, 3600);
  }

  showToast.timerId = null;

  function helperRequest(method, path, body) {
    return browser.runtime.sendMessage({
      type: "cast-helper-request",
      method,
      path,
      body,
    });
  }

  function setButtonState(mode, statusText = "") {
    state.buttonState = mode;
    state.buttonStatusText = statusText;
    button.dataset.state = mode;
    statusBadge.dataset.state = mode;
    statusBadge.textContent = statusText;
    statusBadge.style.display = statusText ? "block" : "none";
    if (statusText && button.style.display !== "none") {
      positionStatusBadge();
    }
    const suffix = statusText ? `: ${statusText}` : "";
    if (mode === "connected") {
      button.title = `Connected${suffix}`;
    } else if (mode === "busy") {
      button.title = `Working${suffix}`;
    } else if (mode === "error") {
      button.title = `Cast error${suffix}`;
    } else {
      button.title = `Cast video${suffix}`;
    }
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function waitForYoutubeRemoteReady(expectedVideoId, attempts = 8, delayMs = 350) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await refreshRemoteStatus();
      if (
        status?.connected &&
        (!expectedVideoId || status.video_id === expectedVideoId)
      ) {
        return status;
      }
      if (attempt + 1 < attempts) {
        await delay(delayMs);
      }
    }
    return state.remoteStatus;
  }

  function isVideoUsable(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return false;
    }
    const rect = video.getBoundingClientRect();
    return rect.width >= 160 && rect.height >= 90 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  function findBestVideo() {
    if (state.hoveredVideo && isVideoUsable(state.hoveredVideo)) {
      return state.hoveredVideo;
    }

    let best = null;
    let bestScore = 0;
    for (const video of document.querySelectorAll("video")) {
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

  function getPlayerAnchorElement() {
    return document.querySelector("#movie_player, ytd-player, #player, #player-container, #full-bleed-container");
  }

  function getPlayerAnchorRect() {
    const element = getPlayerAnchorElement();
    if (!(element instanceof Element)) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 90 || rect.bottom <= 0 || rect.right <= 0) {
      return null;
    }
    if (rect.top >= window.innerHeight || rect.left >= window.innerWidth) {
      return null;
    }
    return rect;
  }

  function positionPicker() {
    const buttonRect = button.getBoundingClientRect();
    const left = Math.min(buttonRect.left, window.innerWidth - 340);
    const top = Math.min(buttonRect.bottom + 10, window.innerHeight - 20 - picker.offsetHeight);
    picker.style.left = `${Math.max(12, left)}px`;
    picker.style.top = `${Math.max(12, top)}px`;
  }

  function positionStatusBadge() {
    if (statusBadge.style.display === "none") {
      return;
    }
    const buttonRect = button.getBoundingClientRect();
    const desiredLeft = buttonRect.left - Math.min(220, statusBadge.offsetWidth + 12);
    statusBadge.style.left = `${Math.max(12, desiredLeft)}px`;
    statusBadge.style.top = `${Math.max(12, buttonRect.top + 4)}px`;
  }

  function positionButton() {
    state.rafId = 0;
    if (!isSupportedYoutubePage()) {
      state.activeVideo = null;
      ensureRemotePolling();
      if (!state.pickerOpen) {
        button.style.display = "none";
      }
      statusBadge.style.display = "none";
      return;
    }
    const video = findBestVideo();
    state.activeVideo = video;
    const rect = video ? video.getBoundingClientRect() : getPlayerAnchorRect();
    if (!rect) {
      if (!state.pickerOpen) {
        button.style.display = "none";
      }
      statusBadge.style.display = "none";
      return;
    }

    if (video) {
      attachRemoteVideo(video);
      applyRemoteTakeover();
    }
    button.style.display = "flex";
    button.style.top = `${Math.max(12, rect.top + 14)}px`;
    button.style.left = `${Math.max(12, rect.right - BUTTON_SIZE - 14)}px`;
    positionStatusBadge();
    if (state.pickerOpen) {
      positionPicker();
    }
  }

  function schedulePosition() {
    if (state.rafId) {
      return;
    }
    state.rafId = window.requestAnimationFrame(positionButton);
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

  function getPageVideoId() {
    const host = location.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      return location.pathname.replace(/^\/+/, "").split("/")[0] || "";
    }
    if (host !== "youtube.com" && host !== "m.youtube.com") {
      return "";
    }
    if (location.pathname === "/watch") {
      return new URLSearchParams(location.search).get("v") || "";
    }
    if (location.pathname.startsWith("/shorts/")) {
      return location.pathname.split("/")[2] || "";
    }
    return "";
  }

  function getYoutubePlayer() {
    const player = document.getElementById("movie_player");
    return player && typeof player.getCurrentTime === "function" ? player : null;
  }

  function findSeekBarElement(startNode) {
    if (!(startNode instanceof Element)) {
      return null;
    }
    return startNode.closest(".ytp-progress-bar, .ytp-progress-list");
  }

  function getSeekTimeFromProgressBar(event) {
    const seekBar = state.youtubeSeekBarElement || findSeekBarElement(event?.target);
    const player = getYoutubePlayer();
    const duration = Number(player && typeof player.getDuration === "function" ? player.getDuration() : state.remoteStatus?.duration);
    if (!(seekBar instanceof Element) || !(event instanceof PointerEvent) || !Number.isFinite(duration) || duration <= 0) {
      return null;
    }

    const rect = seekBar.getBoundingClientRect();
    if (rect.width <= 0) {
      return null;
    }

    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return ratio * duration;
  }

  function applyLocalSeek(targetTime) {
    if (!Number.isFinite(targetTime)) {
      return;
    }

    beginLocalPlayerGuard();
    const player = getYoutubePlayer();
    if (player && typeof player.seekTo === "function") {
      try {
        player.seekTo(targetTime, true);
      } catch {
        // Fall back to the raw video element below.
      }
    }

    if (state.activeVideo instanceof HTMLVideoElement) {
      try {
        state.activeVideo.currentTime = targetTime;
      } catch {
        // Ignore element-level seek failures from transient YouTube states.
      }
    }
  }

  function getYoutubePlayerVolume() {
    const player = getYoutubePlayer();
    if (!player || typeof player.getVolume !== "function") {
      return null;
    }

    const volume = Number(player.getVolume());
    const muted = typeof player.isMuted === "function" ? Boolean(player.isMuted()) : false;
    if (!Number.isFinite(volume)) {
      return null;
    }
    return muted ? 0 : Math.max(0, Math.min(100, Math.round(volume)));
  }

  function getYoutubePlayerPlaybackState() {
    const player = getYoutubePlayer();
    if (!player || typeof player.getPlayerState !== "function") {
      return null;
    }

    const playbackState = Number(player.getPlayerState());
    if (playbackState === 1) {
      return "playing";
    }
    if (playbackState === 2) {
      return "paused";
    }
    return null;
  }

  function ensureRemotePlayerPolling() {
    if (!isRemoteActiveForPage()) {
      if (state.remotePlayerPollTimerId) {
        clearInterval(state.remotePlayerPollTimerId);
        state.remotePlayerPollTimerId = 0;
      }
      state.lastKnownPlayerVolume = null;
      state.lastKnownPlayerPlayback = null;
      return;
    }

    if (state.remotePlayerPollTimerId) {
      return;
    }

    state.lastKnownPlayerVolume = getYoutubePlayerVolume();
    state.lastKnownPlayerPlayback = getYoutubePlayerPlaybackState();
    state.remotePlayerPollTimerId = window.setInterval(() => {
      syncRemotePlaybackAndVolumeFromYoutubePlayer();
    }, REMOTE_PLAYER_POLL_MS);
  }

  function setRemoteStatus(status) {
    state.remoteStatus = status || null;
    state.remoteStatusReceivedAt = performance.now();
    syncVisibleStateFromRemoteStatus();
  }

  function getDesiredRemoteTime() {
    const status = state.remoteStatus;
    if (!status) {
      return null;
    }

    let currentTime = Number(status.estimated_current_time ?? status.current_time);
    if (!Number.isFinite(currentTime)) {
      return null;
    }

    if (status.playback_state === "playing") {
      currentTime += Math.max(0, performance.now() - state.remoteStatusReceivedAt) / 1000;
    }

    const duration = Number(status.duration);
    if (Number.isFinite(duration) && duration >= 0) {
      currentTime = Math.min(duration, currentTime);
    }

    return Math.max(0, currentTime);
  }

  function appendChildValue(parent, value) {
    if (value === null || value === undefined || value === false) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        appendChildValue(parent, item);
      }
      return;
    }
    if (value instanceof Node) {
      parent.appendChild(value);
      return;
    }
    parent.appendChild(document.createTextNode(String(value)));
  }

  function createNode(tagName, options = {}, children = []) {
    const element = document.createElement(tagName);
    if (options.className) {
      element.className = options.className;
    }
    if (options.type) {
      element.setAttribute("type", options.type);
    }
    if (options.text !== undefined) {
      element.textContent = String(options.text);
    }
    if (options.dataset) {
      Object.entries(options.dataset).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          element.dataset[key] = String(value);
        }
      });
    }
    if (options.attributes) {
      Object.entries(options.attributes).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
          element.setAttribute(key, String(value));
        }
      });
    }
    appendChildValue(element, children);
    return element;
  }

  function createPickerTitle() {
    return createNode("h2", { text: "Cast This Video" });
  }

  function createStatusCard(title, body, detail, kind = "") {
    return createNode("div", {
      className: "ff-cast-status",
      dataset: kind ? { kind } : undefined,
    }, [
      createNode("strong", { text: title }),
      body || "",
      detail ? createNode("small", { text: detail }) : null,
    ]);
  }

  function createActionButton(label, dataset) {
    return createNode("button", {
      className: "ff-cast-action",
      type: "button",
      dataset,
      text: label,
    });
  }

  function createDeviceButton(device, isDefault = false, subtitle = "") {
    return createNode("button", {
      className: `ff-cast-device${isDefault ? " is-default" : ""}`,
      type: "button",
      dataset: {
        deviceId: device.id,
        deviceName: device.name,
      },
    }, [
      device.name,
      subtitle ? createNode("small", { text: subtitle }) : null,
    ]);
  }

  function getRemoteSummaryNode() {
    if (!state.remoteStatus?.connected) {
      return null;
    }

    const playbackState = String(state.remoteStatus.playback_state || "connected");
    const label = playbackState.charAt(0).toUpperCase() + playbackState.slice(1);
    const currentTime = getDesiredRemoteTime();
    const duration = Number(state.remoteStatus.duration);
    const timeLabel = Number.isFinite(currentTime)
      ? `${formatTime(currentTime)} / ${formatTime(duration)}`
      : "Waiting for playback time";

    return createStatusCard(
      state.remoteStatus.device_name || "Connected TV",
      label,
      timeLabel,
      "connected"
    );
  }

  function getAutoFollowActionNode() {
    return createActionButton(getAutoFollowLabel(), { toggleAutoFollow: "1" });
  }

  function getDisconnectActionNode() {
    if (!state.remoteStatus?.connected) {
      return null;
    }
    return createActionButton("Disconnect TV", { disconnectRemote: "1" });
  }

  function syncVisibleStateFromRemoteStatus() {
    if (state.youtubeSeekDragging) {
      setButtonState("busy", "Seeking on TV...");
      return;
    }
    if (isRemoteCommandPending()) {
      if (state.buttonState !== "error") {
        setButtonState("busy", state.buttonStatusText || "Updating TV...");
      }
      return;
    }
    if (state.remoteStatus?.connected && isRemoteActiveForPage()) {
      const currentTime = getDesiredRemoteTime();
      const deviceName = state.remoteStatus.device_name || "TV";
      const summary = Number.isFinite(currentTime)
        ? `${deviceName} ${formatTime(currentTime)}`
        : `${deviceName} connected`;
      setButtonState("connected", summary);
      return;
    }
    if (state.buttonState !== "error") {
      setButtonState("idle", "");
    }
  }

  function isRemoteActiveForPage() {
    return Boolean(
      state.remoteStatus?.connected &&
      state.remoteStatus?.video_id &&
      state.remoteStatus.video_id === getPageVideoId()
    );
  }

  function beginRemoteSyncGuard() {
    state.remoteSyncGuardUntil = performance.now() + REMOTE_SYNC_GUARD_MS;
  }

  function isWithinRemoteSyncGuard() {
    return performance.now() < state.remoteSyncGuardUntil;
  }

  function beginLocalPlayerGuard(durationMs = LOCAL_PLAYER_GUARD_MS) {
    state.localPlayerGuardUntil = performance.now() + durationMs;
  }

  function isWithinLocalPlayerGuard() {
    return performance.now() < state.localPlayerGuardUntil;
  }

  function markRemoteCommandPending() {
    state.remoteCommandPendingUntil = performance.now() + REMOTE_COMMAND_SETTLE_MS;
  }

  function isRemoteCommandPending() {
    return performance.now() < state.remoteCommandPendingUntil;
  }

  function applyOptimisticRemoteStatus(command, extras = {}) {
    if (!state.remoteStatus) {
      return;
    }

    if (command === "play") {
      state.remoteStatus.playback_state = "playing";
      state.remoteStatus.updated_at = Date.now() / 1000;
    } else if (command === "pause") {
      state.remoteStatus.playback_state = "paused";
      state.remoteStatus.updated_at = Date.now() / 1000;
    } else if (command === "seek" && Number.isFinite(extras.current_time)) {
      state.remoteStatus.current_time = Number(extras.current_time);
      state.remoteStatus.updated_at = Date.now() / 1000;
    } else if (command === "play_video" && extras.video_id) {
      state.remoteStatus.video_id = String(extras.video_id);
      state.remoteStatus.current_time = 0;
      state.remoteStatus.playback_state = "playing";
      state.remoteStatus.updated_at = Date.now() / 1000;
    }
    state.remoteStatusReceivedAt = performance.now();
    syncVisibleStateFromRemoteStatus();
  }

  function detachRemoteVideo() {
    const video = state.remoteShadowVideo;
    if (!video) {
      return;
    }

    video.removeEventListener("play", onShadowVideoPlay);
    video.removeEventListener("pause", onShadowVideoPause);
    video.removeEventListener("seeked", onShadowVideoSeeked);
    if (state.remoteForcedMute && video.isConnected) {
      video.muted = false;
    }
    state.remoteForcedMute = false;
    state.remoteShadowVideo = null;
  }

  function attachRemoteVideo(video) {
    if (state.remoteShadowVideo === video) {
      return;
    }

    detachRemoteVideo();
    if (!video) {
      return;
    }

    state.remoteShadowVideo = video;
    video.addEventListener("play", onShadowVideoPlay);
    video.addEventListener("pause", onShadowVideoPause);
    video.addEventListener("seeked", onShadowVideoSeeked);
  }

  async function sendRemoteCommand(command, extras = {}) {
    markRemoteCommandPending();
    applyOptimisticRemoteStatus(command, extras);
    applyRemoteTakeover();
    const response = await helperRequest("POST", "/youtube-remote/command", {
      command,
      ...extras,
    });
    setRemoteStatus(response.status || null);
    applyRemoteTakeover();
    return response;
  }

  async function maybeAutoFollowVideo() {
    const pageVideoId = getPageVideoId();
    if (!state.autoFollowEnabled || !pageVideoId || !state.remoteStatus?.connected) {
      return;
    }
    if (state.remoteStatus.video_id === pageVideoId || state.autoFollowVideoId === pageVideoId) {
      return;
    }

    state.autoFollowVideoId = pageVideoId;
    setButtonState("busy", "Following this video on TV...");
    try {
      await sendRemoteCommand("play_video", { video_id: pageVideoId });
      state.autoFollowVideoId = "";
    } catch (error) {
      state.autoFollowVideoId = "";
      setButtonState("error", "Auto-follow failed");
      showToast(error.message || "Could not follow this video on TV.", "error");
    }
  }

  async function disconnectRemoteSession() {
    if (!state.remoteStatus?.connected) {
      return;
    }

    setButtonState("busy", "Disconnecting TV...");
    renderPicker([
      createPickerTitle(),
      createStatusCard("Disconnecting", "Stopping playback control on the TV…"),
    ]);

    try {
      await sendRemoteCommand("stop");
      state.autoFollowVideoId = "";
      renderPicker([
        createPickerTitle(),
        createStatusCard("Disconnected", "The TV session has been closed."),
      ]);
      await delay(700);
      hidePicker();
      setButtonState("idle", "");
    } catch (error) {
      setButtonState("error", "Disconnect failed");
      renderPicker([
        createPickerTitle(),
        createStatusCard("Disconnect failed", error.message || "Could not disconnect the TV session."),
        getDisconnectActionNode(),
      ]);
    }
  }

  async function refreshRemoteStatus() {
    if (!isSupportedYoutubePage()) {
      setRemoteStatus(null);
      applyRemoteTakeover();
      return null;
    }

    try {
      const response = await helperRequest("GET", "/youtube-remote/status", null);
      setRemoteStatus(response.status || null);
      applyRemoteTakeover();
      void maybeAutoFollowVideo();
      return response.status || null;
    } catch {
      setRemoteStatus(null);
      applyRemoteTakeover();
      return null;
    }
  }

  function stopRemoteTakeoverLoop() {
    if (state.remoteShadowRafId) {
      cancelAnimationFrame(state.remoteShadowRafId);
      state.remoteShadowRafId = 0;
    }
  }

  function scheduleRemoteTakeoverLoop() {
    if (state.remoteShadowRafId) {
      return;
    }
    state.remoteShadowRafId = requestAnimationFrame(runRemoteTakeoverLoop);
  }

  function runRemoteTakeoverLoop() {
    state.remoteShadowRafId = 0;
    const video = state.remoteShadowVideo;
    if (!video || !isRemoteActiveForPage()) {
      stopRemoteTakeoverLoop();
      return;
    }

    const desiredTime = getDesiredRemoteTime();
    const playbackState = state.remoteStatus?.playback_state || "disconnected";
    const drift = Number.isFinite(desiredTime) ? Math.abs(video.currentTime - desiredTime) : 0;

    if (video.playbackRate !== 1) {
      beginRemoteSyncGuard();
      video.playbackRate = 1;
      video.defaultPlaybackRate = 1;
    }

    if (!video.muted) {
      beginRemoteSyncGuard();
      video.muted = true;
      state.remoteForcedMute = true;
    }

    if (state.youtubeSeekDragging || isRemoteCommandPending()) {
      scheduleRemoteTakeoverLoop();
      return;
    }

    if (playbackState === "playing") {
      if (Number.isFinite(desiredTime) && drift > REMOTE_PLAYING_DRIFT_TOLERANCE_SECONDS) {
        beginRemoteSyncGuard();
        applyLocalSeek(desiredTime);
      }
      if (video.paused && (performance.now() - state.remotePlayAttemptAt) > 1000) {
        state.remotePlayAttemptAt = performance.now();
        beginRemoteSyncGuard();
        beginLocalPlayerGuard();
        void video.play().catch(() => {});
      }
    } else {
      if (!video.paused) {
        beginRemoteSyncGuard();
        beginLocalPlayerGuard();
        video.pause();
      }
      if (Number.isFinite(desiredTime) && drift > REMOTE_PAUSED_DRIFT_TOLERANCE_SECONDS) {
        beginRemoteSyncGuard();
        applyLocalSeek(desiredTime);
      }
    }

    scheduleRemoteTakeoverLoop();
  }

  function applyRemoteTakeover() {
    const video = state.activeVideo || findBestVideo();
    if (!isRemoteActiveForPage() || !isVideoUsable(video)) {
      stopRemoteTakeoverLoop();
      detachRemoteVideo();
      ensureRemotePlayerPolling();
      syncVisibleStateFromRemoteStatus();
      return;
    }

    state.activeVideo = video;
    attachRemoteVideo(video);
    scheduleRemoteTakeoverLoop();
    ensureRemotePlayerPolling();
    syncVisibleStateFromRemoteStatus();
  }

  function ensureRemotePolling() {
    if (!isSupportedYoutubePage()) {
      if (state.remotePollTimerId) {
        clearInterval(state.remotePollTimerId);
        state.remotePollTimerId = 0;
      }
      setRemoteStatus(null);
      applyRemoteTakeover();
      ensureRemotePlayerPolling();
      return;
    }

    if (state.remotePollTimerId) {
      return;
    }

    state.remotePollTimerId = window.setInterval(() => {
      refreshRemoteStatus();
    }, REMOTE_STATUS_POLL_MS);
    refreshRemoteStatus();
  }

  function isSupportedYoutubePage() {
    const host = location.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      return Boolean(location.pathname.replace(/^\/+/, ""));
    }
    if (host !== "youtube.com" && host !== "m.youtube.com") {
      return false;
    }
    return location.pathname === "/watch" || location.pathname.startsWith("/shorts/");
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

  async function getStoredDevice() {
    const stored = await browser.storage.local.get([STORAGE_DEVICE_ID_KEY, STORAGE_DEVICE_NAME_KEY]);
    const deviceId = stored[STORAGE_DEVICE_ID_KEY];
    const deviceName = stored[STORAGE_DEVICE_NAME_KEY];
    if (!deviceId || !deviceName) {
      return null;
    }
    return { id: deviceId, name: deviceName };
  }

  async function loadAutoFollowSetting() {
    const stored = await browser.storage.local.get(STORAGE_AUTO_FOLLOW_KEY);
    state.autoFollowEnabled = Boolean(stored[STORAGE_AUTO_FOLLOW_KEY]);
    return state.autoFollowEnabled;
  }

  async function setAutoFollowEnabled(enabled) {
    state.autoFollowEnabled = Boolean(enabled);
    await browser.storage.local.set({
      [STORAGE_AUTO_FOLLOW_KEY]: state.autoFollowEnabled,
    });
  }

  function getAutoFollowLabel() {
    return `Auto-follow next videos: ${state.autoFollowEnabled ? "On" : "Off"}`;
  }

  async function rememberDefaultDevice(deviceId, deviceName) {
    await browser.storage.local.set({
      [STORAGE_DEVICE_ID_KEY]: deviceId,
      [STORAGE_DEVICE_NAME_KEY]: deviceName,
    });
  }

  function renderPicker(children) {
    picker.replaceChildren();
    appendChildValue(picker, children);
    picker.style.display = "block";
    state.pickerOpen = true;
    positionPicker();
  }

  async function renderDevices(devices) {
    const storedDevice = await getStoredDevice();
    const lastDeviceId = storedDevice?.id;
    const rows = devices.map((device) => {
      const isDefault = device.id === lastDeviceId;
      const subtitle = [device.model_name, device.manufacturer, device.protocol?.toUpperCase()]
        .filter(Boolean)
        .join(" • ");
      return createDeviceButton(device, isDefault, subtitle || "Video target");
    });

    renderPicker([
      createPickerTitle(),
      rows.length
        ? rows
        : createStatusCard("No cast devices found.", "", "Make sure the TV is on the same Wi-Fi and the local helper is running."),
      getDisconnectActionNode(),
      getAutoFollowActionNode(),
      createActionButton("Refresh devices", { refresh: "1" }),
    ]);
  }

  async function fetchAndRenderDevices() {
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

    setButtonState("busy", "Looking for TVs...");
    renderPicker([
      createPickerTitle(),
      createStatusCard("Looking for TVs…", "", "The helper scans Cast devices on your local network."),
    ]);

    try {
      const response = await helperRequest("GET", "/devices", null);
      await renderDevices(response.devices || []);
      syncVisibleStateFromRemoteStatus();
    } catch (error) {
      setButtonState("error", "TV scan failed");
      renderPicker([
        createPickerTitle(),
        createStatusCard(
          "Device scan failed",
          error.message || "Failed to load devices.",
          "Start cast_helper.py and keep the TV on the same network."
        ),
      ]);
    }
  }

  async function openPicker() {
    if (!state.activeVideo) {
      showToast("No HTML5 video is currently active on this page.", "error");
      return;
    }

    await loadAutoFollowSetting();

    const storedDevice = await getStoredDevice();
    if (!storedDevice) {
      await fetchAndRenderDevices();
      return;
    }

    syncVisibleStateFromRemoteStatus();

    renderPicker([
      createPickerTitle(),
      getRemoteSummaryNode(),
      createDeviceButton(storedDevice, true, "Last used TV"),
      getDisconnectActionNode(),
      getAutoFollowActionNode(),
      createActionButton("Choose another TV", { openScan: "1" }),
    ]);
  }

  async function sendToDevice(deviceId, deviceName) {
    if (!state.activeVideo) {
      showToast("No active video found.", "error");
      return;
    }

    const payload = getVideoPayload(state.activeVideo);
    payload.device_id = deviceId;
    payload.device_name = deviceName;
    const expectedVideoId = getPageVideoId();

    setButtonState("busy", `Starting ${deviceName}...`);
    renderPicker([
      createPickerTitle(),
      createStatusCard("Starting TV", `Sending to ${deviceName}…`, "Opening the receiver on the TV."),
    ]);

    try {
      const response = await helperRequest("POST", "/cast", payload);
      await rememberDefaultDevice(deviceId, deviceName);
      if (response.mode === "youtube") {
        setButtonState("busy", `Waiting for ${deviceName}...`);
        renderPicker([
          createPickerTitle(),
          createStatusCard(
            "Waiting for playback",
            `${deviceName} is opening YouTube…`,
            "Finishing the TV handshake before we mark it connected."
          ),
        ]);
        await waitForYoutubeRemoteReady(expectedVideoId);
      } else {
        setButtonState("connected", `${deviceName} connected`);
      }
      renderPicker([
        createPickerTitle(),
        createStatusCard(
          "Connected",
          `Playing on ${deviceName}`,
          response.message || "Cast started successfully.",
          "connected"
        ),
      ]);
      await delay(900);
      showToast(response.message || `Casting on ${deviceName}`);
      hidePicker();
    } catch (error) {
      setButtonState("error", `Could not connect to ${deviceName}`);
      renderPicker([
        createPickerTitle(),
        createStatusCard(
          "Connection failed",
          error.message || `Could not cast to ${deviceName}`,
          "Check that the helper is running and the TV is reachable, then try again."
        ),
        getAutoFollowActionNode(),
        createActionButton("Choose another TV", { openScan: "1" }),
      ]);
      showToast(error.message || `Could not cast to ${deviceName}`, "error");
    }
  }

  function onShadowVideoPlay() {
    if (!isRemoteActiveForPage() || isWithinRemoteSyncGuard() || isWithinLocalPlayerGuard() || state.youtubeSeekDragging) {
      return;
    }
    setButtonState("busy", "Resuming on TV...");
    sendRemoteCommand("play").catch((error) => {
      setButtonState("error", "Resume failed");
      showToast(error.message || "Could not resume on TV.", "error");
    });
  }

  function onShadowVideoPause() {
    if (!isRemoteActiveForPage() || isWithinRemoteSyncGuard() || isWithinLocalPlayerGuard() || state.youtubeSeekDragging) {
      return;
    }
    setButtonState("busy", "Pausing on TV...");
    sendRemoteCommand("pause").catch((error) => {
      setButtonState("error", "Pause failed");
      showToast(error.message || "Could not pause on TV.", "error");
    });
  }

  function onShadowVideoSeeked(event) {
    const video = event.currentTarget;
    if (
      !(video instanceof HTMLVideoElement) ||
      !isRemoteActiveForPage() ||
      isWithinRemoteSyncGuard() ||
      isWithinLocalPlayerGuard() ||
      state.youtubeSeekDragging
    ) {
      return;
    }
    setButtonState("busy", "Seeking on TV...");
    sendRemoteCommand("seek", { current_time: video.currentTime }).catch((error) => {
      setButtonState("error", "Seek failed");
      showToast(error.message || "Could not seek on TV.", "error");
    });
  }

  function syncRemotePlaybackAndVolumeFromYoutubePlayer() {
    if (!isRemoteActiveForPage()) {
      return;
    }

    const playback = getYoutubePlayerPlaybackState();
    if (playback) {
      const previousPlayback = state.lastKnownPlayerPlayback;
      state.lastKnownPlayerPlayback = playback;
      if (
        previousPlayback &&
        previousPlayback !== playback &&
        !isWithinRemoteSyncGuard() &&
        !isWithinLocalPlayerGuard() &&
        !state.youtubeSeekDragging &&
        !isRemoteCommandPending()
      ) {
        if (playback === "paused" && state.remoteStatus?.playback_state !== "paused") {
          setButtonState("busy", "Pausing on TV...");
          sendRemoteCommand("pause").catch((error) => {
            setButtonState("error", "Pause failed");
            showToast(error.message || "Could not pause on TV.", "error");
          });
        } else if (playback === "playing" && state.remoteStatus?.playback_state !== "playing") {
          setButtonState("busy", "Resuming on TV...");
          sendRemoteCommand("play").catch((error) => {
            setButtonState("error", "Resume failed");
            showToast(error.message || "Could not resume on TV.", "error");
          });
        }
      }
    }

    const volume = getYoutubePlayerVolume();
    if (!Number.isFinite(volume)) {
      return;
    }
    const previousVolume = state.lastKnownPlayerVolume;
    if (previousVolume === null || previousVolume === volume) {
      state.lastKnownPlayerVolume = volume;
      return;
    }
    state.lastKnownPlayerVolume = volume;
    setButtonState("busy", "Adjusting TV volume...");
    sendRemoteCommand("set_volume", { volume }).catch((error) => {
      setButtonState("error", "Volume failed");
      showToast(error.message || "Could not change TV volume.", "error");
    });
  }

  function beginYoutubeSeekDrag(target) {
    if (!isRemoteActiveForPage()) {
      return;
    }
    state.youtubeSeekDragging = true;
    state.youtubeSeekBarElement = findSeekBarElement(target);
    state.remoteCommandPendingUntil = performance.now() + 5000;
    setButtonState("busy", "Seeking on TV...");
  }

  async function commitYoutubeSeekDrag(event) {
    if (!state.youtubeSeekDragging) {
      return;
    }
    beginLocalPlayerGuard();
    const pointerSeekTime = getSeekTimeFromProgressBar(event);
    if (!Number.isFinite(pointerSeekTime)) {
      await delay(120);
    }
    const player = getYoutubePlayer();
    const fallbackVideo = state.activeVideo;
    const currentTime = Number.isFinite(pointerSeekTime)
      ? Number(pointerSeekTime)
      : player && typeof player.getCurrentTime === "function"
        ? Number(player.getCurrentTime())
        : Number(fallbackVideo?.currentTime);

    state.youtubeSeekDragging = false;
    state.youtubeSeekBarElement = null;
    if (!isRemoteActiveForPage() || !Number.isFinite(currentTime)) {
      return;
    }

    beginRemoteSyncGuard();
    applyLocalSeek(currentTime);
    sendRemoteCommand("seek", { current_time: currentTime }).catch((error) => {
      setButtonState("error", "Seek failed");
      showToast(error.message || "Could not seek on TV.", "error");
    });
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

    if (target.dataset.disconnectRemote) {
      disconnectRemoteSession();
      return;
    }

    if (target.dataset.toggleAutoFollow) {
      setAutoFollowEnabled(!state.autoFollowEnabled)
        .then(() => openPicker())
        .catch((error) => {
          showToast(error.message || "Could not update auto-follow.", "error");
        });
      return;
    }

    if (target.dataset.openScan) {
      fetchAndRenderDevices();
      return;
    }

    if (target.dataset.refresh) {
      helperRequest("GET", "/devices?refresh=1", null)
        .then((response) => renderDevices(response.devices || []))
        .catch((error) => {
          showToast(error.message || "Refresh failed.", "error");
        });
    }
  });

  document.addEventListener("pointermove", (event) => {
    const path = event.composedPath ? event.composedPath() : [];
    const video = path.find((node) => node instanceof HTMLVideoElement) || null;
    state.hoveredVideo = isVideoUsable(video) ? video : null;
    schedulePosition();
  }, { passive: true });

  document.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? findSeekBarElement(event.target) : null;
    if (target) {
      beginYoutubeSeekDrag(target);
    }
  }, { passive: true });

  document.addEventListener("pointerup", (event) => {
    void commitYoutubeSeekDrag(event);
  }, { passive: true });

  document.addEventListener("pointercancel", () => {
    state.youtubeSeekDragging = false;
    state.youtubeSeekBarElement = null;
  }, { passive: true });

  document.addEventListener("keyup", (event) => {
    if (!isRemoteActiveForPage()) {
      return;
    }
    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End" || event.key === "j" || event.key === "l") {
      void commitYoutubeSeekDrag(event);
    }
  });

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

  const observer = new MutationObserver(() => {
    schedulePosition();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "style", "class", "poster"],
  });

  window.addEventListener("scroll", schedulePosition, { passive: true });
  window.addEventListener("resize", schedulePosition, { passive: true });
  document.addEventListener("fullscreenchange", schedulePosition);
  window.addEventListener("yt-navigate-finish", () => {
    ensureRemotePolling();
    schedulePosition();
    void maybeAutoFollowVideo();
  });
  window.addEventListener("popstate", () => {
    ensureRemotePolling();
    schedulePosition();
    void maybeAutoFollowVideo();
  });
  window.addEventListener("hashchange", () => {
    ensureRemotePolling();
    schedulePosition();
    void maybeAutoFollowVideo();
  });
  void loadAutoFollowSetting();
  ensureRemotePolling();
  schedulePosition();
})();
