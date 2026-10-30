// Node globals that Solana libraries assume exist.
//
// This MUST live in its own module, imported first in main.tsx. Putting the
// assignment directly in main.tsx does not work: `import` declarations are
// hoisted and every imported module body runs BEFORE any plain statement in
// the importing file. So React, App and the whole @solana graph would
// evaluate — and throw — before the assignment ever ran.
//
// The symptom is not "Buffer is not defined" but a blank page and
//   TypeError: Cannot set properties of undefined (setting 'byteLength')
// from inside the solana vendor chunk, which is a library reaching for
// Buffer.prototype on a Buffer that isn't there yet.
import { Buffer } from "buffer";

if (!globalThis.Buffer) {
  globalThis.Buffer = Buffer;
}
