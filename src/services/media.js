import fs from 'node:fs';
import path from 'node:path';
import { randomToken } from '../crypto.js';
import { ValidationError } from '../lib/errors.js';

const TYPES = {
  'image/jpeg': { max: 5 * 1024 * 1024, magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { max: 5 * 1024 * 1024, magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { max: 5 * 1024 * 1024, magic: (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' },
  'image/gif': { max: 15 * 1024 * 1024, magic: (b) => b.subarray(0, 4).toString() === 'GIF8' },
};
export const MEDIA_TYPES = Object.keys(TYPES);

export function createMediaService({ db, config }) {
  const get = (id) => db.prepare('SELECT * FROM media WHERE id = ?').get(String(id));

  function save(data, mime) {
    const type = TYPES[mime];
    if (!type) throw new ValidationError('Images must be JPEG, PNG, WebP or GIF');
    if (!Buffer.isBuffer(data) || !data.length) throw new ValidationError('Empty upload');
    if (data.length > type.max) throw new ValidationError(`That image is too large (max ${type.max / 1024 / 1024} MB)`);
    if (!type.magic(data)) throw new ValidationError('The file content does not match its image type');
    fs.mkdirSync(config.mediaDir, { recursive: true });
    const id = randomToken(16);
    const file = path.join(config.mediaDir, id);
    fs.writeFileSync(file, data);
    db.prepare('INSERT INTO media (id, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, mime, data.length, file, Date.now());
    return { id, mime, size: data.length };
  }

  // Removes uploads older than a week that no unfinished post uses.
  function cleanup(now = Date.now()) {
    const inUse = new Set(db.prepare("SELECT media FROM posts WHERE media IS NOT NULL AND status IN ('draft', 'scheduled', 'posting', 'failed')")
      .all().flatMap((r) => JSON.parse(r.media)));
    for (const m of db.prepare('SELECT * FROM media WHERE created_at < ?').all(now - 7 * 24 * 60 * 60 * 1000)) {
      if (inUse.has(m.id)) continue;
      fs.rmSync(m.path, { force: true });
      db.prepare('DELETE FROM media WHERE id = ?').run(m.id);
    }
  }

  return { get, save, cleanup };
}
