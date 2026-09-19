/** The acting user is not allowed to perform this action. */
export class PermissionDeniedError extends Error {
  constructor(message = "Permission denied") {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

/** A referenced row does not exist. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** A call to VeriPura core failed (network error, timeout, or a non-2xx response). */
export class VeriPuraCoreError extends Error {
  /** The consignment that was already saved when the call failed, if any. */
  consignmentId?: string;
  constructor(message: string, consignmentId?: string) {
    super(message);
    this.name = "VeriPuraCoreError";
    this.consignmentId = consignmentId;
  }
}

/** The input is invalid or the target is in a state that does not allow this action. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** The request is well formed but its content is not acceptable, for example a bad vessel identifier. Answered with 422. */
export class UnprocessableEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnprocessableEntityError";
  }
}
