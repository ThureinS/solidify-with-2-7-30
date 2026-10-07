import { useEffect, useId, useRef } from 'react';

// One in-app confirm box for risky actions, built on the browser's native
// <dialog>. showModal() gives us for free: focus stays inside the box, the
// page behind can't be clicked, Esc closes it, and screen readers announce it
// as a dialog. The parent owns `open`; this component only reports the choice.
// `danger` (default on) paints Confirm red; pass false for a safe action.
export default function ConfirmDialog({ open, title, message, confirmLabel, onConfirm, onCancel, danger = true }) {
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  const titleId = useId();
  const messageId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && !dialog.open) {
      dialog.showModal();
      // Start on Cancel, so a stray Enter never confirms by accident.
      cancelRef.current.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Esc fires "cancel". Stop the browser closing the box by itself, so the
  // parent's `open` stays the single source of truth.
  function handleCancelEvent(e) {
    e.preventDefault();
    onCancel();
  }

  // Some browsers still force-close on a second Esc. If the box closed while
  // the parent thinks it's open, treat that as Cancel too.
  function handleClose() {
    if (open) onCancel();
  }

  // A click on the dim area outside the box lands on <dialog> itself.
  function handleBackdropClick(e) {
    if (e.target === dialogRef.current) onCancel();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={handleCancelEvent}
      onClose={handleClose}
      onClick={handleBackdropClick}
      className="m-auto p-0 w-[min(92vw,26rem)] rounded-2xl border border-almanac-border bg-almanac-panel text-almanac-ink backdrop:bg-black/60"
    >
      <div className="p-5 flex flex-col gap-3">
        <h2 id={titleId} className="m-0 font-display text-lg">
          {title}
        </h2>
        <p id={messageId} className="m-0 text-sm text-almanac-mute break-words">
          {message}
        </p>
        <div className="flex justify-end gap-2.5 mt-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3.5 py-1.5 text-sm bg-transparent text-almanac-ink border border-almanac-border cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold text-almanac-bg border-0 cursor-pointer ${
              danger ? 'bg-almanac-danger' : 'bg-almanac-accent'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
