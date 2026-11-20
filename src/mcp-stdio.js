#!/usr/bin/env node
// Run the AP tools as a local MCP server for Claude Desktop, Claude Code or any stdio MCP client.
// Uses the same settings and data folder as the web app.
import readline from 'node:readline';
import { mcpHandle } from './mcp.js';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
  const out = await mcpHandle(msg, { client: 'stdio' });
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
});
// Keep stdout clean for the protocol.
console.log = (...a) => process.stderr.write(a.join(' ') + '\n');
