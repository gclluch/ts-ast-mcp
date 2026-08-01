export function outer(n: number): number {
  function nestedHelper(a: number, b: number, c: number, d: number, e: number, f: number): number {
    if (a) { if (b) { if (c) { if (d) { if (e) { return f; } } } } }
    return 0;
  }
  return nestedHelper(n, n, n, n, n, n);
}

export namespace InsideNamespace {
  export function insideNs(): number { return 1; }
}

export function simple(): number { return 2; }
