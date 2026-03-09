import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { logger } from './logger.js';

export async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => {
      const digest = hash.digest('hex');
      logger.debug({ filePath, digest }, 'File hashed');
      resolve(digest);
    });
    stream.on('error', reject);
  });
}
