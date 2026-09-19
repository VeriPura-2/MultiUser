import { ThemeToggle } from "../theme/ThemeToggle";

/** The portfolio overview. Its content arrives in the next step. */
export function Dashboard() {
  return (
    <>
      <div className="page-head">
        <h1>Portfolio overview</h1>
        <div className="actions">
          <ThemeToggle />
        </div>
      </div>
    </>
  );
}
