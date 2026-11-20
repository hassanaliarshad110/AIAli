import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freshDataDir, startApp } from './helpers.js';
import { EXTRACT } from './mocks.js';

const dir = freshDataDir('mcp');
const app = await startApp();
const { mcpToken } = await import('../src/config.js');
after(() => app.close());
const rpc = (body, token = mcpToken()) => fetch(`${app.base}/mcp/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });

test('wrong token is a 404', async () => {
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'nope')).status, 404);
});

test('initialize, list tools, call tools', async () => {
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'ai-ali');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  const names = list.result.tools.map((t) => t.name);
  assert.ok(names.includes('propose_bill') && !names.includes('approve_and_post'));
  assert.ok(list.result.tools.every((t) => t.inputSchema?.type === 'object'));
  const sum = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ap_summary', arguments: {} } })).json();
  assert.equal(sum.result.structuredContent.currency, 'CAD');
  const prop = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'propose_bill', arguments: EXTRACT['northwind-INV-10458.pdf'].d } })).json();
  assert.equal(prop.result.structuredContent.queued, true);
  const q = (await app.j('/api/queue?status=pending')).body.items[0];
  assert.match(q.proposedBy, /^mcp:/);
  const bad = await (await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } })).json();
  assert.equal(bad.error.code, -32602);
  const batch = await (await rpc([{ jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '2.0', id: 7, method: 'tools/list' }])).json();
  assert.equal(batch.length, 2);
});

test('stdio server works for Claude Desktop / Claude Code', async () => {
  const p = spawn(process.execPath, ['src/mcp-stdio.js'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, AP_DATA_DIR: dir } });
  const lines = [];
  p.stdout.on('data', (d) => lines.push(...d.toString().trim().split('\n')));
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approval_queue', arguments: {} } }) + '\n');
  await new Promise((r) => setTimeout(r, 700));
  p.kill();
  const out = lines.map((l) => JSON.parse(l));
  assert.equal(out.length, 2);
  assert.equal(out[0].result.protocolVersion, '2024-11-05');
  assert.equal(out[1].result.structuredContent.items[0].invoice_number, 'INV-10458');
});
