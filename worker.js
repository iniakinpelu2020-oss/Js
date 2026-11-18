export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // n8n MCP proxy — handle before any catch-all handlers
    if (url.pathname === "/n8n-mcp" || url.pathname.startsWith("/n8n-mcp/")) {
      const n8nCors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      };
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: n8nCors });
      }
      const body = await request.text();
      const upstream = await fetch("https://drippydee.app.n8n.cloud/mcp-server/http", {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: request.headers.get("Authorization") || "Bearer " + (env.N8N_MCP_TOKEN || ""),
        },
        body: request.method !== "GET" && request.method !== "HEAD" ? body : undefined,
      });
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Headers", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Private-Network": "true",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check endpoint
    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse(
        {
          status: "ok",
          worker: "apex-mcp",
          timeoutMs: 600000,
          tools: ["github_repo_inspect", "fetch_url_text", "codespace_exec", "chat", "web_search"],
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

    // Web search endpoint — server-side search returning clean JSON results
    if (request.method === "GET" && url.pathname === "/search") {
      return handleSearch(request, corsHeaders);
    }

    // Secret-backed proxy routes (tokens/URLs read only from env.*)
    if (request.method === "POST" && url.pathname === "/v1/mcp/apex") {
      return proxyJson(request, env.APEX_MCP_URL, env.MCP_TOKEN, corsHeaders);
    }
    if (request.method === "POST" && url.pathname === "/v1/mcp/n8n") {
      return proxyJson(request, env.N8N_MCP_URL, env.MCP_TOKEN, corsHeaders);
    }
    if (request.method === "POST" && url.pathname === "/v1/webhook/n8n") {
      return proxyJson(request, env.N8N_WEBHOOK_URL, null, corsHeaders);
    }
    if (request.method === "POST" && url.pathname === "/v1/exec") {
      if (!env.REMOTE_RUNNER_URL) {
        return jsonResponse({ error: "REMOTE_RUNNER_URL not configured" }, 500, corsHeaders);
      }
      return proxyJson(request, env.REMOTE_RUNNER_URL.replace(/\/$/, "") + "/exec", env.REMOTE_RUNNER_TOKEN, corsHeaders);
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
                  {
                    name: "web_search",
                    description:
                      "Search the web for up-to-date information. Returns a list of results with title, url, and snippet.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        query: {
                          type: "string",
                          description: "Search query",
                        },
                        max_results: {
                          type: "number",
                          description: "Maximum number of results to return (default 5)",
                        },
                      },
                      required: ["query"],
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

          if (toolName === "web_search") {
            const query = args.query || "";
            const max_results = Number(args.max_results || 5);
            if (!query) {
              return mcpToolError(id, "Missing required parameter: query", corsHeaders);
            }
            const results = await performWebSearch(query, max_results);
            return mcpToolSuccess(id, JSON.stringify({ results }, null, 2), corsHeaders);
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

    // n8n MCP endpoint — proxy to n8n hosted MCP server
    if (request.method === "POST" && url.pathname === "/n8n-mcp") {
      return handleN8nMcp(request, env, corsHeaders);
    }

    return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  },
};

async function handleN8nMcp(request, env, corsHeaders) {
  const upstreamUrl = "https://drippydee.app.n8n.cloud/mcp-server/http";
  let body;
  try {
    body = await request.text();
  } catch {
    return jsonResponse({ error: { message: "Failed to read request body" } }, 400, corsHeaders);
  }

  try {
    const res = await fetchWithTimeout(
      upstreamUrl,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(env.N8N_MCP_TOKEN ? { Authorization: `Bearer ${env.N8N_MCP_TOKEN}` } : {}),
        },
        body,
      },
      120000
    );

    const responseHeaders = new Headers(corsHeaders);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Headers", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    const ct = res.headers.get("content-type");
    if (ct) responseHeaders.set("Content-Type", ct);
    const cache = res.headers.get("cache-control");
    if (cache) responseHeaders.set("Cache-Control", cache);

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return jsonResponse(
      { jsonrpc: "2.0", id: null, error: { code: -32000, message: err.message || "n8n MCP proxy error" } },
      502,
      corsHeaders
    );
  }
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

async function handleSearch(request, corsHeaders) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q") || "";
  const max_results = Number(searchParams.get("max_results") || 5);
  if (!query) {
    return jsonResponse({ error: { message: "Missing required parameter: q" } }, 400, corsHeaders);
  }
  const results = await performWebSearch(query, max_results);
  return jsonResponse({ results }, 200, corsHeaders);
}

async function performWebSearch(query, max_results = 5) {
  try {
    const ddgUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetchWithTimeout(ddgUrl, {
      headers: { "User-Agent": "Apex-Studio-Worker/1.0" },
    }, 30000);
    if (!res.ok) {
      return [];
    }
    const html = await res.text();
    const results = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let match;
    while ((match = resultRegex.exec(html)) && results.length < max_results) {
      let url = match[1] || "";
      let title = (match[2] || "").replace(/<[^>]*>/g, "").trim();
      let snippet = (match[3] || "").replace(/<[^>]*>/g, "").trim();
      if (url.startsWith("//")) url = "https:" + url;
      if (url.startsWith("/l/?kh=")) {
        try {
          const ud = new URL("https://duckduckgo.com" + url);
          const udd = ud.searchParams.get("uddg");
          if (udd) url = udd;
        } catch {
          // keep as-is
        }
      }
      results.push({ title, url, snippet });
    }
    return results;
  } catch {
    return [];
  }
}

async function proxyJson(request, targetUrl, token, corsHeaders) {
  if (!targetUrl) {
    return jsonResponse({ error: "Target URL not configured" }, 500, corsHeaders);
  }
  try {
    const body = await request.text();
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetchWithTimeout(targetUrl, { method: "POST", headers, body }, 120000);
    const responseHeaders = new Headers(corsHeaders);
    const ct = res.headers.get("content-type");
    if (ct) responseHeaders.set("Content-Type", ct);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: responseHeaders });
  } catch (err) {
    return jsonResponse({ error: { message: err.message || "Proxy error" } }, 502, corsHeaders);
  }
}

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
