/**
 * Temporal configuration
 * Connection settings for Temporal server and workers
 */

import { Connection, WorkflowClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { VelroError } from "@/plugins/error";

// Temporal server configuration
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS || "localhost:7233";
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE || "default";
const TASK_QUEUE = "velro-jobs";

/**
 * Create Temporal client connection
 */
export async function createTemporalClient(): Promise<WorkflowClient> {
  try {
    const connection = await Connection.connect({
      address: TEMPORAL_ADDRESS,
    });

    const client = new WorkflowClient({
      connection,
      namespace: TEMPORAL_NAMESPACE,
    });

    return client;
  } catch (error) {
    throw new VelroError(
      `Failed to connect to Temporal server: ${error instanceof Error ? error.message : "Unknown error"}`,
      500,
      "TEMPORAL_CONNECTION_ERROR",
    );
  }
}

/**
 * Create Temporal worker
 */
export async function createTemporalWorker(): Promise<Worker> {
  try {
    const connection = await NativeConnection.connect({
      address: TEMPORAL_ADDRESS,
    });

    const worker = await Worker.create({
      connection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("./workflows"),
      activities: require("./activities"),
    });

    return worker;
  } catch (error) {
    throw new VelroError(
      `Failed to create Temporal worker: ${error instanceof Error ? error.message : "Unknown error"}`,
      500,
      "TEMPORAL_WORKER_ERROR",
    );
  }
}

/**
 * Get task queue name
 */
export function getTaskQueue(): string {
  return TASK_QUEUE;
}

/**
 * Get Temporal namespace
 */
export function getNamespace(): string {
  return TEMPORAL_NAMESPACE;
}
