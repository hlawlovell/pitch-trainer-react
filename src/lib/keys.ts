/** Helpers for screen-wide keyboard shortcuts that must keep working after a button or dropdown was clicked. */

const TEXT_TYPES = new Set(['text', 'search', 'email', 'number', 'password', 'url', 'tel']);

/** True when the key goes into a text field, so shortcuts should stay out of the way. */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_TYPES.has((el as HTMLInputElement).type);
}

/** True for dropdowns, sliders, checkboxes… which use arrow/letter keys themselves. */
export function isControl(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el?.tagName && (el.tagName === 'SELECT' || el.tagName === 'INPUT') && !isTyping(el);
}

/**
 * Claim Space as a shortcut (unless typing): stops the focused button/dropdown from also
 * reacting to it, and drops focus so the next Space goes straight to the shortcut.
 */
export function claimSpace(e: KeyboardEvent): boolean {
  if (e.code !== 'Space' || isTyping(e.target)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return false; // holding Space shouldn't machine-gun play/pause
  spaceClaimed = true;
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body) el.blur();
  return true;
}

// Checkboxes and buttons activate on Space *release*, so blocking keydown alone isn't enough:
// swallow the matching keyup too (capture phase, before the control sees it).
let spaceClaimed = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keyup', e => {
    if (e.code !== 'Space' || !spaceClaimed) return;
    spaceClaimed = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
