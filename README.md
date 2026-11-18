# Js

Apex Studio Cloudflare Worker backend. Proxies MCP servers, n8n webhooks, and remote runner execution server-side so frontend clients never store or send internal URLs or bearer tokens.

## Required secrets

Set these via Wrangler (never commit them):

```
wrangler secret put APEX_MCP_URL
wrangler secret put N8N_MCP_URL
wrangler secret put MCP_TOKEN
wrangler secret put N8N_WEBHOOK_URL
wrangler secret put REMOTE_RUNNER_URL
wrangler secret put REMOTE_RUNNER_TOKEN
```

- `APEX_MCP_URL` — upstream JSON-RPC MCP endpoint for Apex
- `N8N_MCP_URL` — upstream JSON-RPC MCP endpoint for n8n
- `MCP_TOKEN` — bearer token for both MCP endpoints
- `N8N_WEBHOOK_URL` — n8n webhook target URL
- `REMOTE_RUNNER_URL` — remote runner base URL (e.g. `https://runner.example.com`)
- `REMOTE_RUNNER_TOKEN` — bearer token for the remote runner `/exec` endpoint

## Endpoints

- `POST /v1/mcp/apex` — proxy to `env.APEX_MCP_URL` (Bearer `env.MCP_TOKEN`)
- `POST /v1/mcp/n8n` — proxy to `env.N8N_MCP_URL` (Bearer `env.MCP_TOKEN`)
- `POST /v1/webhook/n8n` — proxy to `env.N8N_WEBHOOK_URL`
- `POST /v1/exec` — proxy to `${env.REMOTE_RUNNER_URL}/exec` (Bearer `env.REMOTE_RUNNER_TOKEN`)
- `GET /api/chat` / `POST /v1/chat/completions` — Workers AI chat proxy
- `GET /search?q=...` — server-side web search
- `GET /v1/models` — OpenAI-compatible model list
- `GET /` — health

## Deploy

```
wrangler deploy
```
