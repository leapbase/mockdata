import { useEffect, useRef, useState, type RefObject } from "react";

export function useNarrow(query: string) {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

/** Drawer focus stays inside the active overlay and returns to its opener. */
export function useDrawer(ref: RefObject<HTMLElement | null>, active: boolean, close: () => void, suspendForModal = true) {
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!active || !ref.current) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const focusables = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter((e) => e.tabIndex >= 0 && !e.closest("[hidden]") && e.getClientRects().length > 0);
    (focusables()[0] ?? panel).focus();
    const key = (e: KeyboardEvent) => {
      if (suspendForModal && document.querySelector('[role="dialog"].modal')) return;
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) { e.preventDefault(); panel.focus(); return; }
      const first = items[0]!, last = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (opener?.isConnected) opener.focus(); };
  }, [ref, active, suspendForModal]);
}
