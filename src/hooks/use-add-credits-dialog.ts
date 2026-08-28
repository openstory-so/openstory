/**
 * Add Credits Dialog Store (#1099)
 *
 * Opens the single globally-mounted AddCreditsDialog. Callers: the sidebar
 * wallet pill, the billing gate's "Add credits" card, billing settings, the
 * welcome dialog, and the pricing page CTA.
 */

import { createDialogStore } from './create-dialog-store';

const store = createDialogStore();

/** `surface` is where the user clicked — the `add_credits_clicked` property (#1301). */
export const openAddCreditsDialog = (surface: string) => store.open(surface);
export const getAddCreditsSurface = store.getPayload;
export const closeAddCreditsDialog = store.close;
export const useAddCreditsDialogOpen = store.useIsOpen;
