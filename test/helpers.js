import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each test file gets its own empty data folder, set before any app module is imported.
export function freshDataDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `apagent-${name}-`));
  process.env.AP_DATA_DIR = dir;
  return dir;
}

export async function startApp() {
  const { createServer } = await import('../src/server.js');
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const j = async (p, opts = {}) => { const r = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const ndjson = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  };
  const upload = async (file) => {
    const buf = fs.readFileSync(path.join(import.meta.dirname, '..', 'samples', file));
    const r = await fetch(base + '/api/upload', { method: 'POST', headers: { 'content-type': file.endsWith('.png') ? 'image/png' : 'application/pdf', 'x-filename': file }, body: buf });
    return r.json();
  };
  return { base, j, ndjson, upload, close: () => s.close() };
}
