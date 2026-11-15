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

    // AI chat endpoint (/api/chat) — proxies through Cloudflare Workers AI binding
    if (request.method === "POST" && url.pathname === "/api/chat") {
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

    return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  },
};

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
    ...(max_tokens !== undefined ? { max_tokens } : {}),
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
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = parsed.response || parsed.text || parsed.delta || parsed.choices?.[0]?.delta || {};
          const out = JSON.stringify({
            id: "chatcmpl-worker",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "@cf/qwen/qwen2.5-coder-32b-instruct",
            choices: [{ index: 0, delta, finish_reason: null }],
          });
          await writer.write(encoder.encode(`data: ${out}\n\n`));
        }
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
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
