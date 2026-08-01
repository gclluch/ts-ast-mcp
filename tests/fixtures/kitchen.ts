// Every construct the audit found a tool blind to.

/** A vehicle. */
export interface Vehicle {
  wheels: number;
  start(): void;
  stop?(): void;
}

export abstract class BaseCar implements Vehicle {
  wheels = 4;
  #vin = "unset";
  protected serviceDue = false;

  constructor(public readonly make: string) {}

  start(): void {
    this.serviceDue = false;
  }

  // Accessors: functions by every meaningful definition.
  get description(): string {
    if (this.serviceDue) {
      return `${this.make} (service due)`;
    }
    return this.make;
  }

  set odometer(value: number) {
    if (value < 0) throw new RangeError("negative");
    this.serviceDue = value > 10_000;
  }

  static build(make: string): BaseCar {
    return new Sedan(make);
  }

  protected service(): void {
    this.serviceDue = true;
  }
}

export class Sedan extends BaseCar {
  private secret(): void {
    this.wheels = 4;
  }

  loud = (): string => this.description.toUpperCase();
}

// Overloads: three signatures, one implementation, one exported symbol.
export function parse(input: string): number;
export function parse(input: number): number;
export function parse(input: boolean): number;
export function parse(input: string | number | boolean): number {
  if (typeof input === "string") return Number(input);
  if (typeof input === "number") return input;
  return input ? 1 : 0;
}

export namespace Outer {
  export function helper(): number {
    return 1;
  }

  export namespace Inner {
    export function deeplyNested(): number {
      return helper();
    }
  }
}

// No parentheses: the ternary IS the arrow's body. Wrapped in parens the
// old walker reached it by accident, which is why this shape is the fixture.
export const concise = (n: number) => n > 0 ? "pos" : "neg";

export function messy(n: number): number {
  let total = 0;
  if (n > 0) total += 1;
  if (n > 1) total += 1;
  if (n > 2) total += 1;
  if (n > 3) total += 1;
  if (n > 4) total += 1;
  for (let i = 0; i < n; i++) total += i;
  for (const c of String(n)) total += c.length;
  switch (n) {
    case 1:
      total += 1;
      break;
    case 2:
      total += 2;
      break;
    default:
      break;
  }
  try {
    total += 1;
  } catch {
    total = 0;
  }
  return total;
}

export function withAnnotations(a: any): void {
  const forced = {} as any;
  const bang = forced!.thing;
  void a;
  void bang;
}

// ── shapes the shared-walker rewrite got wrong on the first pass ──────────

/** A decorator is attached to a declaration; it is not a call the method makes. */
export function Log() {
  return (target: unknown) => target;
}

export class Decorated {
  @Log() onlyDecorated(): void {}
  // A method named like a builtin: `rows.map(...)` below is Array.prototype.map.
  map(): void {}
  usesBuiltin(rows: number[]): void {
    rows.map(x => x);
    this.map();
  }
}

/** The returned arrow is not a scope of its own, so its branch belongs here. */
export const curried = (a: number) => (b: number) => (a ? b : 0);

export abstract class BodylessPair {
  abstract get pairValue(): number;
  abstract set pairValue(v: number);
}

export namespace Dotted.Inner {
  export function reached(): number {
    return 1;
  }
}

export class HoldsLiteral {
  handlers = { onClick: () => parse("1") };
}

/** An accessor with real smells in it: code_smells must see them. */
export class SmellyAccessor {
  private rows: number[][] = [];

  get worst(): number {
    let out = 0;
    for (const row of this.rows) {
      if (row) {
        for (const cell of row) {
          if (cell) {
            while (out < cell) {
              if (cell % 2 === 0) {
                out = cell;
              }
              out += 1;
            }
          }
        }
      }
    }
    return out;
  }

  set widen(value: any) {
    this.rows = value as any;
  }
}
