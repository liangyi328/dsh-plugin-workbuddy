/**
 * REMOVED FEATURE — kept only to clean up after it.
 *
 * An earlier version of this plugin injected a "上下文窗口" (context window) row
 * into the built-in model menu by rewriting the dsh-client-ui-model-selection
 * bundle's bytes in memory through the `clientModules` service. The feature has
 * been removed at the user's request; what remains here is the exact marker and
 * strip logic, so `uninstallMenuPatch` in index.js can restore the pristine
 * bundle on every boot until the last patched copy has been served out.
 */

/** Package id owning the model menu. */
export const TARGET = '@deepseek-ai/dsh-client-ui-model-selection';

/** Marker making a patched bundle detectable without parsing. */
const MARKER = '__WB_MODEL_MENU_ROW__';

/**
 * Whether these bundle bytes carry the removed row injection.
 * @param {string} source - bundle source text.
 * @returns {boolean} true when patched.
 */
export function isPatched(source) {
  return typeof source === 'string' && source.includes(MARKER);
}

/**
 * Remove the injected row expression, restoring the original bundle text.
 * @param {string} source - patched bundle source text.
 * @returns {string | null} unpatched source, or null when the marker is absent
 *   or the inserted block cannot be located.
 */
export function stripPatch(source) {
  if (!isPatched(source)) return null;
  const at = source.indexOf(MARKER);
  // The inserted block was exactly `\n` + rowExpression() + `,` at the anchor's
  // close. Its first line was the IIFE head (`(() => {`); the marker sat on the
  // SECOND line, so anchoring the deletion on the marker's own line would orphan
  // that head. Delete from the first line of the block instead: the newline just
  // before it, located by scanning back from the marker past the known first
  // line.
  const lineStart = source.lastIndexOf('\n', at);
  if (lineStart === -1) return null;
  const head = '\n(() => {\n';
  const blockStart = source.lastIndexOf(head, lineStart);
  if (blockStart === -1) return null;
  const tail = source.indexOf('\n})(),', at);
  if (tail === -1) return null;
  const end = tail + '\n})(),'.length;
  return source.slice(0, blockStart) + source.slice(end);
}
