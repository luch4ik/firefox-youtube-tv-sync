# Firefox Extension Install

1. Start the local helper:

```bash
cd /home/nvx/projects/firefox-cast-button
.venv/bin/python cast_helper.py
```

2. In Firefox, open `about:debugging`.
3. Click `This Firefox`.
4. Click `Load Temporary Add-on...`.
5. Choose [`manifest.json`](/home/nvx/projects/firefox-cast-button/firefox-extension/manifest.json).

The extension will inject the floating cast button into pages with HTML5 video.

Notes:

- Temporary add-ons are removed when Firefox fully exits, so load it again after restarting Firefox.
- The helper must stay running on `127.0.0.1:49314`.
