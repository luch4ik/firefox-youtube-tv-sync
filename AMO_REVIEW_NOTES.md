# AMO Reviewer Notes

This add-on is YouTube-only and uses a localhost helper to control TVs.

Why localhost permissions are needed:

- The extension UI runs in YouTube pages
- A background script proxies approved requests to `http://127.0.0.1:49314`
- The helper performs device discovery and TV control on the local network

Security model:

- The helper binds to `127.0.0.1` by default
- The helper rejects non-loopback binding unless explicitly started with `--allow-network`
- The extension background script only allows a fixed path allowlist:
  - `/health`
  - `/devices`
  - `/cast`
  - `/youtube-remote/status`
  - `/youtube-remote/command`
- The helper requires an extension-specific header and rejects ordinary web-page requests

Why `websiteActivity` and `websiteContent` are declared:

- The extension reads the current YouTube page/player state
- It sends the current video identifier, playback state, and playback position to the local helper so the TV session can be controlled and mirrored
- This data is required for the core functionality

How to test:

1. Start the helper:

   `.venv/bin/python cast_helper.py`

2. Load `firefox-extension/manifest.json` as a temporary add-on in Firefox via `about:debugging`
3. Open a YouTube watch page
4. Use the floating cast button in the player

Best-tested environment:

- Samsung Tizen TV with YouTube handoff/control

Important scope note:

- This add-on is experimental
- It is intentionally YouTube-only
- It does not promise a uniform feature set across all TV brands/protocols
