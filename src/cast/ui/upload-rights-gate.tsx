/**
 * Upload rights gate (#1581) — the one dialog every inline upload goes
 * through. An upload hook calls `ensureUploadRights(refs)` after the bytes
 * land and before finalize: each image is checked, and if any shows a real
 * person the sign-off dialog opens and the promise waits for Confirm. Cancel
 * rejects, so the upload fails instead of finalizing unsigned.
 *
 * Mounted once in the app shell next to <AuthGateProvider>; outside it
 * (Storybook, tests) wrap with <UploadRightsGateStub>.
 *
 * Concurrent calls share one dialog (#2239). A second request is queued;
 * Confirm attests every queued upload once and resolves them all.
 */

import { PortraitAttestationFields } from '@/cast/ui/portrait-attestation-fields';
import { attestUploadsFn } from '@/cast/upload-rights.fn';
import type { UploadRef } from '@/cast/upload-rights';
import { PORTRAIT_RIGHTS_V1 } from '@/platform/compliance/attestations';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createUploadRightsQueue } from './upload-rights-queue';
import { uploadRightsKeys, uploadRightsQuery } from './use-upload-rights';

type UploadRightsGateValue = {
  /** Resolves once every image is cleared or signed; rejects if declined. */
  ensureUploadRights: (refs: UploadRef[]) => Promise<void>;
};

const UploadRightsGateContext = createContext<UploadRightsGateValue | null>(
  null
);

export function useUploadRightsGate(): UploadRightsGateValue {
  const value = useContext(UploadRightsGateContext);
  if (!value) {
    throw new Error(
      'useUploadRightsGate must be used within <UploadRightsGateProvider> (app shell) or <UploadRightsGateStub> (stories/tests)'
    );
  }
  return value;
}

/** Stand-in for trees outside the app shell: every upload passes. */
export function UploadRightsGateStub({ children }: { children: ReactNode }) {
  const value = useMemo<UploadRightsGateValue>(
    () => ({ ensureUploadRights: () => Promise.resolve() }),
    []
  );
  return (
    <UploadRightsGateContext.Provider value={value}>
      {children}
    </UploadRightsGateContext.Provider>
  );
}

export function UploadRightsGateProvider({
  children,
}: {
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const [attested, setAttested] = useState(false);
  const [authorizationBasis, setAuthorizationBasis] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queue] = useState(() =>
    createUploadRightsQueue({
      classify: (refs) =>
        Promise.all(
          refs.map((ref) => queryClient.fetchQuery(uploadRightsQuery(ref)))
        ),
      onShow: () => {
        setAttested(false);
        setAuthorizationBasis('');
        setError(null);
      },
    })
  );
  const snapshot = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot
  );

  const ensureUploadRights = queue.ensureUploadRights;

  const confirm = async () => {
    if (!snapshot.open || !attested || authorizationBasis.trim().length === 0) {
      return;
    }
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await queue.confirm(async (refs) => {
        await attestUploadsFn({
          data: {
            attestations: refs.map((ref) => ({
              url: ref.url,
              statementVersion: PORTRAIT_RIGHTS_V1.version,
              authorizationBasis: authorizationBasis.trim(),
            })),
          },
        });
        await queryClient.invalidateQueries({ queryKey: uploadRightsKeys.all });
      });
      if (!queue.getSnapshot().open) {
        setAttested(false);
        setAuthorizationBasis('');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const value = useMemo<UploadRightsGateValue>(
    () => ({ ensureUploadRights }),
    [ensureUploadRights]
  );
  const canConfirm = attested && authorizationBasis.trim().length > 0;
  const names = snapshot.names;

  return (
    <UploadRightsGateContext.Provider value={value}>
      {children}
      <Dialog
        open={snapshot.open}
        onOpenChange={(open) => {
          if (!open) queue.decline();
        }}
      >
        <DialogContent
          className="max-w-lg"
          onKeyDown={(event) => {
            // The basis is a textarea: Ctrl/Cmd+Enter confirms, Enter is a newline.
            if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) {
              return;
            }
            if (!(event.target instanceof HTMLTextAreaElement)) return;
            event.preventDefault();
            if (canConfirm && !saving) void confirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>Real person detected</DialogTitle>
            <DialogDescription>
              {names.length === 1
                ? `${names[0]} shows a real person.`
                : `${names.length} uploads show a real person.`}{' '}
              Confirm you have the rights to their likeness to continue.
            </DialogDescription>
          </DialogHeader>
          <PortraitAttestationFields
            id="upload-rights-gate"
            attested={attested}
            onAttestedChange={setAttested}
            authorizationBasis={authorizationBasis}
            onAuthorizationBasisChange={setAuthorizationBasis}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => queue.decline()}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canConfirm || saving}
              onClick={() => void confirm()}
            >
              {saving ? 'Saving…' : 'Confirm rights'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </UploadRightsGateContext.Provider>
  );
}
