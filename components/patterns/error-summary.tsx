export function ErrorSummary({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="rounded-card border border-status-danger-tint bg-status-danger-tint/40 p-3">
      <div className="text-status-danger text-xs font-semibold">Please fix {errors.length} issue(s):</div>
      <ul className="mt-1 list-disc pl-5 text-status-danger text-xs">
        {errors.map((e, i) => <li key={i}>{e}</li>)}
      </ul>
    </div>
  );
}
