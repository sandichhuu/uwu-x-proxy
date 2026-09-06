# uwu-x-proxy

Experimental JavaScript proxy on one endpoint/port (default `127.0.0.1:3081`). Includes Google Antigravity and OpenAI Codex OAuth/account adapters plus manually configured API endpoints.

## Quick start

```sh
npm install
npm start
# open http://127.0.0.1:3081/admin/
```

Set `UWU_PROXY_KEY` to require inference authentication. Administration has no `UWU_ADMIN_KEY`: it is restricted to loopback clients. Never use an upstream credential as a proxy key.

Runtime state: `~/.uwu-x-proxy/state.json`, overridden by `UWU_DATA_DIR`. API keys in state are AES-256-GCM encrypted; the key is stored separately at `~/.uwu-x-proxy-secrets/key`, overridden by `UWU_SECRET_KEY_FILE`. Back up both state and key securely. POSIX restrictive modes are requested; configure Windows ACLs yourself. Legacy plaintext endpoint API keys are migrated on load. Do not run multiple processes against the same state directory; JSON storage does not provide multi-process transactions.

`HOST` and `PORT` configure binding. Keep the default loopback binding; this is **not ready for public deployment**. `UWU_CORS_ORIGIN` allows one additional browser origin. Private upstream URLs are blocked by default; an authenticated admin may explicitly opt in per endpoint with `allowPrivate: true`. Upstream redirects are rejected and validated DNS addresses are pinned to connections.

## Configure an endpoint

Use authenticated `POST /admin/api/endpoints`:

```json
{"name":"Example","baseUrl":"https://api.example.com/v1","protocol":"openai","apiKey":"YOUR_UPSTREAM_KEY"}
```

Use the returned endpoint ID with `POST /admin/api/models`:

```json
{"id":"public-model","endpointId":"endpoint_ID","upstreamId":"upstream-model","effort":{"mode":"passthrough","supported":["low","medium","high"],"default":"medium"}}
```

`baseUrl` must include any required API prefix (such as `/v1`); the proxy appends only the operation path and never adds a second `/v1`. Supported endpoint protocols: `openai`, `anthropic`. Discovery returns upstream model candidates; publication remains manual. Configure model `provider: "openai-codex"` only for actual Codex bindings, so DSH receives its required reasoning mapping. Variant mappings must be explicitly configured from verified discovery; they are not inferred from ID suffixes.

The UI is read-only for endpoint/model management; use the admin API for mutations.

## Current protocol support

Root and `/v1` inference paths are aliases with shared auth:

- `/models`, `/models/:id`: OpenAI or Anthropic schema (selected by `anthropic-version`).
- `/chat/completions`: forwards to OpenAI-compatible endpoints.
- `/responses`: forwards to an endpoint's native Responses API; does not translate Chat Completions. Stored/background responses are rejected.
- `/messages`: native Anthropic forwarding; basic text/tools conversion for OpenAI endpoints in both non-stream and streaming modes.
- SSE uses incremental UTF-8 decoding, public model IDs, backpressure, anti-buffering headers, timeout and client cancellation. OpenAI Chat Completions streams are converted to Anthropic text/tool/usage events without raw cross-protocol forwarding.
- OpenAI routes backed by native Anthropic endpoints still return `501`; that reverse conversion is not implemented. Unsupported blocks in Anthropic-to-OpenAI conversion return `400` instead of dropping content.
- `/messages/count_tokens` returns `501` until exact backend support exists.

## DSH installation

The Install page manages **only** `llm-pi-ai.providers.x-proxy` in `~/.dsh/settings.yaml`. It includes enabled public models, pointing at the single proxy URL. Actual Codex models receive `minimal?low`, `low?medium`, `medium?high`, `high?xhigh`, `xhigh?max`, `max?ultra`.

Admin API contract:

1. `GET /admin/api/integrations` â€” status.
2. `POST /admin/api/integrations/dsh/plan` â€” changes and revision.
3. `POST /admin/api/integrations/dsh/install` with `{"confirmed":true,"revision":"FROM_PLAN"}` â€” local authenticated install.

Invalid YAML/tree shapes disable installation. Existing `x-proxy` maps remain user-owned. Installation uses a cooperating-installer lock, stale-plan check, final content comparison, restrictive backup/temp files, fsync, atomic rename, and post-write validation. YAML comments and unrelated settings are retained where supported by the parser. External editors that ignore the lock can still race the final comparison/rename; coordinate writes. Crashed installers may leave a `.uwu.lock` requiring manual inspection/removal.

## Verification and remaining work

```sh
npm test
npm pack --dry-run
```

See [docs/IMPLEMENTATION_REVIEW.md](docs/IMPLEMENTATION_REVIEW.md) for review findings and outstanding design requirements. OAuth, account discovery, refresh, Codex quota, round-robin account routing, and Codex Responses-to-Anthropic conversion are included. SQLite, full analytics charts, Google inference conversion, and generic OpenAI-to-Anthropic-endpoint conversion remain outstanding.

## Connect accounts and OpenAI-compatible endpoints

In **Accounts > Google / OpenAI**, click **Connect**. A browser window opens;
the temporary local OAuth callback listener captures the code and saves the
account automatically. Manual callback URL/code entry is only a fallback.
Google uses `localhost:51121/oauth-callback`; OpenAI uses
`localhost:1455/auth/callback` with fallback ports 1456�1460. These listeners
are loopback-only, close after completion/cancellation/timeout, and do not
change the single inference endpoint. Google project discovery/onboarding
and version detection are ported from the reference project. See
`src/auth/oauth-license.txt` for attribution and intentional safety changes.

For **Ollama**:

1. Start Ollama and pull a model (for example `ollama pull llama3.2`).
2. Open **Accounts > API Endpoints > Use Ollama preset**.
3. Use `http://localhost:11434/v1`, leave API key empty, and explicitly allow
   localhost/private-network access. Save the endpoint.
4. Discover models and choose **Add model**, editing the public ID if desired
   (for example `ollama/llama3.2`). Manual model entry is also supported.
5. Use that public ID with x-proxy's `/v1/chat/completions` endpoint. It also
   appears in `/v1/models` and the Models page.

Local URLs refer to the computer/container running x-proxy. Model discovery
lists installed models; it does not download models into Ollama. Importing a
model never overwrites an unrelated public mapping with the same ID.

### Manual OAuth URL and local Codex import

Accounts > Google/OpenAI now offers two independent login methods:
- **Sign in with browser** starts a temporary loopback callback listener.
- **Sign in with URL** generates a URL without binding a callback port. Copy/open
  the link, sign in, then paste the complete validation/callback URL (or code)
  into **Complete sign-in**. A localhost connection error at the end is expected
  in this mode: copy the address bar URL anyway. Manual sessions expire after
  10 minutes and still validate state/PKCE. Cancel before starting another flow.

Accounts > OpenAI > **Import from local Codex** reads `CODEX_HOME/auth.json`, or
`~/.codex/auth.json` by default, on the machine running x-proxy. It imports the
reference `tokens.access_token`, `refresh_token`, `id_token`, and `account_id`
format, extracts claims, and adds/updates the account in x-proxy's encrypted
store without modifying Codex files. API-key-only and keyring-only credentials
are not supported by this file import. Sign in through Codex first.

Non-JSON responses are reported with the failing stage and HTTP status rather
than exposing raw HTML or credentials. An admin API non-JSON error can indicate
an outdated running server or reverse-proxy/login page; restart x-proxy and
reload `/admin/`. An OAuth token/profile error indicates an upstream response.
