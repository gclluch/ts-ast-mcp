// Fixture: separates "has a method with the right name" from "actually satisfies
// the interface". Name-only matching reported every class below as an
// implementation of Runner.

export interface Runner {
  run(times: number): string;
}

/** Memberless: every class is assignable to it, so a match list means nothing. */
export interface Anything {}

/** Explicit clause. */
export class RealRunner implements Runner {
  run(times: number): string {
    return `${times}`;
  }
}

/** No clause, but the shape genuinely matches. */
export class QuietRunner {
  run(times: number): string {
    return `${times}!`;
  }
}

/** Right name, wrong return type. */
export class WrongReturnType {
  run(times: number): number {
    return times;
  }
}

/** Right name, wrong parameter type. */
export class WrongParamType {
  run(times: string): string {
    return times;
  }
}

/** Right name, demands an argument the interface never supplies. */
export class TooManyParams {
  run(times: number, label: string): string {
    return `${label}${times}`;
  }
}

/** No `run` at all - the trivial negative. */
export class NotARunner {
  walk(): string {
    return "walking";
  }
}

export function useProbe(): number {
  // Same identifier name as the unexported, unreferenced `probe` in collide.ts.
  // A cross-file bare-name scan counted this as a use of that one.
  const probe = 2;
  return probe;
}
