/**
 * Voice input for script and prompt editors: record a take with TanStack AI's
 * web recorder (`AudioRecorder` from `@tanstack/ai-client`), post it to
 * `transcribeVoiceFn`, and hand the transcript to the caller.
 *
 * Recorder errors (mic permission denied, MediaRecorder failure) arrive on the
 * recorder's `onError`; `start()`/`stop()` also reject for the same failures,
 * so the catch blocks below only reset state and never report twice.
 */

import { transcribeVoiceFn } from '@/functions/voice';
import {
  MAX_VOICE_RECORDING_MS,
  MIN_VOICE_RECORDING_MS,
} from '@/lib/voice/voice-limits';
import {
  AudioRecorder,
  type AudioRecorderState,
  type AudioRecording,
} from '@tanstack/ai-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsRef } from './use-as-ref';
import { useHydrated } from './use-hydrated';

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing';

export type UseVoiceInputOptions = {
  /** Receives the transcript of each completed take (never empty). */
  onTranscript: (text: string) => void;
  /**
   * Recorder and transcription failures. `NoSpeechError` marks a take that
   * came back empty; an `INSUFFICIENT_CREDITS` server error arrives here too
   * (the hook deliberately avoids TanStack Query so it can render outside a
   * QueryClientProvider — see the editor's SSR test).
   */
  onError?: (error: unknown) => void;
  /** ISO-639-1 hint; omitted = auto-detect. */
  language?: string;
  /** Auto-stop bound for one take. */
  maxDurationMs?: number;
};

/**
 * Read through a call so TypeScript does not carry a narrowing of the getter
 * across the `await` in `start()` (the recorder mutates it meanwhile).
 */
const recorderState = (recorder: AudioRecorder): AudioRecorderState =>
  recorder.state;

export class NoSpeechError extends Error {
  constructor() {
    super('No speech detected in that recording');
    this.name = 'NoSpeechError';
  }
}

export function useVoiceInput({
  onTranscript,
  onError,
  language,
  maxDurationMs = MAX_VOICE_RECORDING_MS,
}: UseVoiceInputOptions) {
  const hydrated = useHydrated();
  const [status, setStatus] = useState<VoiceInputStatus>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);

  // The recorder is created once; keep the latest callbacks reachable from it.
  const onErrorRef = useAsRef(onError);
  const onTranscriptRef = useAsRef(onTranscript);
  const languageRef = useAsRef(language);

  // Created on first use, never during render: SSR never touches it and the
  // React Compiler lint stays clear of ref reads in render.
  const recorderRef = useRef<AudioRecorder | null>(null);
  const getRecorder = useCallback(() => {
    recorderRef.current ??= new AudioRecorder({
      onError: (error) => {
        setStatus('idle');
        setStartedAt(null);
        onErrorRef.current?.(error);
      },
    });
    return recorderRef.current;
  }, [onErrorRef]);

  // Release the mic if the editor unmounts mid-take.
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const start = useCallback(async () => {
    const recorder = getRecorder();
    if (recorderState(recorder) !== 'idle') return;
    try {
      await recorder.start();
    } catch {
      // Reported via the recorder's onError.
      return;
    }
    // Still 'idle' if a cancel() landed while the mic prompt was open.
    if (recorderState(recorder) === 'recording') {
      setStatus('recording');
      setStartedAt(Date.now());
    }
  }, [getRecorder]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorderState(recorder) !== 'recording') return;
    setStatus('transcribing');
    let recording: AudioRecording;
    try {
      recording = await recorder.stop();
    } catch {
      // Cancelled or failed — reported via onError when it is a failure.
      setStatus('idle');
      setStartedAt(null);
      return;
    }
    setStartedAt(null);
    if (
      recording.blob.size === 0 ||
      recording.durationMs < MIN_VOICE_RECORDING_MS
    ) {
      // A mis-click on the mic, not a take.
      setStatus('idle');
      return;
    }
    try {
      const language = languageRef.current;
      const { text } = await transcribeVoiceFn({
        data: {
          audio: recording.base64,
          mimeType: recording.mimeType,
          durationMs: Math.max(1, Math.round(recording.durationMs)),
          ...(language ? { language } : {}),
        },
      });
      if (text) {
        onTranscriptRef.current(text);
      } else {
        onErrorRef.current?.(new NoSpeechError());
      }
    } catch (error) {
      onErrorRef.current?.(error);
    } finally {
      setStatus('idle');
    }
  }, [languageRef, onErrorRef, onTranscriptRef]);

  const cancel = useCallback(() => {
    recorderRef.current?.cancel();
    setStatus('idle');
    setStartedAt(null);
  }, []);

  // Auto-stop: a forgotten live mic should not run (and bill) indefinitely.
  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setTimeout(() => void stop(), maxDurationMs);
    return () => clearTimeout(timer);
  }, [status, maxDurationMs, stop]);

  const toggle = useCallback(() => {
    if (status === 'recording') return stop();
    if (status === 'idle') return start();
    return Promise.resolve();
  }, [status, start, stop]);

  return {
    status,
    /** False during SSR/hydration and in browsers without getUserMedia + MediaRecorder. */
    isSupported: hydrated && AudioRecorder.isSupported(),
    /** Epoch ms the current take began, for an elapsed-time readout. */
    startedAt,
    start,
    stop,
    cancel,
    toggle,
  };
}
