// Fixture: exercises destructuring, implementations, and unreferenced symbols.

export interface Greeter {
  greet(name: string): string;
}

export class LoudGreeter implements Greeter {
  greet(name: string): string {
    return `HELLO ${name.toUpperCase()}`;
  }
}

/** Structural match only - no `implements` clause. */
export class QuietGreeter {
  greet(name: string): string {
    return `hi ${name}`;
  }
}

const config = { alpha: 1, beta: 2 };

// Destructuring: binds `alpha` and `beta`, NOT a symbol named "{ alpha, beta }".
export const { alpha, beta } = config;

// NOT exported, so dead_code actually inspects it. Both names are used below,
// so neither is dead - but keyed on the literal text "{ gamma, delta }" they
// match no identifier and both get falsely reported.
const { gamma, delta } = { gamma: 3, delta: 4 };

// Never referenced anywhere - the one true dead symbol in this fixture.
type UnusedShape = { gone: true };

function usedHelper(n: number): number {
  return n * 2;
}

export function entry(n: number): number {
  return usedHelper(n) + alpha + beta + gamma + delta;
}
