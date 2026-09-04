/**
 * Workspace path confinement for the file-explorer endpoints.
 *
 * Mirrors the realpath + root-containment discipline of sessions.js: a
 * client-supplied path is only usable when its real path (symlinks resolved)
 * sits inside one of the allowed workspace roots. Without this, any page that
 * can reach the API (a compromised localhost page, a misconfigured hosted UI
 * origin) could read, write, or delete arbitrary files on the machine.
 */
import { realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

/** True when `candidate` is `root` itself or lives under it. */
export function isWithinRoot(candidate, root) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

/**
 * Resolve the nearest existing ancestor of `path` (symlinks resolved) and
 * re-join the missing suffix, so a not-yet-created file under a symlinked
 * prefix (e.g. /tmp -> /private/tmp on macOS) still confines correctly.
 */
function resolveNearestExisting(path) {
  const missing = [];
  let current = path;
  for (;;) {
    try {
      const real = realpathSync(current);
      if (missing.length === 0) return real;
      return join(real, ...[...missing].reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path; // walked past the root; give up
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `requested` and verify it is confined to one of `roots`.
 * Symlinks are resolved for paths that exist, so a link pointing outside the
 * roots is rejected; paths that do not exist yet (a file being created) are
 * checked by their lexical location. Returns the resolved path, or throws.
 */
export function confinePath(requested, roots) {
  if (typeof requested !== "string" || !requested.trim())
    throw new Error("Missing path.");
  const requestedPath = resolve(requested);
  let candidate = requestedPath;
  try {
    candidate = realpathSync(requestedPath);
  } catch {
    // Path may not exist yet (e.g. a file being created); resolve the nearest
    // existing ancestor so symlinked prefixes still confine correctly.
    candidate = resolveNearestExisting(requestedPath);
  }
  for (const root of roots) {
    let rootReal = root;
    try {
      rootReal = realpathSync(root);
    } catch {
      /* root may not exist yet; fall back to its lexical form */
    }
    if (isWithinRoot(candidate, rootReal)) return requestedPath;
  }
  throw new Error("That path is outside the allowed workspace roots.");
}

/**
 * The default workspace root set: the directory the server was launched in,
 * plus any explicit roots from PI_WEB_WORKSPACE_ROOTS (colon-separated).
 * Session cwds are added to the live set as agents start, so opening a saved
 * session from another project keeps working.
 */
export function defaultWorkspaceRoots() {
  const roots = [process.cwd()];
  for (const entry of String(process.env.PI_WEB_WORKSPACE_ROOTS || "").split(
    ":",
  )) {
    const trimmed = entry.trim();
    if (trimmed) roots.push(resolve(trimmed));
  }
  return roots;
}
