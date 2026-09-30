import type { ReactNode } from "react";

/** A plain overlay (not <dialog>, which jsdom cannot open). */
export default function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <header>
          <h2>{title}</h2>
          <button aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
