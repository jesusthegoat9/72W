/**
 * Node emits "ExperimentalWarning: SQLite is an experimental feature" the
 * first time `node:sqlite` loads. Next dev captures server stderr and shows
 * it in the browser console as an error, which is noise for a warning we
 * accept on purpose (local dev and tests only; production uses D1).
 *
 * Node's internals raise it through the public `process.emitWarning`, so
 * wrapping that function drops exactly this warning before it ever becomes a
 * `warning` event. Nothing else changes: other warnings take the original
 * path, so `process.on`, `once` and `removeListener` behave as usual.
 * Must run before the first import of `node:sqlite` in the process.
 */
type EmitWarning = typeof process.emitWarning;

let original: EmitWarning | null = null;

function isSqliteExperimental(warning: unknown, rest: unknown[]): boolean {
  let message: string | undefined;
  let type: string | undefined;
  if (typeof warning === "string") {
    message = warning;
    const opt = rest[0];
    type = typeof opt === "string" ? opt : typeof opt === "object" && opt !== null ? (opt as { type?: string }).type : undefined;
  } else if (warning instanceof Error) {
    message = warning.message;
    type = warning.name;
  }
  return type === "ExperimentalWarning" && typeof message === "string" && /\bSQLite\b/.test(message);
}

export function muteSqliteExperimentalWarning(): void {
  if (original) return;
  if (typeof process === "undefined" || typeof process.emitWarning !== "function") return;
  const orig: EmitWarning = process.emitWarning;
  original = orig;
  const filtered = function (this: unknown, warning: unknown, ...rest: unknown[]) {
    if (isSqliteExperimental(warning, rest)) return;
    return (orig as (...a: unknown[]) => void).apply(process, [warning, ...rest]);
  };
  process.emitWarning = filtered as unknown as EmitWarning;
}

/** Undo the wrapper (tests). */
export function restoreEmitWarning(): void {
  if (!original) return;
  process.emitWarning = original;
  original = null;
}
