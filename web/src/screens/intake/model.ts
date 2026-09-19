import { MAX_VESSEL_NAME_LENGTH, imoProblem, mmsiProblem, vesselNameProblem } from "../../vessel";

/** The purchase order form's rules, kept apart from the screen so they are tested directly. */

/** The backend's limit on a purchase order file (src/http/consignments.ts). */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export interface IntakeValues {
  file: File | null;
  exporterOrgId: string;
  commodity: string;
  hsCode: string;
  originCountry: string;
  destinationCountry: string;
  /** Optional. Typed by hand for now; checked with the same rules and messages as the API. */
  vesselName: string;
  vesselImo: string;
  vesselMmsi: string;
}

export const EMPTY_INTAKE: IntakeValues = {
  file: null,
  exporterOrgId: "",
  commodity: "",
  hsCode: "",
  originCountry: "",
  destinationCountry: "",
  vesselName: "",
  vesselImo: "",
  vesselMmsi: "",
};

export type IntakeField = "file" | "exporterOrgId" | "commodity" | "originCountry" | "destinationCountry" | "vesselName" | "vesselImo" | "vesselMmsi";
export type IntakeErrors = Partial<Record<IntakeField, string>>;

/** Screen order, so focus can go to the first thing that needs fixing. */
export const FIELD_ORDER: IntakeField[] = ["file", "exporterOrgId", "commodity", "originCountry", "destinationCountry", "vesselName", "vesselImo", "vesselMmsi"];

export { MAX_VESSEL_NAME_LENGTH };

/** A problem with the file alone, so it can be checked the moment one is chosen. */
export function fileProblem(file: File): string | null {
  if (file.size === 0) return "That file is empty. Choose a different one.";
  if (file.size > MAX_FILE_BYTES) return "That file is over 15 MB. Choose a smaller one.";
  return null;
}

export function validateIntake(values: IntakeValues): IntakeErrors {
  const errors: IntakeErrors = {};
  if (!values.file) errors.file = "Add the purchase order file.";
  else {
    const problem = fileProblem(values.file);
    if (problem) errors.file = problem;
  }
  if (!values.exporterOrgId) errors.exporterOrgId = "Choose the exporter.";
  if (!values.commodity.trim()) errors.commodity = "Enter what is being shipped.";
  if (!values.originCountry) errors.originCountry = "Choose the country it ships from.";
  if (!values.destinationCountry) errors.destinationCountry = "Choose the country it ships to.";
  // The vessel is optional: only what was typed is checked, and blank is fine.
  const name = values.vesselName.trim();
  const imo = values.vesselImo.trim();
  const mmsi = values.vesselMmsi.trim();
  if (name && vesselNameProblem(name)) errors.vesselName = vesselNameProblem(name)!;
  if (imo && imoProblem(imo)) errors.vesselImo = imoProblem(imo)!;
  if (mmsi && mmsiProblem(mmsi)) errors.vesselMmsi = mmsiProblem(mmsi)!;
  return errors;
}

/** The multipart body the backend expects. The optional HS code is left out when blank, and text is trimmed. */
export function buildIntakeForm(values: IntakeValues): FormData {
  const form = new FormData();
  form.set("exporterOrgId", values.exporterOrgId);
  form.set("commodity", values.commodity.trim());
  form.set("originCountry", values.originCountry);
  form.set("destinationCountry", values.destinationCountry);
  if (values.hsCode.trim()) form.set("hsCode", values.hsCode.trim());
  if (values.vesselName.trim()) form.set("vesselName", values.vesselName.trim());
  if (values.vesselImo.trim()) form.set("vesselImo", values.vesselImo.trim());
  if (values.vesselMmsi.trim()) form.set("vesselMmsi", values.vesselMmsi.trim());
  if (values.file) form.set("file", values.file, values.file.name);
  return form;
}
