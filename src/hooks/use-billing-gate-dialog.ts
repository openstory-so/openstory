/**
 * Billing Gate Dialog Store (#1099)
 *
 * Opens the globally-mounted gate dialog from anywhere — including the query
 * client's global mutation error handler, which opens it on
 * INSUFFICIENT_CREDITS.
 */

import { createDialogStore } from './create-dialog-store';

/** Why the gate opened — the `reason` on `billing_gate_shown` (#1301). */
export type BillingGateReason = 'insufficient' | 'zero' | 'manual';

const store = createDialogStore<BillingGateReason>();

export const openBillingGate = (reason: BillingGateReason = 'manual') =>
  store.open(reason);
export const getBillingGateReason = () => store.getPayload() ?? 'manual';
export const closeBillingGate = store.close;
export const useBillingGateDialogOpen = store.useIsOpen;
