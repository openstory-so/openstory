/**
 * Job management service for QStash async jobs
 * Handles job creation, status updates, and event tracking
 */

import { z } from "zod";
import { DatabaseError, ValidationError, VelroError } from "@/lib/errors";
import { createAdminClient } from "@/lib/supabase/server";
import type { Job, JobInsert, JobUpdate } from "@/types/database";

// Job status enum matching database
export const JobStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type JobStatusType = (typeof JobStatus)[keyof typeof JobStatus];

// Job types
export const JobType = {
  IMAGE: "image",
  VIDEO: "video",
  SCRIPT: "script",
  FRAME_GENERATION: "frame_generation",
  MOTION: "motion",
} as const;

export type JobTypeType = (typeof JobType)[keyof typeof JobType];

// Zod schemas for validation
export const createJobSchema = z.object({
  type: z
    .literal("image")
    .or(z.literal("video"))
    .or(z.literal("script"))
    .or(z.literal("frame_generation"))
    .or(z.literal("motion")),
  payload: z.record(z.string(), z.unknown()),
  userId: z.uuid().optional(),
  teamId: z.uuid().optional(),
});

export const updateJobSchema = z.object({
  status: z
    .literal("pending")
    .or(z.literal("running"))
    .or(z.literal("completed"))
    .or(z.literal("failed"))
    .or(z.literal("cancelled")),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
});

export interface JobWithEvents extends Job {
  events?: JobEvent[];
}

export interface JobEvent {
  id: string;
  jobId: string;
  event: string;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export interface CreateJobParams {
  type: JobTypeType;
  payload: Record<string, unknown>;
  userId?: string;
  teamId?: string;
}

export interface UpdateJobParams {
  status: JobStatusType;
  result?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

class JobManager {
  private supabase = createAdminClient();

