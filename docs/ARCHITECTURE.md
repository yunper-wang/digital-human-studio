# Architecture

Digital Human Studio uses a deliberately small local-first architecture.

- `desktop.mjs` starts Electron and points it at an ephemeral loopback port.
- `server.mjs` serves the UI and owns provider calls, task state and private files.
- `public/` is a credential-free browser client with no Node.js privileges.
- `data/` contains user uploads, task state and generated media and is ignored by Git.
- `config/*.example.json` contains visual demo records only. Private catalogs use the same filenames without `.example`.
- `lib/drama/` contains the short-drama workbench: schema/store, LLM pipeline stages, budget estimation and the ComfyUI adapter. Drama state lives in `data/drama-projects/` and follows the same privacy rules as other local data.

The browser never receives API keys. Real generation is protected by an explicit confirmation, a per-request idempotency key and a no-automatic-paid-retry rule.
