import { Card } from "./Card";
import "./StatCard.css";

/** A headline number with a small uppercase label. `tone="red"` is for counts that need attention. */
export function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: "red" }) {
  return (
    <Card className="stat-card">
      <div className="stat-l">{label}</div>
      <div className={`stat-value display${tone === "red" ? " red" : ""}`}>{value}</div>
    </Card>
  );
}
