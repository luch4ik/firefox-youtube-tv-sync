# YouTube TV Sync for Firefox

Experimental real-time YouTube TV sync/control for Firefox.

This is a quick personal project, not a finished product.

It adds a floating cast button on YouTube pages, connects to a TV through a local helper, and then keeps the browser player and TV session in sync closely enough that the normal YouTube controls can act like the remote.

It is built around two parts:

1. `firefox-extension/`: a Firefox WebExtension that adds the floating cast button and sync/control logic.
2. `cast_helper.py`: a local Python HTTP service that discovers supported TVs and starts playback/control sessions.

Preferred Firefox install:

- `firefox-extension/manifest.json` as a temporary Firefox add-on loaded from `about:debugging`
- Firefox 140 or newer is recommended for the current manifest/privacy declaration

## Current Scope

- YouTube pages in Firefox only
- Floating cast button inside the player area
- Samsung Tizen TVs with YouTube handoff via DIAL + lounge
- Chromecast / Google TV style YouTube handoff
- Real-time play / pause / seek / disconnect on the best-supported path
- Auto-follow for next YouTube videos in the same tab

## What It Does Not Support

- General web video sites anymore; this build is intentionally YouTube-only
- DRM services like Netflix, Disney+, Prime Video
- A uniform feature set across every TV brand / protocol
- Guaranteed volume / captions / quality control on all targets
- The level of polish you would expect from a finished consumer extension

## Install

### 1. Create the Python environment

```bash
cd firefox-cast-button
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 2. Start the helper

```bash
cd firefox-cast-button
.venv/bin/python cast_helper.py
```

Optional default device:

```bash
CAST_DEFAULT_DEVICE="Living Room TV" .venv/bin/python cast_helper.py
```

The helper listens on `http://127.0.0.1:49314`.

By default it refuses to bind to non-loopback interfaces. If you intentionally want that, you must pass `--allow-network`, which is unsafe on untrusted networks.

### 3. Load the Firefox extension

1. Open `about:debugging`.
2. Click `This Firefox`.
3. Click `Load Temporary Add-on...`.
4. Pick `firefox-extension/manifest.json`.

### 4. Privacy

The extension sends the minimum data needed to a localhost helper on `127.0.0.1:49314` so it can discover TVs and control playback. See `PRIVACY.md` for the exact data flow.

### 5. Optional: legacy userscript path

`firefox-video-cast.user.js` still exists for manual userscript installs, but the Firefox extension is the preferred path.

## What “Sync” Means Here

- The TV is still the real playback device.
- The browser page mirrors and controls that TV session.
- The goal is practical real-time control and timestamp alignment, not frame-perfect lockstep.

## Usage

1. Open a YouTube watch page or short.
2. Hover the player or keep it visible in the viewport.
3. Click the floating cast button in the top-right corner of the video.
4. Pick the TV from the device list.
5. After connection, use the normal YouTube controls.

The extension remembers the last selected device and can auto-follow new YouTube videos in the same tab when enabled.

## Device Reality

- Best-tested target: Samsung `UE55CU7172UXXH` via DIAL + YouTube lounge.
- The Firefox extension is only the UI. The actual playback/control session is started by the local helper.
- The helper only accepts extension-style requests with a custom header and is not readable from arbitrary web pages.
- If no devices appear, make sure the TV and computer are on the same network.
- Some capabilities are TV-specific. Do not present this as “all TVs get all controls.”
- At the time of writing, play/pause/seek/disconnect/auto-follow are the most reliable path. Volume is not promised across all TVs.
- For AMO submission, the extension declares `websiteActivity` and `websiteContent` because it reads the current YouTube page/player state and sends that to the local helper for playback control.

## Release Notes

- Treat this as a quick personal project, not a finished consumer extension.
- If you post it publicly, describe it as YouTube-only.
- This repository uses the MIT license.

## Feedback

Feedback, bug reports, and input are welcome.

If you try it on a different TV or hit a weird edge case, I would be happy to hear what worked, what broke, and what feels rough.
