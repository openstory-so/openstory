'use client';

/**
 * App-owned Select wrappers (#1396). Do not put this in `ui/select.tsx` —
 * that file is the stock shadcn/radix primitive.
 *
 * Radix Select portals the selected ItemText into an empty SelectValue.
 * Select content remounts between a DocumentFragment (closed) and the live
 * portal (open), so two ItemText trees briefly own the same trigger node
 * and React throws insertBefore/removeChild. Shadcn has not patched this
 * (current registry Select still uses empty SelectValue + bare ItemText).
 *
 * Always passing children to Select.Value disables that portal. We mirror
 * the selected item's label ourselves. Wrapping ItemText in a span is the
 * documented radix workaround for leftover text-node mutations.
 */

import * as React from 'react';
import {
  Select as ShadcnSelect,
  SelectContent,
  SelectGroup,
  SelectItem as ShadcnSelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue as ShadcnSelectValue,
} from '@/components/ui/select';

type SelectLabelRegistry = {
  getValue: () => string | undefined;
  getLabel: (value: string | undefined) => React.ReactNode | undefined;
  register: (value: string, label: React.ReactNode) => void;
  unregister: (value: string) => void;
  subscribe: (listener: () => void) => () => void;
};

const SelectLabelRegistryContext =
  React.createContext<SelectLabelRegistry | null>(null);

export function resolveSelectValueDisplay(
  explicitChildren: React.ReactNode | undefined,
  registeredLabel: React.ReactNode | undefined
): React.ReactNode {
  if (explicitChildren !== undefined) return explicitChildren;
  return registeredLabel ?? null;
}

export function wrapSelectItemLabel(children: React.ReactNode) {
  return <span>{children}</span>;
}

function Select(props: React.ComponentProps<typeof ShadcnSelect>) {
  const { value, defaultValue, ...rest } = props;
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const currentValue = value !== undefined ? value : uncontrolled;
  const valueRef = React.useRef(currentValue);
  valueRef.current = currentValue;
  const labelsRef = React.useRef(new Map<string, React.ReactNode>());
  const listenersRef = React.useRef(new Set<() => void>());

  const registry = React.useMemo<SelectLabelRegistry>(() => {
    const notify = () => {
      listenersRef.current.forEach((listener) => listener());
    };
    return {
      getValue: () => valueRef.current,
      getLabel: (itemValue) =>
        itemValue == null ? undefined : labelsRef.current.get(itemValue),
      register: (itemValue, label) => {
        labelsRef.current.set(itemValue, label);
        if (itemValue === valueRef.current) notify();
      },
      unregister: (itemValue) => {
        labelsRef.current.delete(itemValue);
      },
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    };
  }, []);

  React.useLayoutEffect(() => {
    listenersRef.current.forEach((listener) => listener());
  }, [currentValue]);

  return (
    <SelectLabelRegistryContext.Provider value={registry}>
      <ShadcnSelect
        {...rest}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => {
          setUncontrolled(next);
          props.onValueChange?.(next);
        }}
      />
    </SelectLabelRegistryContext.Provider>
  );
}

function SelectValue({
  children,
  placeholder,
  ...props
}: React.ComponentProps<typeof ShadcnSelectValue>) {
  const registry = React.useContext(SelectLabelRegistryContext);
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  React.useLayoutEffect(() => registry?.subscribe(rerender), [registry]);
  const display = resolveSelectValueDisplay(
    children,
    registry ? registry.getLabel(registry.getValue()) : undefined
  );
  // `null` is still defined, so Radix sets valueNodeHasChildren and skips
  // the ItemText → trigger portal.
  return (
    <ShadcnSelectValue placeholder={placeholder} {...props}>
      {display}
    </ShadcnSelectValue>
  );
}

function SelectItem({
  children,
  value,
  ...props
}: React.ComponentProps<typeof ShadcnSelectItem>) {
  const registry = React.useContext(SelectLabelRegistryContext);
  React.useLayoutEffect(() => {
    if (!registry || value == null) return;
    registry.register(value, children);
    return () => registry.unregister(value);
  }, [registry, value, children]);
  return (
    <ShadcnSelectItem value={value} {...props}>
      {wrapSelectItemLabel(children)}
    </ShadcnSelectItem>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
};
