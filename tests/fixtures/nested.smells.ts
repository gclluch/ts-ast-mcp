// Fixture: everything worth reporting lives inside a nested function.
// Only top-level declarations used to be visited, so this file read as clean.

export function outerWrapper(): void {
  function innerSmelly(a: any, b: any, c: number, d: number, e: number, f: number): void {
    const cast = b as any;
    if (a) {
      if (b) {
        if (c) {
          if (d) {
            if (e) {
              console.log(cast, f);
            }
          }
        }
      }
    }
  }
  innerSmelly(1, 2, 3, 4, 5, 6);
}
