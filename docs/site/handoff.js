// Passes a document from one page to another. The converter's
// "Open in ES3D Studio" button uses it, through localStorage.
// Storage can be missing (a private window, blocked site data, a sandboxed
// preview), so every access is guarded and the caller gets a plain yes or no.

const KEY = 'es3d:handoff';
/** localStorage holds about 5 MB of UTF-16 text in most browsers. */
export const HANDOFF_LIMIT = 2_000_000;

export function writeHandoff(name, text) {
  if (text.length > HANDOFF_LIMIT) return false;
  try {
    localStorage.setItem(KEY, JSON.stringify({ name, text, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** The handed-over document ({name, text}) or null; it is removed once read. */
export function readHandoff() {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data.text === 'string' ? data : null;
  } catch {
    return null;
  }
}
