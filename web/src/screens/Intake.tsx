import { useId, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useExporters, useSubmitConsignment } from "../api/hooks";
import { ApiError } from "../api/client";
import { useCurrentUser } from "../auth/CurrentUser";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { describeError } from "../components/ErrorState";
import { LoadingSkeleton } from "../components/LoadingSkeleton";
import { countryOptions } from "../countries";
import { formatBytes } from "../format";
import { ORG_TYPE_LABEL } from "../labels";
import { ThemeToggle } from "../theme/ThemeToggle";
import { EMPTY_INTAKE, FIELD_ORDER, buildIntakeForm, fileProblem, validateIntake, type IntakeErrors, type IntakeField, type IntakeValues } from "./intake/model";
import "./intake/Intake.css";

const INPUT_ID: Record<IntakeField, string> = {
  file: "intake-file",
  exporterOrgId: "intake-exporter",
  commodity: "intake-commodity",
  originCountry: "intake-origin",
  destinationCountry: "intake-destination",
  vesselName: "intake-vessel-name",
  vesselImo: "intake-vessel-imo",
  vesselMmsi: "intake-vessel-mmsi",
};

/** The purchase order form: upload the file, say who it is from and what is shipped, and submit. */
export function Intake() {
  const me = useCurrentUser();
  const isImporter = me.organization?.orgType === "importer";

  return (
    <div className="page">
      <div className="page-inner in-page">
        <div className="in-top">
          <ThemeToggle />
        </div>
        <div className="in-title">
          <h1 className="display">New consignment</h1>
          {me.organization ? (
            <div className="in-org">
              {me.organization.name} &middot; {ORG_TYPE_LABEL[me.organization.orgType]}
            </div>
          ) : null}
        </div>
        {isImporter ? (
          <IntakeForm />
        ) : (
          <EmptyState title="Only importers can start a consignment">
            A consignment starts with a purchase order from an importer organization. <Link to="/">Back to the dashboard</Link>
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function IntakeForm() {
  const navigate = useNavigate();
  const exporters = useExporters();
  const submit = useSubmitConsignment();
  const countries = useMemo(() => countryOptions(), []);

  const [values, setValues] = useState<IntakeValues>(EMPTY_INTAKE);
  const [errors, setErrors] = useState<IntakeErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const set = <K extends keyof IntakeValues>(key: K, value: IntakeValues[K]) => {
    const next = { ...values, [key]: value };
    setValues(next);
    if (submitted) setErrors(validateIntake(next)); // once they have tried, keep the messages honest as they fix things
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const found = validateIntake(values);
    setErrors(found);
    const first = FIELD_ORDER.find((f) => found[f]);
    if (first) {
      document.getElementById(INPUT_ID[first])?.focus();
      return;
    }
    submit.mutate(buildIntakeForm(values), { onSuccess: (consignment) => navigate(`/consignments/${consignment.id}`) });
  };

  // The one failure that is not "nothing happened": the purchase order was saved but the checklist
  // service could not be reached. Sending it again would create a second consignment.
  const savedId = savedConsignmentId(submit.error);
  if (savedId) {
    return (
      <div role="alert">
        <Card className="in-saved">
          <h2>Your purchase order was saved</h2>
          <p>The checklist service could not be reached, so the checklist has not arrived yet. Do not submit it again: it would create a second consignment.</p>
          <Link to={`/consignments/${savedId}`} className="btn primary">
            Open the consignment
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <p className="in-lead">Upload the purchase order, then say who it is from and what is being shipped. If you know the vessel, add it; you can leave it blank. Nothing is filled in for you.</p>

      <Card className={`in-step${values.file ? " done" : ""}`}>
        <div className="in-step-head">
          <div className="in-num" aria-hidden="true">
            1
          </div>
          <h2 className="display">Purchase order</h2>
        </div>
        <FileStep file={values.file} error={errors.file} onFile={(file) => set("file", file)} />
      </Card>

      <Card className="in-step">
        <div className="in-step-head">
          <div className="in-num gold" aria-hidden="true">
            2
          </div>
          <h2 className="display">Consignment details</h2>
        </div>
        <div className="in-fields">
          <Field id={INPUT_ID.exporterOrgId} label="Exporter" error={errors.exporterOrgId}>
            <ExporterSelect state={exporters} value={values.exporterOrgId} onChange={(v) => set("exporterOrgId", v)} error={errors.exporterOrgId} />
          </Field>
          <Field id={INPUT_ID.commodity} label="Product description" error={errors.commodity}>
            <input
              id={INPUT_ID.commodity}
              type="text"
              value={values.commodity}
              onChange={(e) => set("commodity", e.target.value)}
              aria-invalid={Boolean(errors.commodity)}
              aria-describedby={errors.commodity ? `${INPUT_ID.commodity}-error` : undefined}
            />
          </Field>
          <Field id={INPUT_ID.originCountry} label="Origin" error={errors.originCountry}>
            <CountrySelect id={INPUT_ID.originCountry} options={countries} value={values.originCountry} onChange={(v) => set("originCountry", v)} error={errors.originCountry} />
          </Field>
          <Field id={INPUT_ID.destinationCountry} label="Destination" error={errors.destinationCountry}>
            <CountrySelect id={INPUT_ID.destinationCountry} options={countries} value={values.destinationCountry} onChange={(v) => set("destinationCountry", v)} error={errors.destinationCountry} />
          </Field>
          <Field id="intake-hs" label="HS code (optional)">
            <input id="intake-hs" type="text" value={values.hsCode} onChange={(e) => set("hsCode", e.target.value)} />
          </Field>
          <Field id={INPUT_ID.vesselName} label="Vessel name (optional)" error={errors.vesselName}>
            <TextInput field="vesselName" value={values.vesselName} error={errors.vesselName} onChange={(v) => set("vesselName", v)} />
          </Field>
          <Field id={INPUT_ID.vesselImo} label="IMO number (optional)" error={errors.vesselImo}>
            <TextInput field="vesselImo" value={values.vesselImo} error={errors.vesselImo} onChange={(v) => set("vesselImo", v)} inputMode="numeric" />
          </Field>
          <Field id={INPUT_ID.vesselMmsi} label="MMSI (optional)" error={errors.vesselMmsi}>
            <TextInput field="vesselMmsi" value={values.vesselMmsi} error={errors.vesselMmsi} onChange={(v) => set("vesselMmsi", v)} inputMode="numeric" />
          </Field>
        </div>

        {submit.isError ? (
          <div role="alert" className="in-error">
            <strong>{describeError(submit.error).title}.</strong> {describeError(submit.error).detail}
          </div>
        ) : null}

        <button type="submit" className="in-go" disabled={submit.isPending}>
          {submit.isPending ? "Submitting" : "Submit purchase order"}
        </button>
      </Card>
    </form>
  );
}

/** The saved consignment's id, when the failure was "saved, but the checklist service was unreachable". */
export function savedConsignmentId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 502) return null;
  const body = error.body as { consignmentId?: unknown } | null;
  return typeof body?.consignmentId === "string" ? body.consignmentId : null;
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return (
    <div className="field in-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <div id={`${id}-error`} className="error-text">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function TextInput({ field, value, error, onChange, inputMode }: { field: IntakeField; value: string; error?: string; onChange: (v: string) => void; inputMode?: "numeric" }) {
  const id = INPUT_ID[field];
  return (
    <input id={id} type="text" inputMode={inputMode} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
  );
}

function CountrySelect({ id, options, value, onChange, error }: { id: string; options: Array<{ code: string; name: string }>; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>
      <option value="">Choose a country</option>
      {options.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

function ExporterSelect({ state, value, onChange, error }: { state: ReturnType<typeof useExporters>; value: string; onChange: (v: string) => void; error?: string }) {
  if (state.isError) {
    return (
      <div role="alert" className="in-inline-error">
        {describeError(state.error).title}.{" "}
        <button type="button" className="in-link" onClick={() => void state.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!state.data) return <LoadingSkeleton lines={1} label="Loading exporters" />;
  if (state.data.length === 0) return <div className="in-inline-note">There are no approved exporters yet. An exporter must be approved before a purchase order can be sent to it.</div>;
  return (
    <select id={INPUT_ID.exporterOrgId} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${INPUT_ID.exporterOrgId}-error` : undefined}>
      <option value="">Choose an exporter</option>
      {state.data.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
  );
}

function FileStep({ file, error, onFile }: { file: File | null; error?: string; onFile: (file: File | null) => void }) {
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);

  const choose = (files: FileList | File[] | null | undefined) => {
    setDropNote(null);
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    if (list.length > 1) {
      setDropNote("Add one file at a time: the purchase order.");
      return;
    }
    onFile(list[0]!);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    choose(event.dataTransfer.files);
  };

  const problem = file ? fileProblem(file) : null;
  // A bad file is reported at once; a missing one only after a submit attempt (that is `error`).
  const message = dropNote ?? problem ?? error ?? null;

  return (
    <>
      {file && !problem ? (
        <div className="in-file">
          <div className="in-file-text">
            <div className="in-file-name">{file.name}</div>
            <div className="in-file-size">{formatBytes(file.size)}</div>
          </div>
          <span className="in-ready">Ready</span>
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            Choose a different file
          </button>
        </div>
      ) : (
        <div
          className={`in-drop${over ? " over" : ""}${message ? " bad" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M12 16V4M12 4L7 9M12 4l5 5" />
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          <span id={hintId}>
            Drop the purchase order here, or{" "}
            <button type="button" className="in-link" onClick={() => input.current?.click()}>
              browse for a file
            </button>
            . One file, up to 15 MB.
          </span>
        </div>
      )}
      <input
        ref={input}
        id={INPUT_ID.file}
        className="sr-only"
        type="file"
        aria-label="Purchase order file"
        aria-invalid={Boolean(problem ?? error)}
        aria-describedby={message ? `${INPUT_ID.file}-error` : hintId}
        onChange={(e) => {
          choose(e.target.files);
          e.target.value = ""; // choosing the same file again should still fire
        }}
      />
      {message ? (
        <div id={`${INPUT_ID.file}-error`} className="error-text in-file-error" role={dropNote ? "alert" : undefined}>
          {message}
        </div>
      ) : null}
    </>
  );
}