  /**
   * Create a new job record in the database
   */
  async createJob(params: CreateJobParams): Promise<Job> {
    try {
      // Validate input
      const validatedParams = createJobSchema.parse(params);

      const jobData: JobInsert = {
        type: validatedParams.type,
        status: JobStatus.PENDING,
        payload: validatedParams.payload as JobInsert["payload"],
        user_id: validatedParams.userId || null,
        team_id: validatedParams.teamId || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await this.supabase
        .from("jobs")
        .insert(jobData)
        .select()
        .single();

      if (error) {
        console.error("[JobManager] Failed to create job", { error });
        throw new DatabaseError("Failed to create job", {
          supabaseError: error.message,
          code: error.code,
        });
      }

      // Log the creation event
      await this.logJobEvent(data.id, "job.created", {
        type: data.type,
        userId: params.userId,
        teamId: params.teamId,
      });

      return data;
    } catch (error) {
      console.error("[JobManager] Error creating job", { error });

      if (error instanceof VelroError) {
        throw error;
      }

      if (error instanceof z.ZodError) {
        throw new ValidationError("Invalid job parameters", {
          validationErrors: error.issues,
        });
      }

      throw new VelroError("Failed to create job", "JOB_CREATION_ERROR", 500, {
        originalError: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Get a job by ID with optional events
   */
  async getJob(
    jobId: string,
    includeEvents = false,
  ): Promise<JobWithEvents | null> {
    try {
      const { data, error } = await this.supabase
        .from("jobs")
        .select("*")
        .eq("id", jobId)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          // No rows returned
          return null;
        }

        console.error("[JobManager] Failed to get job", { error, jobId });
        throw new DatabaseError("Failed to get job", {
          supabaseError: error.message,
          code: error.code,
          jobId,
        });
      }

      const jobWithEvents: JobWithEvents = data;

      if (includeEvents) {
        // TODO: Add job events query once job_events table is available
        // For now, just return the job without events
        jobWithEvents.events = [];
      }

      return jobWithEvents;
    } catch (error) {
      console.error("[JobManager] Error getting job", { error, jobId });

      if (error instanceof VelroError) {
        throw error;
      }

      throw new VelroError("Failed to get job", "JOB_RETRIEVAL_ERROR", 500, {
        originalError: error instanceof Error ? error.message : "Unknown error",
        jobId,
      });
    }
  }

  /**
   * Update job status and metadata
   */
  async updateJob(jobId: string, updates: UpdateJobParams): Promise<Job> {
    try {
      // Validate input
      const validatedUpdates = updateJobSchema.parse(updates);

      const jobUpdate: JobUpdate = {
        status: validatedUpdates.status,
        updated_at: new Date().toISOString(),
      };

      if (validatedUpdates.result) {
        jobUpdate.result = validatedUpdates.result as JobUpdate["result"];
      }

      if (validatedUpdates.error) {
        jobUpdate.error = validatedUpdates.error;
      }

      if (validatedUpdates.startedAt) {
        jobUpdate.started_at = validatedUpdates.startedAt;
      }

      if (validatedUpdates.completedAt) {
        jobUpdate.completed_at = validatedUpdates.completedAt;
      }

      const { data, error } = await this.supabase
        .from("jobs")
        .update(jobUpdate)
        .eq("id", jobId)
        .select()
        .single();

      if (error) {
        console.error("[JobManager] Failed to update job", { error, jobId });
        throw new DatabaseError("Failed to update job", {
          supabaseError: error.message,
          code: error.code,
          jobId,
        });
      }

      // Log the status change event
      await this.logJobEvent(jobId, `job.status.${updates.status}`, {
        previousStatus: data.status, // Note: this might not be accurate due to race conditions
        newStatus: updates.status,
        hasResult: !!updates.result,
        hasError: !!updates.error,
      });

      return data;
    } catch (error) {
      console.error("[JobManager] Error updating job", { error, jobId });

      if (error instanceof VelroError) {
        throw error;
      }

      if (error instanceof z.ZodError) {
        throw new ValidationError("Invalid job update parameters", {
          validationErrors: error.issues,
          jobId,
        });
      }

      throw new VelroError("Failed to update job", "JOB_UPDATE_ERROR", 500, {
        originalError: error instanceof Error ? error.message : "Unknown error",
        jobId,
      });
    }
  }

  /**
   * Cancel a job (mark as cancelled)
   */
  async cancelJob(jobId: string): Promise<Job> {
    return this.updateJob(jobId, {
      status: JobStatus.CANCELLED,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark job as started
   */
  async startJob(jobId: string): Promise<Job> {
    return this.updateJob(jobId, {
      status: JobStatus.RUNNING,
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark job as completed with result
   */
  async completeJob(
    jobId: string,
    result: Record<string, unknown>,
  ): Promise<Job> {
    return this.updateJob(jobId, {
      status: JobStatus.COMPLETED,
      result,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark job as failed with error
   */
  async failJob(jobId: string, error: string): Promise<Job> {
    return this.updateJob(jobId, {
      status: JobStatus.FAILED,
      error,
      completedAt: new Date().toISOString(),
    });
  }

  /**
   * Get jobs by status with pagination
   */
  async getJobsByStatus(
    status: JobStatusType,
    options?: {
      limit?: number;
      offset?: number;
      teamId?: string;
      userId?: string;
    },
  ): Promise<Job[]> {
    try {
      let query = this.supabase
        .from("jobs")
        .select("*")
        .eq("status", status)
        .order("created_at", { ascending: false });

      if (options?.teamId) {
        query = query.eq("team_id", options.teamId);
      }

      if (options?.userId) {
        query = query.eq("user_id", options.userId);
      }

      if (options?.limit) {
        query = query.limit(options.limit);
      }

      if (options?.offset) {
        query = query.range(
          options.offset,
          options.offset + (options.limit || 50) - 1,
        );
      }

      const { data, error } = await query;

      if (error) {
        console.error("[JobManager] Failed to get jobs by status", {
          error,
          status,
        });
        throw new DatabaseError("Failed to get jobs by status", {
          supabaseError: error.message,
          code: error.code,
          status,
        });
      }

      return data;
    } catch (error) {
      console.error("[JobManager] Error getting jobs by status", {
        error,
        status,
      });

      if (error instanceof VelroError) {
        throw error;
      }

      throw new VelroError(
        "Failed to get jobs by status",
        "JOB_QUERY_ERROR",
        500,
        {
          originalError:
            error instanceof Error ? error.message : "Unknown error",
          status,
        },
      );
    }
  }

  /**
   * Log a job event (placeholder for when job_events table is available)
   */
  private async logJobEvent(
    _event: string,
    _jobId: string,
    _data?: Record<string, unknown>,
  ): Promise<void> {
    // TODO: Implement job event logging once job_events table is available
  }
}

// Create singleton instance
let jobManager: JobManager | null = null;

export const getJobManager = (): JobManager => {
  if (!jobManager) {
    jobManager = new JobManager();
  }
  return jobManager;
};

// Export types and manager
export { JobManager };
export default getJobManager;
