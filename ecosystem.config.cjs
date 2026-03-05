/**
 * ecosystem.config.cjs — PM2 process definition for MindStone sync daemon
 *
 * WHY .cjs EXTENSION:
 *   .daemon/package.json has "type": "module" (ESM). PM2 uses require() to load
 *   ecosystem files. A .js file in an ESM package fails with ERR_REQUIRE_ESM.
 *   Using .cjs forces CommonJS parsing regardless of package.json type.
 *
 * ENV VARS:
 *   Do NOT add env vars here. dotenv inside daemon.js loads .daemon/.env at
 *   startup — that file is the single source of truth for all configuration.
 *   Duplicating vars here creates drift and confusion.
 *
 * PREREQUISITES:
 *   .intelligence/ must be built before starting the daemon, because daemon.js
 *   imports from .intelligence/dist/. Run: cd .intelligence && npm run build
 *
 * FIRST-TIME SETUP:
 *   cp .daemon/.env.example .daemon/.env   # then fill in your values
 *   cd .intelligence && npm run build      # required: daemon imports from dist/
 *   pm2 start ecosystem.config.cjs
 *   pm2 save                               # persist across reboots
 *   pm2 startup                            # print command to register on system boot
 */

module.exports = {
  apps: [
    {
      name: 'mindstone-daemon',
      script: './.daemon/daemon.js',

      // cwd is the repo root — daemon.js uses paths relative to this
      cwd: __dirname,

      // Disable file watching — daemon manages its own chokidar watcher internally
      watch: false,

      // Restart policy
      max_memory_restart: '256M',
      restart_delay: 5000,
      max_restarts: 10,

      // Log files (written to .daemon/.sync/ so they sit next to daemon.log)
      out_file: './.daemon/.sync/pm2-out.log',
      error_file: './.daemon/.sync/pm2-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Only NODE_ENV here — all other vars loaded by dotenv from .daemon/.env
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
