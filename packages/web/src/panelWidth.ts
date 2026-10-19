import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const KEY = "mockdata-generation-width";
export const PANEL_DEFAULT = 420;
export const PANEL_MIN = 320;
/** The editor keeps at least this much room beside the panel. */
export const EDITOR_MIN = 360;
const STEP = 24;

/** A width within [min, max]; a max below min (a narrow window) gives min. */
export const clampWidth = (width: number, max: number): number => Math.round(Math.max(PANEL_MIN, Math.min(width, Math.max(PANEL_MIN, max))));

function stored(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= PANEL_MIN ? v : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

function store(width: number): void {
  try {
    if (width === PANEL_DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(width));
  } catch {
    /* private mode: the width just is not remembered */
  }
}

/**
 * The generation panel's width, which the user drags (or moves with the arrow keys) from its left edge. It is kept in
 * `localStorage`, never below `PANEL_MIN`, and never so wide that the editor gets less than `EDITOR_MIN`.
 * `maxWidth` reads the room available now (the panel's right edge minus the editor's left edge, minus `EDITOR_MIN`).
 */
export function usePanelWidth(maxWidth: () => number) {
  const [width, setWidth] = useState(stored);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  const set = useCallback((next: number, persist: boolean) => {
    const w = clampWidth(next, maxWidth());
    setWidth(w);
    if (persist) store(w);
  }, [maxWidth]);

  const handle = {
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      start.current = { x: e.clientX, width };
      setDragging(true);
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      if (!start.current) return;
      set(start.current.width + (start.current.x - e.clientX), false); // the handle is on the left: moving left widens
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      if (!start.current) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      set(start.current.width + (start.current.x - e.clientX), true);
      start.current = null;
      setDragging(false);
    },
    onPointerCancel() {
      start.current = null;
      setDragging(false);
    },
    onDoubleClick() {
      set(PANEL_DEFAULT, true);
    },
    onKeyDown(e: KeyboardEvent<HTMLElement>) {
      const next = e.key === "ArrowLeft" ? width + STEP : e.key === "ArrowRight" ? width - STEP : e.key === "Home" ? PANEL_MIN : e.key === "End" ? Number.POSITIVE_INFINITY : e.key === "Enter" ? PANEL_DEFAULT : undefined;
      if (next === undefined) return;
      e.preventDefault();
      set(next, true);
    },
  };
  return { width, dragging, handle };
}
