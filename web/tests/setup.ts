import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// The map loads as a separate chunk (Leaflet plus land data), which is slow to transform the first
// time when the whole suite runs in parallel. Waiting longer costs nothing when things are fast.
configure({ asyncUtilTimeout: 8000 });

// jsdom draws nothing, and Leaflet decides at import time whether it can draw vector lines by asking
// the SVG element for createSVGRect. Answer yes so routes can be added to a map under test.
if (typeof SVGElement !== "undefined" && !("createSVGRect" in SVGElement.prototype)) {
  Object.defineProperty(SVGElement.prototype, "createSVGRect", { value: () => ({}) });
}

/**
 * No test may touch the network. The global fetch refuses before every test, so anything that
 * reaches for it by default fails loudly instead of calling out. A test that needs an API installs
 * the mocked one (tests/mockApi.ts), which replaces this. (tests/noNetwork.test.ts proves it.)
 */
const blockedFetch = (async () => {
  throw new Error("Network access is not allowed in tests");
}) as unknown as typeof fetch;

beforeEach(() => {
  vi.stubGlobal("fetch", blockedFetch);
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
