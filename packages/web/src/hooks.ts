import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (ms <= 0) {
      setDebounced(value);
      return;
    }
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
