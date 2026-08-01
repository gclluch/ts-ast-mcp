// Sibling module in the same directory: gives "package" scope something to
// find that "file" scope cannot.

import { entry } from "./shapes.js";

export function callsEntry(): number {
  return entry(21);
}
