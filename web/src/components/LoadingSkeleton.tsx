/** Grey placeholder bars shown while data loads. `aria-busy` tells assistive tech to wait. */
export function LoadingSkeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${100 - (i % 3) * 12}%` }} />
      ))}
    </div>
  );
}
