import { vi } from "vitest";

/**
 * A mocked API layer. It replaces global fetch, so the app's real client code (headers, paths,
 * error handling) runs against canned answers. Routes are written as "METHOD /path/:param".
 *
 * A request that no route matches is answered with 404 and recorded in `unmocked`, and
 * `expectNothingUnmocked()` fails the test if any happened, so a test cannot quietly pass on data
 * it never provided.
 */

export interface MockRequest {
  method: string;
  /** The path after /api, without the query string. */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Headers;
  /** The parsed JSON body, if there was one. */
  json: unknown;
  /** The multipart body, if there was one. */
  form: FormData | null;
}

export class MockResponse {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/** Answer with a specific status, for example respond(401, { error: "unauthenticated" }). */
export const respond = (status: number, body: unknown = {}) => new MockResponse(status, body);

type Handler = unknown | ((request: MockRequest) => unknown | Promise<unknown>);

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(spec: string, handler: Handler): Route {
  const [method, path] = spec.split(" ") as [string, string];
  const keys: string[] = [];
  const pattern = path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${pattern}$`), keys, handler };
}

export interface MockApi {
  calls: MockRequest[];
  unmocked: string[];
  /** Calls to routes matching "METHOD /path" (a path with :params matches any value). */
  callsTo: (spec: string) => MockRequest[];
  expectNothingUnmocked: () => void;
}

export function mockApi(routes: Record<string, Handler> = {}): MockApi {
  // The dev user switcher asks for this on every screen while running in development.
  const compiled = [...Object.entries({ "GET /dev/users": { users: [] }, ...routes })].map(([spec, handler]) =>
    compile(spec, handler),
  );
  const calls: MockRequest[] = [];
  const unmocked: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);

    let json: unknown = undefined;
    let form: FormData | null = null;
    if (init?.body instanceof FormData) form = init.body;
    else if (typeof init?.body === "string") json = JSON.parse(init.body);

    // Later routes override earlier ones, so a test's route wins over a default.
    const route = [...compiled].reverse().find((r) => r.method === method && r.pattern.test(path));
    if (!route) {
      unmocked.push(`${method} ${path}`);
      return new Response(JSON.stringify({ error: "not_mocked" }), { status: 404, headers: { "content-type": "application/json" } });
    }

    const match = route.pattern.exec(path)!;
    const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)]));
    const request: MockRequest = { method, path, params, query: url.searchParams, headers, json, form };
    calls.push(request);

    const result = typeof route.handler === "function" ? await route.handler(request) : route.handler;
    const status = result instanceof MockResponse ? result.status : 200;
    const body = result instanceof MockResponse ? result.body : result;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);

  return {
    calls,
    unmocked,
    callsTo: (spec) => {
      const { method, pattern } = compile(spec, null);
      return calls.filter((c) => c.method === method && pattern.test(c.path));
    },
    expectNothingUnmocked: () => {
      if (unmocked.length > 0) throw new Error(`Requests that no route mocked: ${unmocked.join(", ")}`);
    },
  };
}
