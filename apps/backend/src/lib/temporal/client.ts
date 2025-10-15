/**
 * Temporal client wrapper
 * Provides typed methods for starting workflows
 */

import type { WorkflowClient } from "@temporalio/client";
import { createTemporalClient, getTaskQueue } from "./config";
import {
  frameGenerationWorkflow,
  motionGenerationWorkflow,
  scriptAnalysisWorkflow,
} from "./workflows";

/**
 * Temporal client service
 */
export class TemporalClientService {
  private client: WorkflowClient | null = null;

  /**
   * Get or create Temporal client
   */
  private async getClient(): Promise<WorkflowClient> {
    if (!this.client) {
      this.client = await createTemporalClient();
    }
    return this.client;
  }

  /**
   * Start frame generation workflow
   */
  async startFrameGeneration(params: {
    jobId: string;
    frameId: string;
    sequenceId: string;
    teamId: string;
    userId?: string;
    model: string;
    prompt: string;
    width?: number;
    height?: number;
    negativePrompt?: string;
    numInferenceSteps?: number;
    guidanceScale?: number;
    seed?: number;
    loraUrl?: string;
    loraScale?: number;
  }): Promise<{ workflowId: string; runId: string }> {
    const client = await this.getClient();

    const handle = await client.start(frameGenerationWorkflow, {
      taskQueue: getTaskQueue(),
      workflowId: `frame-generation-${params.jobId}`,
      args: [params],
    });

    return {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    };
  }

  /**
   * Start motion generation workflow
   */
  async startMotionGeneration(params: {
    jobId: string;
    frameId: string;
    sequenceId: string;
    teamId: string;
    userId?: string;
    model: string;
    imageUrl: string;
    prompt?: string;
    duration?: number;
    fps?: number;
    motionBucket?: number;
    seed?: number;
    loraUrl?: string;
    loraScale?: number;
  }): Promise<{ workflowId: string; runId: string }> {
    const client = await this.getClient();

    const handle = await client.start(motionGenerationWorkflow, {
      taskQueue: getTaskQueue(),
      workflowId: `motion-generation-${params.jobId}`,
      args: [params],
    });

    return {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    };
  }

  /**
   * Start script analysis workflow
   */
  async startScriptAnalysis(params: {
    jobId: string;
    sequenceId: string;
    teamId: string;
    userId?: string;
    script: string;
    framesPerScene?: number;
  }): Promise<{ workflowId: string; runId: string }> {
    const client = await this.getClient();

    const handle = await client.start(scriptAnalysisWorkflow, {
      taskQueue: getTaskQueue(),
      workflowId: `script-analysis-${params.jobId}`,
      args: [params],
    });

    return {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    };
  }

  /**
   * Get workflow status
   */
  async getWorkflowStatus(workflowId: string): Promise<{
    status: "running" | "completed" | "failed" | "cancelled";
    result?: unknown;
    error?: string;
  }> {
    const client = await this.getClient();

    try {
      const handle = client.getHandle(workflowId);
      const description = await handle.describe();

      if (description.status.name === "RUNNING") {
        return { status: "running" };
      }

      if (description.status.name === "COMPLETED") {
        const result = await handle.result();
        return { status: "completed", result };
      }

      if (description.status.name === "FAILED") {
        return {
          status: "failed",
          error: "Workflow failed",
        };
      }

      if (description.status.name === "CANCELLED") {
        return { status: "cancelled" };
      }

      return { status: "running" };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Cancel workflow
   */
  async cancelWorkflow(workflowId: string): Promise<void> {
    const client = await this.getClient();
    const handle = client.getHandle(workflowId);
    await handle.cancel();
  }
}

// Singleton instance
let temporalClientInstance: TemporalClientService | null = null;

/**
 * Get Temporal client service instance
 */
export function getTemporalClient(): TemporalClientService {
  if (!temporalClientInstance) {
    temporalClientInstance = new TemporalClientService();
  }
  return temporalClientInstance;
}
