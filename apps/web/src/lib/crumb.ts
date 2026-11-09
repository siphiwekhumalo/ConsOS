import { useEffect, useSyncExternalStore } from 'react';

/** Tiny store so a detail page can name itself in the top-bar breadcrumb. */
let current: string | null = null;
const listeners = new Set<() => void>();

function set(value: string | null) {
  current = value;
  listeners.forEach((l) => l());
}

export function useSetCrumb(value: string | null | undefined) {
  useEffect(() => {
    set(value ?? null);
    return () => set(null);
  }, [value]);
}

export function useCrumb() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
