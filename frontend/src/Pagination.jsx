// Presentational Prev / "Page X of Y" / Next. Used by both the items list
// and the admin users list. No state of its own -- the parent owns `page`.
export default function Pagination({ page, total, limit, onPrev, onNext }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <button type="button" disabled={page <= 1} onClick={onPrev}>
        Prev
      </button>
      <span>
        Page {page} of {totalPages}
      </span>
      <button type="button" disabled={page >= totalPages} onClick={onNext}>
        Next
      </button>
    </div>
  );
}
