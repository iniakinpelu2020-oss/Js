export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok', protocol: 'mcp-jsonrpc-2.0' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { id = 1, method, params = {} } = body;

    const reply = (result) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    if (method === 'initialize') {
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'apex-cloudflare-mcp', version: '1.0.0' },
      });
    }

    if (method === 'tools/list') {
      return reply({
        tools: [
          {
            name: 'fetch_url_text',
            description: 'Fetch clean text content from any public URL or API endpoint',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string', description: 'Full https:// URL to fetch' } },
              required: ['url'],
            },
          },
          {
            name: 'github_repo_lookup',
            description: 'Get metadata, stars, default branch, and description of a public GitHub repository',
            inputSchema: {
              type: 'object',
              properties: { repo: { type: 'string', description: 'owner/repo format, e.g. torvalds/linux' } },
              required: ['repo'],
            },
          },
        ],
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;

      if (name === 'fetch_url_text') {
        const res = await fetch(args.url, { headers: { 'User-Agent': 'Apex-MCP/1.0' } });
        const text = (await res.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
        return reply({ content: [{ type: 'text', text }] });
      }

      if (name === 'github_repo_lookup') {
        const repoPath = args.owner && args.repo && !String(args.repo).includes('/')
          ? `${args.owner}/${args.repo}`
          : args.repo;
        const headers = { 'User-Agent': 'Apex-MCP/1.0', Accept: 'application/vnd.github+json' };
        if (env?.GITHUB_TOKEN) headers['Authorization'] = `token ${env.GITHUB_TOKEN.trim()}`;
        const res = await fetch(`https://api.github.com/repos/${repoPath}`, { headers });
        const data = await res.json();
        return reply({
          content: [{
            type: 'text',
            text: JSON.stringify({ hasToken: Boolean(env?.GITHUB_TOKEN), ...data }, null, 2).slice(0, 6000)
          }]
        });
      }

      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return reply({});
  },
};
                  
