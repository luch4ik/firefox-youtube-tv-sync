# Privacy Policy

This project does not include analytics, advertising, or remote telemetry operated by the author.

What the extension processes:

- The current YouTube page/video identifier
- Playback state such as play/pause and current time
- Your selected TV/device identifier
- Local helper connection status

What the extension sends:

- The extension sends control requests to a local helper at `http://127.0.0.1:49314`
- Those requests can include YouTube video identifiers, playback position, playback state, and the selected device identifier

What the local helper does:

- Discovers compatible devices on your local network
- Sends playback/control commands to compatible TVs on your local network
- For supported YouTube targets, may communicate with YouTube lounge/second-screen endpoints needed to pair and control playback

What is not collected by the author:

- No analytics
- No crash reporting
- No advertising identifiers
- No remote account system operated by this project
- No sale of personal data

Data retention:

- The extension stores a small amount of local state in Firefox storage, such as the last selected device and whether auto-follow is enabled
- The helper keeps transient in-memory session state needed for the active TV control session
- This project does not intentionally send usage logs to the author or store your viewing history on an external server

Because the extension transmits YouTube page/player state to a local helper for processing, the AMO data collection declaration marks `websiteActivity` and `websiteContent` as required for operation.
