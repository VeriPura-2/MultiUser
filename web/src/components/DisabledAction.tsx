import { useId } from "react";

/**
 * A button that cannot be used yet, with the reason as a tooltip.
 *
 * The button is natively disabled, so it cannot be activated or focused by mistake. Browsers do not
 * reliably show a tooltip for a disabled button, so the tooltip is on the wrapper, and the reason is
 * also attached for screen readers.
 */
export function DisabledAction({ label, reason, className = "" }: { label: string; reason: string; className?: string }) {
  const id = useId();
  return (
    <span className="tip" title={reason}>
      <button type="button" className={className} disabled aria-describedby={id}>
        {label}
      </button>
      <span id={id} className="sr-only">
        {reason}
      </span>
    </span>
  );
}
