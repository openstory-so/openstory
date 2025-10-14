/**
 * Jobs service
 * Business logic for async job management via Temporal
 */

import { db } from "@/db";
import { jobs } from "@/db/schema/jobs";
import { getTemporalClient } from "@/lib/temporal";
import { eq, and, desc } from "drizzle-orm";
import type { User } from "@/lib/auth";
import { VelroError } from "@/plugins/error";
import { canAccessTeam } from "@/lib/auth/rbac";

/**
 * Jobs service class
 */
export class JobsService {
  /**
   * Create and start a frame generation job
   */
  static async createFrameGenerationJob(
    params: {
      frameId: string;
      sequenceId: string;
      teamId: string;
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
    },
    user: User
  ) {
    // Check team access
    const hasAccess = await canAccessTeam(user, params.teamId);
    if (!hasAccess) {
      throw new VelroError("Access denied to team", 403, "FORBIDDEN");
    }

    // Create job record
    const [job] = await db
      .insert(jobs)
      .values({
        teamId: params.teamId,
        userId: user.id,
        type: "frame_generation",
        status: "pending",
        payload: params,
      })
      .returning();

    // Start Temporal workflow
    const temporalClient = getTemporalClient();
    const { workflowId, runId } = await temporalClient.startFrameGeneration({
      jobId: job!.id,
      ...params,
      userId: user.id,
    });

    // Update job with workflow IDs
    await db
      .update(jobs)
      .set({
        workflowId,
        runId,
      })
      .where(eq(jobs.id, job!.id));

    return {
      ...job,
      workflowId,
      runId,
    };
  }

  /**
   * Create and start a motion generation job
   */
  static async createMotionGenerationJob(
    params: {
      frameId: string;
      sequenceId: string;
      teamId: string;
      model: string;
      imageUrl: string;
      prompt?: string;
      duration?: number;
      fps?: number;
      motionBucket?: number;
      seed?: number;
      loraUrl?: string;
      loraScale?: number;
    },
    user: User
  ) {
    // Check team access
    const hasAccess = await canAccessTeam(user, params.teamId);
    if (!hasAccess) {
      throw new VelroError("Access denied to team", 403, "FORBIDDEN");
    }

    // Create job record
    const [job] = await db
      .insert(jobs)
      .values({
        teamId: params.teamId,
        userId: user.id,
        type: "motion",
        status: "pending",
        payload: params,
      })
      .returning();

    // Start Temporal workflow
    const temporalClient = getTemporalClient();
    const { workflowId, runId } = await temporalClient.startMotionGeneration({
      jobId: job!.id,
      ...params,
      userId: user.id,
    });

    // Update job with workflow IDs
    await db
      .update(jobs)
      .set({
        workflowId,
        runId,
      })
      .where(eq(jobs.id, job!.id));

    return {
      ...job,
      workflowId,
      runId,
    };
  }

  /**
   * Create and start a script analysis job
   */
  static async createScriptAnalysisJob(
    params: {
      sequenceId: string;
      teamId: string;
      script: string;
      framesPerScene?: number;
    },
    user: User
  ) {
    // Check team access
    const hasAccess = await canAccessTeam(user, params.teamId);
    if (!hasAccess) {
      throw new VelroError("Access denied to team", 403, "FORBIDDEN");
    }

    // Create job record
    const [job] = await db
      .insert(jobs)
      .values({
        teamId: params.teamId,
        userId: user.id,
        type: "script",
        status: "pending",
        payload: params,
      })
      .returning();

    // Start Temporal workflow
    const temporalClient = getTemporalClient();
    const { workflowId, runId } = await temporalClient.startScriptAnalysis({
      jobId: job!.id,
      ...params,
      userId: user.id,
    });

    // Update job with workflow IDs
    await db
      .update(jobs)
      .set({
        workflowId,
        runId,
      })
      .where(eq(jobs.id, job!.id));

    return {
      ...job,
      workflowId,
      runId,
    };
  }

  /**
   * Get job by ID
   */
  static async getJob(jobId: string, user: User) {
    const job = await db.query.jobs.findFirst({
      where: eq(jobs.id, jobId),
    });

    if (!job) {
      throw new VelroError("Job not found", 404, "NOT_FOUND");
    }

    // Check team access
    if (job.teamId) {
      const hasAccess = await canAccessTeam(user, job.teamId);
      if (!hasAccess) {
        throw new VelroError("Access denied to job", 403, "FORBIDDEN");
      }
    }

    return job;
  }

  /**
   * List jobs for a team
   */
  static async listJobs(
    params: {
      teamId: string;
      type?: string;
      status?: string;
      limit?: number;
      offset?: number;
    },
    user: User
  ) {
    // Check team access
    const hasAccess = await canAccessTeam(user, params.teamId);
    if (!hasAccess) {
      throw new VelroError("Access denied to team", 403, "FORBIDDEN");
    }

    // Build query
    // Build where conditions
    const conditions = [eq(jobs.teamId, params.teamId)];

    if (params.type) {
      conditions.push(eq(jobs.type, params.type as any));
    }

    if (params.status) {
      conditions.push(eq(jobs.status, params.status as any));
    }

    const jobsList = await db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.createdAt))
      .limit(params.limit || 50)
      .offset(params.offset || 0);

    return jobsList;
  }

  /**
   * Cancel job
   */
  static async cancelJob(jobId: string, user: User) {
    const job = await this.getJob(jobId, user);

    if (job.status === "completed" || job.status === "failed") {
      throw new VelroError("Cannot cancel completed or failed job", 400, "BAD_REQUEST");
    }

    // Cancel Temporal workflow
    if (job.workflowId) {
      const temporalClient = getTemporalClient();
      await temporalClient.cancelWorkflow(job.workflowId);
    }

    // Update job status
    await db
      .update(jobs)
      .set({
        status: "cancelled",
        completedAt: new Date(),
      })
      .where(eq(jobs.id, jobId));

    return { success: true };
  }
}

