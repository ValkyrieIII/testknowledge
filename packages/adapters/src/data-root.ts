import { resolve } from "node:path";

/** Resolve user-facing paths against the directory that invoked a package-manager script. */
export function resolveInvocationPath(path: string): string {
  return resolve(process.env.INIT_CWD || process.cwd(), path);
}

export function resolveDataRoot(configured = ".testknowledge"): string {
  return resolveInvocationPath(configured);
}
