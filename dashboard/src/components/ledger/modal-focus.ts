"use client";

/**
 * The one focus trap, shared by every modal surface in the panel.
 *
 * Handoff § Accessibility: "Docked slips and drawers are modal — trap focus, return it on close."
 * `aria-modal="true"` is a PROMISE to assistive tech that the page behind is unavailable; a dialog
 * that makes that promise while Tab still walks out onto the ledger is worse than one that never
 * claimed to be modal, because the reader is told the DEL button they just landed on does not
 * exist. There were three hand-rolled versions of this (the create-task slip, the delete
 * confirmation, the screenshot lightbox) and only one of them actually contained Tab, so it lives
 * here now and every surface calls the same two functions.
 */

import { useEffect, useRef, type RefObject } from "react";

/**
 * What Tab can land on. `[tabindex="-1"]` is excluded here AND filtered again below, because an
 * element can be given `tabIndex = -1` in JS without the attribute ever appearing in the DOM.
 */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable descendants of `node`, in tab order, minus the ones the browser would skip. */
export function focusablesIn(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
  );
}

/**
 * Handle one `Tab` keydown for a modal `node`. Returns `true` when it moved focus.
 *
 * The wrap is tested against `document.activeElement` rather than the event target, and an active
 * element that is NOT inside the node counts as "out" — so focus that has already escaped (the
 * address bar, an extension, a click on the page behind) is pulled back in rather than allowed to
 * keep walking.
 */
export function trapTab(node: HTMLElement | null, event: KeyboardEvent): boolean {
  if (node === null || event.key !== "Tab") return false;
  const focusable = focusablesIn(node);
  if (focusable.length === 0) return false;
  const firstEl = focusable[0]!;
  const lastEl = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  const outside = !node.contains(active);
  if (event.shiftKey && (active === firstEl || outside)) {
    event.preventDefault();
    lastEl.focus();
    return true;
  }
  if (!event.shiftKey && (active === lastEl || outside)) {
    event.preventDefault();
    firstEl.focus();
    return true;
  }
  return false;
}

/**
 * Remember what was focused when the modal opened and put focus back there when it closes.
 *
 * Mount-only on purpose: the opener is whatever had focus at the moment the surface appeared, and
 * re-reading it later would capture something inside the modal itself.
 */
export function useReturnFocus(): void {
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      const back = opener.current;
      // The opener can be gone by now — a row deleted by the very dialog that was open — in which
      // case there is nothing to return to and the browser's own fallback is right.
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
}

/**
 * `esc` closes, `Tab` is contained, focus returns on close — the whole modality contract in one
 * call, for the surfaces that need nothing more than that.
 *
 * The create-task slip does not use this: it also owns `⌘↵` and must not close while a start is in
 * flight, so it keeps its own handler and calls `trapTab` from inside it.
 */
export function useModalKeys(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useReturnFocus();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      trapTab(ref.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, ref]);
}
