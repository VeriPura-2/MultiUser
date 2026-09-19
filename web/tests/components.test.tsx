import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { DisabledAction } from "../src/components/DisabledAction";
import { EmptyState } from "../src/components/EmptyState";
import { ErrorState } from "../src/components/ErrorState";
import { LoadingSkeleton } from "../src/components/LoadingSkeleton";
import { Modal } from "../src/components/Modal";
import { OrgTypeTag } from "../src/components/OrgTypeTag";
import { StatCard } from "../src/components/StatCard";
import { Badge } from "../src/components/Badge";
import { initials, formatDate, shortRef, timeAgo } from "../src/format";

describe("Badge and OrgTypeTag", () => {
  it("Badge carries its tone as a class", () => {
    render(<Badge tone="red">Correction needed</Badge>);
    expect(screen.getByText("Correction needed")).toHaveClass("badge", "red");
  });

  it("OrgTypeTag shows a readable label for every organization type", () => {
    const expected = { importer: "Importer", exporter: "Exporter", logistics: "Logistics", lab_cert: "Lab / Cert", data_source: "Data Source" } as const;
    for (const [type, label] of Object.entries(expected)) {
      const { unmount } = render(<OrgTypeTag type={type as keyof typeof expected} />);
      expect(screen.getByText(label)).toHaveClass("tag");
      unmount();
    }
  });

  it("OrgTypeTag can be the coloured chip, with the type as a class", () => {
    render(<OrgTypeTag type="lab_cert" variant="solid" />);
    expect(screen.getByText("Lab / Cert")).toHaveClass("otag", "lab_cert");
  });
});

describe("StatCard", () => {
  it("shows a label and a value, and can flag a count that needs attention", () => {
    render(<StatCard label="Open issues" value={3} tone="red" />);
    expect(screen.getByText("Open issues")).toBeInTheDocument();
    expect(screen.getByText("3")).toHaveClass("red");
  });
});

describe("EmptyState, ErrorState, LoadingSkeleton", () => {
  it("EmptyState says why it is empty", () => {
    render(<EmptyState title="Nothing to do">All caught up.</EmptyState>);
    expect(screen.getByRole("heading", { name: "Nothing to do" })).toBeInTheDocument();
    expect(screen.getByText("All caught up.")).toBeInTheDocument();
  });

  it("ErrorState turns each kind of failure into plain language, and offers a retry only if it can", async () => {
    const retry = vi.fn();
    const cases: Array<[unknown, RegExp]> = [
      [new ApiError(401, "x", null), /not signed in/i],
      [new ApiError(403, "x", null), /do not have access/i],
      [new ApiError(404, "x", null), /not found/i],
      [new ApiError(500, "The database is down", null), /database is down/i],
      [new TypeError("Failed to fetch"), /could not reach the server/i],
    ];
    for (const [error, text] of cases) {
      const { unmount } = render(<ErrorState error={error} onRetry={retry} />);
      expect(screen.getByRole("alert")).toHaveTextContent(text);
      unmount();
    }

    render(<ErrorState error={new ApiError(500, "boom", null)} onRetry={retry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("ErrorState without a retry shows no button", () => {
    render(<ErrorState error={new ApiError(404, "x", null)} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("LoadingSkeleton announces itself as busy", () => {
    render(<LoadingSkeleton lines={2} label="Loading consignments" />);
    expect(screen.getByText("Loading consignments")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(document.querySelectorAll(".skeleton")).toHaveLength(2);
  });
});

describe("DisabledAction", () => {
  it("is a natively disabled button with the reason as a tooltip and for screen readers", async () => {
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        <DisabledAction label="Upload" reason="Document upload is coming in a later stage." />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Upload" });
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAttribute("title", "Document upload is coming in a later stage.");
    expect(button).toHaveAccessibleDescription("Document upload is coming in a later stage.");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Modal", () => {
  function Harness({ onClose = () => {} }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState("");
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        <Modal
          open={open}
          title="Request correction"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          {/* An inline onClose above changes identity on every keystroke: focus must not be stolen. */}
          <textarea aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} />
        </Modal>
      </>
    );
  }

  it("is a labelled modal dialog that puts focus inside", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "Request correction" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("does not steal focus while the user types, even though the parent re-renders", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const box = screen.getByRole("textbox", { name: "Message" });
    // The symptom of the bug is the box losing focus and getting it straight back, so the end
    // state alone looks fine. Watch for the blur itself.
    const blurred = vi.fn();
    box.addEventListener("blur", blurred);
    await userEvent.type(box, "Please reissue the certificate");
    expect(box).toHaveValue("Please reissue the certificate");
    expect(box).toHaveFocus();
    expect(blurred).not.toHaveBeenCalled();
  });

  it("closes on Escape and returns focus to what opened it", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open" });
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });

  it("closes on a click on the backdrop but not on a click inside the dialog", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await userEvent.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(document.querySelector(".modal-backdrop")!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("format helpers", () => {
  it("formatDate reads the same in UTC everywhere, and copes with garbage", () => {
    expect(formatDate("2026-09-16T23:59:59.000Z")).toBe("2026-09-16");
    expect(formatDate("not a date")).toBe("n/a");
  });

  it("timeAgo is coarse and human", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(timeAgo("2026-09-19T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-09-19T11:30:00Z", now)).toBe("30 minutes ago");
    expect(timeAgo("2026-09-19T09:00:00Z", now)).toBe("3 hours ago");
    expect(timeAgo("2026-09-17T12:00:00Z", now)).toBe("2 days ago");
    expect(timeAgo("2026-07-19T12:00:00Z", now)).toBe("2 months ago");
    expect(timeAgo("garbage", now)).toBe("");
  });

  it("shortRef gives a short stable reference for an id", () => {
    expect(shortRef("a1b2c3d4-0000-4000-8000-000000000000")).toBe("#A1B2C3D4");
  });

  it("initials come from a name or an email", () => {
    expect(initials("Ivy Importer")).toBe("II");
    expect(initials("admin@importer.example.test")).toBe("AD");
    expect(initials("maria.costa@x.test")).toBe("MC");
    expect(initials("")).toBe("?");
  });
});
