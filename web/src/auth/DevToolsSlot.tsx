import { lazy, Suspense } from "react";

// `import.meta.env.DEV` is replaced by the literal false in a production build, which removes this
// declaration, the dynamic import, and therefore the whole switcher chunk from the bundle.
const LazySwitcher = import.meta.env.DEV ? lazy(() => import("./DevUserSwitcher")) : null;

/**
 * Where the development user switcher renders. It renders nothing unless the app is running in
 * development, and a production build does not even contain the switcher's code.
 */
export function DevToolsSlot() {
  if (!import.meta.env.DEV || !LazySwitcher) return null;
  return (
    <Suspense fallback={null}>
      <LazySwitcher />
    </Suspense>
  );
}
