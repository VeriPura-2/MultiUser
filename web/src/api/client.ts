import { getDevUserId } from "../auth/devUser";

/** A non-2xx answer from the backend, with the status and whatever body it sent. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  json?: unknown;
  form?: FormData;
}

/**
 * Calls the backend under /api (the dev server and any production proxy strip that prefix).
 *
 * Development only: when a sample user has been chosen, it is sent as X-Dev-User so each role and
 * organization can be tried. In a production build `import.meta.env.DEV` is false at build time, so
 * this branch, the header name, and the storage read are all removed from the bundle.
 */
async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (import.meta.env.DEV) {
    const devUser = getDevUserId();
    if (devUser) headers["X-Dev-User"] = devUser;
  }

  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form; // the browser sets the multipart boundary itself
  } else if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }

  const response = await fetch(`/api${path}`, { method, headers, body });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const data: unknown = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof (data as { message: unknown }).message === "string"
        ? (data as { message: string }).message
        : `Request failed (${response.status})`;
    throw new ApiError(response.status, message, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, json?: unknown) => request<T>("POST", path, json === undefined ? {} : { json }),
  postForm: <T>(path: string, form: FormData) => request<T>("POST", path, { form }),
};
