/**
 * Wire contract between the Worker (the export workflow) and this container.
 *
 * Keep in sync with the Worker-side copy in
 * `src/lib/workflows/sequence-export-workflow.ts` (`ContainerExportJob`).
 */

export type ExportSceneInput = {
  /** Sort key; scenes are concatenated in ascending `orderIndex`. */
  orderIndex: number;
  /** Absolute, fetchable URL to the scene MP4 (already shareable-absolutized). */
  videoUrl: string;
};

export type ExportJob = {
  scenes: ExportSceneInput[];
  /** Absolute music URL, or null to omit the music bed. */
  musicUrl: string | null;
  /**
   * Precomputed music gain in dB. `null` triggers an in-process EBU R128
   * measurement so the server export matches the browser export's loudness.
   */
  musicLoudnessGainDb: number | null;
};

/** Returned as response headers alongside the MP4 body. */
export type ExportResultMeta = {
  durationSeconds: number;
  /** True when scenes were decoded and re-encoded (mixed res / codec). */
  reEncoded: boolean;
  /** Distinct scene resolutions when mixed, else "". */
  resolutionsLabel: string;
};
