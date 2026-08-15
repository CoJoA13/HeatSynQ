// The practice-copy banner (Phase 8B §5.1). Rendered by the ROOT LAYOUT as a sibling ABOVE <Shell>,
// so it survives Shell's /login and me-null early returns — the two moments a trainer most needs to
// see they are on the practice copy. Presentational ONLY: whether to show it is decided server-side
// by the root layout via practiceMode() (§8 forbids reading the flag in a client component), so this
// takes no props and reads no environment.
export function PracticeBanner() {
  return (
    <div
      role="status"
      className="w-full bg-amber-500 px-4 py-1.5 text-center text-sm font-semibold text-amber-950"
    >
      PRACTICE MODE — sample data for training. Documents are watermarked; nothing here affects
      production.
    </div>
  );
}
