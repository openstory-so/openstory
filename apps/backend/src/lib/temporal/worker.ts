/**
 * Temporal worker script
 * Runs Temporal worker to process workflows
 */

import { createTemporalWorker } from "./config";

/**
 * Start Temporal worker
 */
async function startWorker() {
  console.log("[Temporal Worker] Starting...");

  try {
    const worker = await createTemporalWorker();

    console.log("[Temporal Worker] Worker created successfully");
    console.log("[Temporal Worker] Listening for tasks...");

    // Run the worker
    await worker.run();
  } catch (error) {
    console.error("[Temporal Worker] Failed to start:", error);
    process.exit(1);
  }
}

// Start worker if this file is run directly
if (require.main === module) {
  startWorker().catch((error) => {
    console.error("[Temporal Worker] Fatal error:", error);
    process.exit(1);
  });
}

export { startWorker };

