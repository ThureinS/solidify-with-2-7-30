// Presentational Prev / "Page X of Y" / Next. Used by both the items list
// and the admin users list. No state of its own -- the parent owns `page`.
export default function Pagination({ page, total, limit, onPrev, onNext }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="flex items-center gap-4 text-sm text-almanac-mute">
      <button
        type="button"
        disabled={page <= 1}
        onClick={onPrev}
        className="rounded-lg px-3.5 py-2 text-sm bg-almanac-panel text-almanac-ink border border-almanac-border cursor-pointer hover:border-almanac-accent disabled:opacity-40 disabled:cursor-default disabled:hover:border-almanac-border"
      >
        Prev
      </button>
      <span className="tabular-nums">
        Page {page} of {totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={onNext}
        className="rounded-lg px-3.5 py-2 text-sm bg-almanac-panel text-almanac-ink border border-almanac-border cursor-pointer hover:border-almanac-accent disabled:opacity-40 disabled:cursor-default disabled:hover:border-almanac-border"
      >
        Next
      </button>
    </div>
  );
}
