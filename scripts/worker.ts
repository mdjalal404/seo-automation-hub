/**
 * Background job worker. Polls the persistent Postgres queue, so jobs survive
 * restarts; multiple workers can run safely (claims use SKIP-LOCKED semantics,
 * per-website advisory locks and leases).
 *
 *   npm run worker            # loop forever
 *   npm run worker -- --once  # process due jobs once and exit (for cron-style hosts)
 */
import { logger } from "../lib/observability/logger";
import { runWorkerBatch } from "../lib/publishing/processor";
import { createProcessorDeps } from "../lib/publishing/worker";
import { configurationProblems } from "../lib/env";

const once = process.argv.includes("--once");
const interval = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
let stopping = false;

async function main() {
  const problems = configurationProblems();
  if (problems.length) {
    console.error(`Worker cannot start. Missing configuration:\n - ${problems.join("\n - ")}`);
    process.exit(1);
  }
  const deps = createProcessorDeps("worker");
  logger.info("worker.started", { workerId: deps.workerId, interval, once });
  for (;;) {
    try {
      const r = await runWorkerBatch(deps, { maxJobs: 25, timeBudgetMs: 55_000 });
      if (r.processed || r.reaped) logger.info("worker.batch", r);
    } catch (err) {
      logger.error("worker.batch_failed", { error: err });
    }
    if (once || stopping) break;
    await new Promise((r) => setTimeout(r, interval));
    if (stopping) break;
  }
  logger.info("worker.stopped", {});
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    // Finish the current job; leases cover hard kills.
    stopping = true;
  });
}

main();
