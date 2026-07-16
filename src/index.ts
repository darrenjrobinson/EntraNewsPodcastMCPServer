#!/usr/bin/env node

import { createServer } from './server.js';

async function main(): Promise<void> {
  process.stderr.write('[entra-news-podcast-mcp] Starting Entra.Chat podcast MCP server...\n');

  try {
    const { server, transport } = await createServer();
    await server.connect(transport);
    process.stderr.write('[entra-news-podcast-mcp] Server running on stdio. Ready for MCP connections.\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[entra-news-podcast-mcp] Fatal error: ${message}\n`);
    process.exit(1);
  }
}

main();
