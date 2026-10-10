# Design

Images are sent from the browser as bounded base64, written by Runtime into a mode-0600 temporary directory, passed to Codex as documented `localImage` inputs, and removed in `finally`. Supported text files are decoded in the browser and included as explicitly untrusted evidence. No attachment instruction can override system/developer instructions. Raw attachment content is not persisted in localStorage.

Limits: four attachments per turn, 5 MB per image, 1 MB selected text file with at most 200,000 transmitted characters, and a 10 MB authenticated request ceiling.

