/** Serialize sign-off dialogs while allowing upload/classification to run in parallel. */
export function createUploadRightsQueue() {
  let tail = Promise.resolve();
  return (showDialog: () => Promise<void>): Promise<void> => {
    const result = tail.then(showDialog);
    // A declined upload must not prevent later uploads from being confirmed.
    tail = result.catch(() => undefined);
    return result;
  };
}
