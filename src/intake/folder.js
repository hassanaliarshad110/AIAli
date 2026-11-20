// Watched folder: any PDF or image dropped into a folder on this computer (or a synced OneDrive / Google Drive / Dropbox folder).
import fs from 'node:fs';
import path from 'node:path';
import { get, bool } from '../config.js';

const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const dir = () => (get('WATCH_FOLDER') || '').replace(/^~(?=$|[/\\])/, process.env.HOME || process.env.USERPROFILE || '~');

export const folder = {
  key: 'folder',
  label: 'Folder',
  connected: () => !!dir(),
  account: () => dir(),
  check() {
    const d = dir();
    if (!d) return 'No folder set.';
    if (!fs.existsSync(d)) return `Folder not found: ${d}`;
    if (!fs.statSync(d).isDirectory()) return `Not a folder: ${d}`;
    return null;
  },
  async *fetch() {
    const d = dir();
    const problem = this.check();
    if (problem) throw new Error(problem);
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const type = TYPES[path.extname(name).toLowerCase()];
      if (!type || name.startsWith('.') || name.startsWith('~$')) continue;
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (Date.now() - st.mtimeMs < 5000) continue; // still being copied: pick it up next time
      yield {
        key: null, // folder files are recognised by their content (sha256), so renaming a file doesn't re-process it
        name, type, size: st.size, inline: false, from: d, subject: '', receivedAt: st.mtime.toISOString(),
        load: async () => fs.readFileSync(full),
        done: () => {
          if (!bool('MOVE_PROCESSED')) return;
          const out = path.join(d, 'processed');
          fs.mkdirSync(out, { recursive: true });
          let target = path.join(out, name);
          if (fs.existsSync(target)) target = path.join(out, `${Date.now()}-${name}`);
          fs.renameSync(full, target);
        },
      };
    }
  },
};
