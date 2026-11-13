export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, mcp-session-id",
      "Access-Control-Expose-Headers": "mcp-session-id"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ==========================================
    // 1. n8n Cloud MCP CORS Proxy (/n8n-mcp)
    // ==========================================
    if (url.pathname === "/n8n-mcp") {
      try {
        const upstreamHeaders = new Headers();
        upstreamHeaders.set("Accept", "application/json, text/event-stream");
        upstreamHeaders.set("Content-Type", request.headers.get("Content-Type") || "application/json");

        if (request.headers.get("Authorization")) {
          upstreamHeaders.set("Authorization", request.headers.get("Authorization"));
        }
        if (request.headers.get("mcp-session-id")) {
          upstreamHeaders.set("mcp-session-id", request.headers.get("mcp-session-id"));
        }

        const upstream = await fetch("https://drippydee.app.n8n.cloud/mcp-server/http", {
          method: request.method,
          headers: upstreamHeaders,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
        });

        const respHeaders = new Headers(upstream.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => respHeaders.set(k, v));

        return new Response(upstream.body, {
          status: upstream.status,
          headers: respHeaders
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // ==========================================
    // 2. Apex Built-in MCP Server (/)
    // ==========================================
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "apex-mcp",
        routes: ["/", "/n8n-mcp"]
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    try {
      const body = await request.json();
      const { id, method, params } = body;

      if (method === "initialize") {
        return jsonRpc(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "apex-mcp", version: "1.0.0" }
        }, corsHeaders);
      }

      if (method === "notifications/initialized") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (method === "tools/list") {
        return jsonRpc(id, {
          tools: [
            {
              name: "fetch_url_text",
              description: "Fetch clean text content from any public URL or API endpoint",
              inputSchema: {
                type: "object",
                properties: {
                  url: { type: "string", description: "The URL to fetch" }
                },
                required: ["url"]
              }
            }
          ]
        }, corsHeaders);
      }

      if (method === "tools/call") {
        const toolName = params?.name;
        const args = params?.arguments || {};

        if (toolName === "fetch_url_text") {
          const res = await fetch(args.url, {
            headers: { "User-Agent": "Apex-IDE-MCP/1.0" }
          });
          const raw = await res.text();
          const clean = raw
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 15000);

          return jsonRpc(id, {
            content: [{ type: "text", text: clean }]
          }, corsHeaders);
        }

        return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`, corsHeaders);
      }

      return jsonRpcError(id, -32601, `Method not found: ${method}`, corsHeaders);
    } catch (err) {
      return jsonRpcError(null, -32700, err.message, corsHeaders);
    }
  }
};

function jsonRpc(id, result, headers) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

function jsonRpcError(id, code, message, headers) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status: 200,
    headers: { ...headers, "Content-Type": "application/json" }
  });
  }
                     
