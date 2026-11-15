export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Private-Network": "true",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse(
        {
          status: "ok",
          worker: "apex-mcp",
          timeoutMs: 600000,
          tools: ["github_repo_inspect", "fetch_url_text", "codespace_exec", "chat"],
        },
        200,
        corsHeaders
      );
    }

    // AI model list endpoints (header status dot)
    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/api/models")) {
      return jsonResponse(
        {
          object: "list",
          data: [
            { id: "@cf/qwen/qwen2.5-coder-32b-instruct", object: "model" },
            { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", object: "model" },
          ],
        },
        200,
        corsHeaders
      );
    }

    // AI health endpoint
    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({ status: "ok", worker: "apex-mcp" }, 200, corsHeaders);
    }

    // AI chat endpoint — accepts both /api/chat and /v1/chat/completions
    if (
      request.method === "POST" &&
      (url.pathname === "/api/chat" || url.pathname === "/v1/chat/completions")
    ) {
      return handleChat(request, env, corsHeaders);
    }

    // MCP JSON-RPC endpoint
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const { id, method, params } = body;

        // 1. MCP Initialize
        if (method === "initialize") {
          return jsonResponse(
            {
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "apex-mcp", version: "2.1.0" },
              },
            },
            200,
            corsHeaders
          );
        }

        // 2. MCP Tools List
        if (method === "tools/list") {
          return jsonResponse(
            {
              jsonrpc: "2.0",
              id,
              result: {
                tools: [
                  {
                    name: "github_repo_inspect",
                    description:
                      "Inspect any public GitHub repository's file tree or read a specific file directly via GitHub API without needing a shell.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        owner: { type: "string", description: "GitHub username or org (e.g. mourtla)" },
                        repo: { type: "string", description: "Repository name (e.g. Rea)" },
                        branch: { type: "string", description: "Branch name (default: main)" },
                        path: {
                          type: "string",
                          description: "Optional file path inside repo to read (leave empty to list full file tree)",
                        },
                      },
                      required: ["owner", "repo"],
                    },
                  },
                  {
                    name: "fetch_url_text",
                    description: "Fetch plain text, markdown, JSON, or HTML from a public URL.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        url: { type: "string", description: "Target HTTP/HTTPS URL" },
                      },
                      required: ["url"],
                    },
                  },
                  {
                    name: "codespace_exec",
                    description:
                      "Execute a shell command ONLY when an active runner_url is explicitly configured.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        command: { type: "string", description: "Shell command to execute" },
                        runner_url: { type: "string", description: "Active runner HTTPS URL" },
                        token: { type: "string", description: "Optional Bearer token" },
                        timeout_ms: { type: "number", description: "Timeout in ms (default 600000)" },
                      },
                      required: ["command"],
                    },
                  },
                ],
              },
            },
            200,
            corsHeaders
          );
        }

        // 3. MCP Tool Execution
        if (method === "tools/call") {
          const toolName = params?.name;
          const args = params?.arguments || {};

          if (toolName === "github_repo_inspect") {
            const { owner, repo, branch = "main", path = "" } = args;
            if (!owner || !repo) {
              return mcpToolError(id, "Missing required parameters: owner and repo", corsHeaders);
            }

            if (path) {
              const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(
                repo
              )}/${encodeURIComponent(branch)}/${path.replace(/^\/+/, "")}`;
              const res = await fetchWithTimeout(rawUrl, { headers: { "User-Agent": "Apex-Studio-Worker" } }, 60000);
              if (!res.ok) {
                return mcpToolError(id, `Failed to fetch ${path}: HTTP ${res.status}`, corsHeaders);
              }
              const content = await res.text();
              return mcpToolSuccess(id, content.slice(0, 30000), corsHeaders);
            } else {
              const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
                repo
              )}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
              const res = await fetchWithTimeout(
                treeUrl,
                {
                  headers: {
                    "User-Agent": "Apex-Studio-Worker",
                    Accept: "application/vnd.github+json",
                  },
                },
                60000
              );
              if (!res.ok) {
                return mcpToolError(id, `GitHub API returned HTTP ${res.status} for ${owner}/${repo}`, corsHeaders);
              }
              const data = await res.json();
              const files = (data.tree || []).slice(0, 150).map((item) => `${item.type === "tree" ? "[DIR] " : ""}${item.path}`);
              return mcpToolSuccess(id, files.join("\n") || "Empty repository", corsHeaders);
            }
          }

          if (toolName === "fetch_url_text") {
            if (!args.url) {
              return mcpToolError(id, "Missing required parameter: url", corsHeaders);
            }
            const res = await fetchWithTimeout(
              args.url,
              { headers: { "User-Agent": "Apex-Studio-Worker" } },
              60000
            );
            const text = await res.text();
            return mcpToolSuccess(id, text.slice(0, 100000), corsHeaders);
          }

          if (toolName === "codespace_exec") {
            const runnerUrl = (
              args.runner_url ||
              request.headers.get("X-Runner-Url") ||
              env.RUNNER_URL ||
              ""
            ).trim();

            if (!runnerUrl) {
              return mcpToolError(
                id,
                "No active remote runner configured. Use in-browser tools or github_repo_inspect instead.",
                corsHeaders
              );
            }

            const timeoutMs = Number(args.timeout_ms || request.headers.get("X-Timeout-Ms") || 600000);
            const token = args.token || request.headers.get("X-Runner-Token") || env.RUNNER_TOKEN || "";
            const endpoint = `${runnerUrl.replace(/\/$/, "")}/exec`;

            // redirect: "manual" prevents Cloudflare's 50-subrequest loop on sleeping Codespace auth redirects
            const res = await fetchWithTimeout(
              endpoint,
              {
                method: "POST",
                redirect: "manual",
                headers: {
                  "Content-Type": "application/json",
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ command: args.command }),
              },
              timeoutMs
            );

            if (res.status >= 300 && res.status < 400) {
              return mcpToolError(
                id,
                `Remote runner redirected (HTTP ${res.status} - likely sleeping or requires login). Aborted to prevent subrequest loop.`,
                corsHeaders
              );
            }

            const raw = await res.text();
            if (!res.ok) {
              return mcpToolError(id, `Remote runner HTTP ${res.status}: ${raw.slice(0, 1000)}`, corsHeaders);
            }
            return mcpToolSuccess(id, raw, corsHeaders);
          }

          return mcpToolError(id, `Unknown tool: ${toolName}`, corsHeaders);
        }

        return jsonResponse(
          { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } },
          200,
          corsHeaders
        );
      } catch (err) {
        return jsonResponse(
          { jsonrpc: "2.0", id: null, error: { code: -32000, message: err.message || "Worker error" } },
          500,
          corsHeaders
        );
      }
    }

    // n8n MCP endpoint — direct REST integration with n8n instance

    if (request.method === "POST" && url.pathname === "/n8n-mcp") {
      return handleN8nMcp(request, env, corsHeaders);
    }

    return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  },
};

async function handleN8nMcp(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {

    return jsonResponse({ error: { message: "Invalid JSON body" } }, 400, corsHeaders);
  }

  const { id, method, params } = body;
  const args = params?.arguments || {};

  if (method === "initialize") {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "n8n-mcp", version: "2.0.0" },

        },
      },
      200,
      corsHeaders
    );
  }

  if (method === "tools/list") {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "list_n8n_workflows",
              description:
                "List active n8n workflows with id, name, active status, and webhook paths so available automations are known.",
              inputSchema: { type: "object", properties: {} },
            },
            {
              name: "run_n8n_automation",
              description:
                "Run an n8n automation by workflow name or ID (or configured webhook preset). Automatically finds and triggers the matching workflow with provided data.",
              inputSchema: {
                type: "object",
                properties: {
                  workflow_name_or_id: {
                    type: "string",
                    description: "Workflow name or ID to run (or a configured preset name)",
                  },
                  data: {
                    type: "object",
                    description: "Optional JSON payload to send to the automation",
                  },
                },
                required: ["workflow_name_or_id"],

              },
            },
          ],
        },
      },
      200,
      corsHeaders
    );
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const setupMessage =
      "n8n is not configured yet. Add these two secrets in Cloudflare Dashboard → Workers → `fuck` → Settings → Variables and Secrets:\n" +
      "1. `N8N_BASE_URL` — your n8n instance URL (e.g. https://your-n8n.example.com)\n" +
      "2. `N8N_API_KEY` — your n8n API key (Settings → n8n API in your n8n instance)";

    if (toolName === "list_n8n_workflows") {
      const baseUrl = (env.N8N_BASE_URL || "").replace(/\/$/, "");
      const apiKey = env.N8N_API_KEY || "";
      if (!baseUrl) {
        return mcpToolError(id, setupMessage, corsHeaders);
      }
      try {
        const res = await fetchWithTimeout(
          `${baseUrl}/api/v1/workflows`,
          {
            method: "GET",
            headers: {
              ...(apiKey ? { "X-N8N-API-KEY": apiKey } : {}),
              Accept: "application/json",
            },
          },
          30000
        );
        const text = await res.text();
        if (!res.ok) {
          return mcpToolError(id, `Failed to fetch workflows (HTTP ${res.status}): ${text.slice(0, 1000)}`, corsHeaders);
        }
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return mcpToolError(id, `Invalid JSON from n8n workflows API: ${text.slice(0, 500)}`, corsHeaders);
        }
        const workflows = (data.data || data || []).map((w) => {
          const webhooks = [];
          (w.nodes || []).forEach((n) => {
            if (n.type && n.type.toLowerCase().includes("webhook")) {
              const path = n.parameters?.path || n.webhookId || null;
              if (path) webhooks.push(`/webhook/${String(path).replace(/^\/+/, "")}`);
            }
          });
          return { id: w.id, name: w.name, active: w.active, webhooks };
        });
        return mcpToolSuccess(id, JSON.stringify(workflows, null, 2), corsHeaders);
      } catch (err) {
        return mcpToolError(id, `Error listing workflows: ${err.message || "Unknown error"}`, corsHeaders);
      }
    }

    if (toolName === "run_n8n_automation") {
      const nameOrId = String(args.workflow_name_or_id || "").trim();
      const data = args.data || {};
      if (!nameOrId) {
        return mcpToolError(id, "Missing required parameter: workflow_name_or_id", corsHeaders);
      }

      const baseUrl = (env.N8N_BASE_URL || "").replace(/\/$/, "");
      const apiKey = env.N8N_API_KEY || "";

      // Fallback: named webhook presets from env/vars (JSON: { "presetName": "https://..." })
      let presets = {};
      try {
        if (env.N8N_WEBHOOK_PRESETS) presets = JSON.parse(env.N8N_WEBHOOK_PRESETS);
      } catch {
        presets = {};
      }
      const presetUrl = presets[nameOrId];
      if (presetUrl) {
        try {
          const res = await fetchWithTimeout(
            presetUrl,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            },
            60000
          );
          const text = await res.text();
          return mcpToolSuccess(
            id,
            JSON.stringify({ source: "preset", status: res.status, statusText: res.statusText, body: text.slice(0, 10000) }),
            corsHeaders
          );
        } catch (err) {
          return mcpToolError(id, `Preset webhook request failed: ${err.message || "Unknown error"}`, corsHeaders);
        }
      }

      if (!baseUrl) {
        return mcpToolError(id, setupMessage, corsHeaders);
      }

      try {
        // Look up workflows to find matching name or id
        const listRes = await fetchWithTimeout(
          `${baseUrl}/api/v1/workflows`,
          {
            method: "GET",
            headers: {
              ...(apiKey ? { "X-N8N-API-KEY": apiKey } : {}),
              Accept: "application/json",
            },
          },
          30000
        );
        const listText = await listRes.text();
        if (!listRes.ok) {
          return mcpToolError(id, `Failed to fetch workflows (HTTP ${listRes.status}): ${listText.slice(0, 1000)}`, corsHeaders);
        }
        let listData;
        try {
          listData = JSON.parse(listText);
        } catch {
          return mcpToolError(id, `Invalid JSON from n8n workflows API: ${listText.slice(0, 500)}`, corsHeaders);
        }
        const workflows = listData.data || listData || [];
        const target = workflows.find(
          (w) => String(w.id) === nameOrId || (w.name && w.name.toLowerCase() === nameOrId.toLowerCase())
        );
        if (!target) {
          const names = workflows.slice(0, 20).map((w) => `${w.name} (${w.id})`).join(", ");
          return mcpToolError(id, `Workflow not found: "${nameOrId}". Available: ${names || "none"}`, corsHeaders);
        }

        // Find webhook path from workflow nodes
        let webhookPath = null;
        (target.nodes || []).forEach((n) => {
          if (!webhookPath && n.type && n.type.toLowerCase().includes("webhook")) {
            const path = n.parameters?.path || n.webhookId || null;
            if (path) webhookPath = String(path).replace(/^\/+/, "");
          }
        });

        if (webhookPath) {
          // Use test or production webhook URL; prefer production
          const hookUrl = `${baseUrl}/webhook/${webhookPath}`;
          const res = await fetchWithTimeout(
            hookUrl,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(data),
            },
            60000
          );
          const text = await res.text();
          return mcpToolSuccess(
            id,
            JSON.stringify({
              workflow: { id: target.id, name: target.name },
              webhook: hookUrl,
              status: res.status,
              statusText: res.statusText,
              body: text.slice(0, 10000),
            }),
            corsHeaders
          );
        }

        // Fallback: try to execute via n8n REST API if no webhook node found
        const execRes = await fetchWithTimeout(
          `${baseUrl}/api/v1/workflows/${encodeURIComponent(target.id)}/run`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(apiKey ? { "X-N8N-API-KEY": apiKey } : {}),
            },
            body: JSON.stringify({ data }),
          },
          60000
        );
        const execText = await execRes.text();
        return mcpToolSuccess(
          id,
          JSON.stringify({
            workflow: { id: target.id, name: target.name },
            execution: "rest-api",
            status: execRes.status,
            statusText: execRes.statusText,
            body: execText.slice(0, 10000),
          }),
          corsHeaders
        );
      } catch (err) {
        return mcpToolError(id, `Error running automation: ${err.message || "Unknown error"}`, corsHeaders);

      }
    }

    return mcpToolError(id, `Unknown tool: ${toolName}`, corsHeaders);
  }

  return jsonResponse(
    { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } },
    200,
    corsHeaders
  );
}

async function handleChat(request, env, corsHeaders) {
  const PRIMARY_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
  const FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: { message: "Invalid JSON body" } }, 400, corsHeaders);
  }

  const { messages, tools, temperature, max_tokens, stream = false } = body;
  if (!messages || !Array.isArray(messages)) {
    return jsonResponse({ error: { message: "Missing required parameter: messages" } }, 400, corsHeaders);
  }

  const buildPayload = (model) => ({
    messages,
    ...(tools ? { tools } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(max_tokens !== undefined ? { max_tokens } : { max_tokens: 4096 }),
    stream,
  });

  const isRateOrCapacity = (err) => {
    const msg = String(err.message || err).toLowerCase();
    return (
      msg.includes("rate") ||
      msg.includes("capacity") ||
      msg.includes("overloaded") ||
      msg.includes("unavailable") ||
      msg.includes("429") ||
      msg.includes("503")
    );
  };

  const runModel = async (model) => {
    const payload = buildPayload(model);
    return await env.AI.run(model, payload);
  };

  let result;
  try {
    result = await runModel(PRIMARY_MODEL);
  } catch (primaryErr) {
    if (!isRateOrCapacity(primaryErr)) {
      return jsonResponse({ error: { message: primaryErr.message || "AI provider error" } }, 502, corsHeaders);
    }
    try {
      result = await runModel(FALLBACK_MODEL);
    } catch (fallbackErr) {
      return jsonResponse({ error: { message: fallbackErr.message || "AI provider error" } }, 502, corsHeaders);
    }
  }

  if (stream) {
    return handleStream(result, corsHeaders);
  }
  return handleNonStream(result, corsHeaders);
}

function handleStream(result, corsHeaders) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const emitChunk = (content, finishReason, toolCalls) => {
    const delta = {};
    if (content) delta.content = content;
    if (toolCalls) delta.tool_calls = toolCalls;
    const out = JSON.stringify({
      id: "chatcmpl-cf",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: PRIMARY_MODEL_NAME,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    return writer.write(encoder.encode(`data: ${out}\n\n`));
  };

  const extractToolCalls = (parsed) => {
    if (!parsed) return null;
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      return parsed.tool_calls.map((tc) => ({
        index: tc.index ?? 0,
        id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`,
        type: "function",
        function: {
          name: tc.function?.name ?? tc.name ?? "",
          arguments: JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
        },
      }));
    }
    if (parsed.choices?.[0]?.delta?.tool_calls) {
      return parsed.choices[0].delta.tool_calls;
    }
    return null;
  };

  (async () => {
    try {
      const reader = result.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = new TextDecoder().decode(value);
        const lines = chunk.split("\n").filter((line) => line.trim());
        for (const line of lines) {
          let data = line;
          if (data.startsWith("data: ")) data = data.slice(6);
          if (data === "[DONE]") {
            await emitChunk(null, "stop");
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const content =
            parsed.response ??
            parsed.choices?.[0]?.delta?.content ??
            parsed.text ??
            "";
          const toolCalls = extractToolCalls(parsed);
          if (content || toolCalls) {
            await emitChunk(content, null, toolCalls);
          }
        }
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function handleNonStream(result, corsHeaders) {
  const text =
    result?.response ||
    result?.text ||
    result?.choices?.[0]?.message?.content ||
    result?.choices?.[0]?.text ||
    JSON.stringify(result);

  const rawToolCalls =
    result?.choices?.[0]?.message?.tool_calls ??
    result?.tool_calls ??
    (() => {
      try {
        const obj = JSON.parse(text);
        if (obj && obj.name && typeof obj.arguments === "object") {
          return [{ index: 0, id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: obj.name, arguments: JSON.stringify(obj.arguments) } }];
        }
      } catch {
        // not JSON
      }
      return null;
    })();

  if (rawToolCalls) {
    const out = {
      id: "chatcmpl-worker",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: rawToolCalls },
          finish_reason: "tool_calls",
        },
      ],
      usage: result?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return jsonResponse(out, 200, corsHeaders);
  }

  const out = {
    id: "chatcmpl-worker",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "@cf/qwen/qwen2.5-coder-32b-instruct",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: result?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return jsonResponse(out, 200, corsHeaders);
}

const PRIMARY_MODEL_NAME = "@cf/qwen/qwen2.5-coder-32b-instruct";

async function fetchWithTimeout(url, options = {}, timeoutMs = 600000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function mcpToolSuccess(id, text, headers) {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }] },
    },
    200,
    headers
  );
}

function mcpToolError(id, message, headers) {
  return jsonResponse(
    {
      jsonrpc: "2.0",
      id,
      result: { isError: true, content: [{ type: "text", text: message }] },
    },
    200,
    headers
  );
}
