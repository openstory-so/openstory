import * as React from 'react';

function useLazyRef<T>(fn: () => T) {
  const ref = React.useRef<T | null>(null);

  if (ref.current === null) {
    ref.current = fn();
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Safe: ref.current is T after initialization
  return ref as React.RefObject<T>;
}

export { useLazyRef };
