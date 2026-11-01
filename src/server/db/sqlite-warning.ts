/**
 * Node prints "ExperimentalWarning: SQLite is an experimental feature" the
 * first time `node:sqlite` loads. Next dev captures server stderr and shows
 * it in the browser console as an error, which is noise for a warning we
 * accept on purpose (local dev and tests only; production uses D1).
 *
 * This drops exactly that warning and re-dispatches every other warning to
 * Node's own handlers, so nothing else is hidden. It must run before the
 * first import of `node:sqlite` in the process, which is why the sqlite
 * adapter is only ever imported dynamically after calling this.
 */
let installed = false;

export function muteSqliteExperimentalWarning(): void {
  if (installed) return;
  if (typeof process === "undefined" || typeof process.on !== "function" || typeof process.listeners !== "function") return;
  installed = true;
  const defaults = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error) => {
    if (warning.name === "ExperimentalWarning" && /\bSQLite\b/.test(warning.message)) return;
    for (const listener of defaults) listener.call(process, warning);
  });
}
