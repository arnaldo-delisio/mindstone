import chokidar from 'chokidar';
import { logger } from './logger.js';
import { config } from './config.js';
import { ConflictResolver } from './conflict-resolver.js';

export function createWatcher({ onAdd, onChange, onUnlink, onError, recentlySyncedFiles }) {
  // Initialize conflict resolver for auto-deletion
  const conflictResolver = new ConflictResolver();

  const watcher = chokidar.watch(config.vault.path, {
    ignored: [
      (filePath) => {          // Ignore dotfiles, except whitelisted dot-directories
        // Strip vault path prefix — normalize to handle trailing slash or not
        const base = config.vault.path.endsWith('/') ? config.vault.path : config.vault.path + '/';
        const rel = filePath.startsWith(base) ? filePath.slice(base.length) : filePath.replace(config.vault.path, '');
        if (rel.startsWith('.personas/') || rel === '.personas') return false;
        if (rel.startsWith('.claude/') || rel === '.claude') return false;
        return /(^|[\/\\])\./.test(filePath);
      },
      /\.sync\//,             // Ignore .sync/ directory
      /\.cache\//,            // Ignore .cache/ directory
      /\.temp\//,             // Ignore .temp/ directory (screenshots, temp files)
      /\.git\//,              // Ignore .git/ directory
      /\.conflict-\d+\./,     // Ignore conflict files (*.conflict-{timestamp}.*)
      /supabase\//,           // Ignore supabase/ directory (migrations, functions, config)
      /\.daemon\//,           // Ignore .daemon/ directory (daemon source code)
      /node_modules\//,       // Ignore node_modules/ directory
      /package(-lock)?\.json$/, // Ignore package.json and package-lock.json
      (filePath) => {                                                         // Ignore non-.md files (ts, tsx, js, json, png, etc.)
        const base = config.vault.path.endsWith('/') ? config.vault.path : config.vault.path + '/';
        const rel = filePath.startsWith(base) ? filePath.slice(base.length) : filePath.replace(config.vault.path, '');
        if (rel.startsWith('.personas/') || rel === '.personas') return false;
        if (rel.startsWith('.claude/') || rel === '.claude') return false;
        return !filePath.endsWith('.md') && /\.[^./]+$/.test(filePath);
      }
    ],
    persistent: true,
    ignoreInitial: false,      // Process existing files on startup
    awaitWriteFinish: {
      stabilityThreshold: config.daemon.stabilityThreshold, // 50ms
      pollInterval: config.daemon.pollInterval              // 10ms
    },
    depth: 99,                 // Deep directory traversal
    usePolling: false          // Use native fs.watch (better performance)
  });

  watcher
    .on('add', async (path) => {
      logger.debug({ path }, 'File added');
      try {
        // Check if this file was just synced during initial sync
        // Prevents race condition where watcher uploads local files over fresh cloud changes
        if (recentlySyncedFiles && recentlySyncedFiles.has(path)) {
          logger.info({ path }, 'File recently synced from cloud, ignoring add event');
          return;
        }

        // Skip MOCs - they're auto-generated and read-only (never upload)
        if (path.includes('/mocs/') || path.startsWith('mocs/')) {
          logger.debug({ path }, 'Skipping MOC file (auto-generated, read-only)');
          return;
        }

        // Regular file upload (Phase 1 logic)
        await onAdd(path);
      } catch (error) {
        logger.error({ path, error }, 'Error handling file add');
        if (onError) onError(error);
      }
    })
    .on('change', async (path) => {
      logger.debug({ path }, 'File changed');
      try {
        // Skip MOCs - they're auto-generated and read-only (never upload)
        if (path.includes('/mocs/') || path.startsWith('mocs/')) {
          logger.debug({ path }, 'Skipping MOC file (auto-generated, read-only)');
          return;
        }

        // FIRST: Auto-delete conflict files BEFORE upload starts
        // User has edited main file, so conflict files are now obsolete
        await conflictResolver.autoDeleteConflictFiles(path);

        // THEN: Proceed with normal upload flow
        await onChange(path);
      } catch (error) {
        logger.error({ path, error }, 'Error handling file change');
        if (onError) onError(error);
      }
    })
    .on('unlink', async (path) => {
      logger.debug({ path }, 'File deleted');
      try {
        await onUnlink(path);
      } catch (error) {
        logger.error({ path, error }, 'Error handling file delete');
        if (onError) onError(error);
      }
    })
    .on('error', (error) => {
      logger.error({ error }, 'Watcher error');
      if (onError) onError(error);
    });

  logger.info({ path: config.vault.path }, 'File watcher started');

  return watcher;
}
