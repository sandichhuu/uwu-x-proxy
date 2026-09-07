# uwu-x-proxy

Manage all your AI API endpoints in a single web application.
> Supported sources: **Antigravity (Google)**, **Codex (OpenAI)**, and custom **API Endpoints**.

Unified proxy compatible with both **OpenAI** and **Anthropic** APIs. Root (`/`) and `/v1` routes are aliases.

## Quick start

Requirements: **Node.js 18+**.

```bash
npm i uwu-x-proxy
```

Then open the dashboard in your browser:

```text
http://localhost:3081
```

On Windows you can also double-click `run.bat` (installs dependencies on first run and starts the server on `HOST:PORT`, default `127.0.0.1:3081`).

> Custom host/port: `PORT=3081 HOST=127.0.0.1 node src/index.js`

## Features

- **Unified proxy** — expose Google, OpenAI, and custom endpoints through one OpenAI/Anthropic-compatible base URL.
- **Multi-account management** — connect Antigravity and Codex accounts via OAuth, plus custom OpenAI/Anthropic endpoints.
- **Smart routing** — map public models to upstream models with round-robin / smart routing, effort mapping, and aliases.
- **Inference playground** — test chat and reasoning directly in the dashboard before integrating.
- **1-click Integrate** — auto-integrate public models into DeepSeek Harness (DSH).
- **Analytics & logs** — usage trends, model distribution, request history, tokens, latency, and errors.

## Dashboard

| Page | What it does |
| --- | --- |
| Analytics | Usage trends, model distribution, tokens, success rate |
| Inference | Chat directly with your mapped models |
| Models | Public model mappings served through one endpoint |
| API Routes | Routing rules, effort mappings, and model aliases |
| Accounts | Google / OpenAI accounts and custom API endpoints, quota included |
| Logs | Recent requests with latency, tokens, and status |
| Integrate | 1-click DSH integration with preview and backup |

## API usage

Point any OpenAI- or Anthropic-compatible client at the proxy:

```text
http://localhost:3081/v1
```

Examples:

- `GET /v1/models` (also `GET /models`)
- `POST /v1/chat/completions` (also `POST /chat/completions`)
- `POST /v1/responses` (also `POST /responses`)
- `POST /v1/messages` (also `POST /messages`, Anthropic)

## Screenshots
---
### Analytics
<img width="1919" height="942" alt="image" src="https://github.com/user-attachments/assets/ef998362-0117-4549-9fd3-08449ee9ea6e" />

### Inference
<img width="1919" height="946" alt="image" src="https://github.com/user-attachments/assets/834756c0-8797-48aa-ac82-55309899ddff" />

### Models
<img width="1918" height="948" alt="image" src="https://github.com/user-attachments/assets/3cccb216-8b04-428d-b89b-9a9f4cf44c25" />

### Routes
Public models from different providers to a single endpoint.
<img width="1919" height="944" alt="image" src="https://github.com/user-attachments/assets/a275947a-f5e7-4915-a3f6-91bb47ee7ef9" />

### Accounts
Working with multiple accounts, including Antigravity and Codex.
<img width="1919" height="944" alt="image" src="https://github.com/user-attachments/assets/679f147d-fca4-4db8-aab6-71919f63094a" />

### Integrate
Auto integrate models into DeepSeek Harness, only 1 click.
<img width="1919" height="947" alt="image" src="https://github.com/user-attachments/assets/b4f40884-09fb-4a36-b328-95f0789e1115" />

## License

GPL-3.0-or-later. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
