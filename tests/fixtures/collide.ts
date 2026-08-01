// Fixture: a dead symbol whose name collides with an identifier in another file.
//
// `probe` is unexported and never referenced here, so it is dead. `impls.ts`
// declares an unrelated local also called `probe`; a scan that looked for the
// bare name in other files treated that as a use and never reported this.

function probe(): number {
  return 1;
}

export const collideMarker = "keeps this module non-empty";
