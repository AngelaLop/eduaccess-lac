/**
 * Worker entry point. Loads env, runs a full audit, exits.
 *
 * Local dev:
 *   pnpm --filter worker start                       # full run
 *   AUDIT_CELL_LIMIT=10 pnpm --filter worker start   # smoke test
 *   AUDIT_DRY_RUN=true  pnpm --filter worker start   # no LLM, no writes
 *
 * Railway: configure as a cron service. The script is process-exit safe.
 */

import { config as loadEnv } from 'dotenv';

// Load env before anything else imports supabase/llm clients (ESM hoisting:
// static imports of those modules would run BEFORE dotenv.config()).
loadEnv({ path: '.env' });
loadEnv({ path: '.env.local', override: false });

const { runFullAudit } = await import('./audit.js');

runFullAudit()
  .then((res) => {
    console.log(`[worker] exiting cleanly: ${JSON.stringify(res)}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
