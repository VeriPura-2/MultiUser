import type { ChecklistRequiredBy } from "../db/schema.js";

/** Outbound: what we POST to VeriPura core when a consignment's PO is submitted. */
export interface CoreConsignmentPayload {
  consignmentId: string;
  /** Core's own id for this consignment, once known. Null until core reports one. */
  externalCoreId: string | null;
  commodity: string;
  hsCode: string | null;
  originCountry: string;
  destinationCountry: string;
  importerOrgId: string;
  exporterOrgId: string;
  poFileUrl: string;
}

export interface RequiredDocument {
  documentTypeName: string;
  requiredBy: ChecklistRequiredBy;
}

/** Inbound: the document checklist core returns, by callback or (stub only) in the response. */
export interface CoreChecklistPayload {
  consignmentId: string;
  externalCoreId?: string | null;
  requiredDocuments: RequiredDocument[];
}

export interface CoreSubmitResult {
  /**
   * Present only when the client can hand the checklist back synchronously (the stub). The
   * live client leaves it out: real core answers later by calling the inbound webhook.
   */
  checklist?: CoreChecklistPayload;
}

/** The seam between this platform and VeriPura core. Real HTTP and stub implementations. */
export interface VeriPuraCoreClient {
  submitConsignment(payload: CoreConsignmentPayload): Promise<CoreSubmitResult>;
}
