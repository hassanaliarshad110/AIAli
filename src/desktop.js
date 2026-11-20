#!/usr/bin/env node
// Desktop launcher: what the AI Ali icon runs. Keeps data in the user's profile, starts the app if it isn't running,
// and opens it in the default browser. Double-clicking the icon again just opens the browser.
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config'));
process.env.AP_DATA_DIR ||= path.join(appData, 'AI Ali');
process.title = 'AI Ali';
const port = Number(process.env.PORT || 8787);
const url = `http://localhost:${port}`;

function openBrowser() {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function alreadyRunning() {
  try {
    const r = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return !!j?.ledger;
  } catch { return false; }
}

if (await alreadyRunning()) {
  openBrowser();
  process.exit(0);
}

const { start } = await import('./server.js');
try {
  await start({ port, quiet: true });
} catch (e) {
  console.error(e.code === 'EADDRINUSE'
    ? `\n  Another program is using port ${port}, so AI Ali can't start.\n  Close that program, or set PORT in a .env file next to AI Ali, then try again.\n`
    : `\n  AI Ali couldn't start: ${e.message}\n`);
  setTimeout(() => process.exit(1), 15000);
}
console.log(`
  ┌──────────────────────────────────────────────────────────┐
  │  AI Ali is running at ${url.padEnd(35)}│
  │                                                          │
  │  Keep this window open. You can minimise it.             │
  │  Close it to stop AI Ali.                                │
  └──────────────────────────────────────────────────────────┘
  Your data: ${process.env.AP_DATA_DIR}
`);
openBrowser();
