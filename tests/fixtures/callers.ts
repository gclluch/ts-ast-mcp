// Eight distinct ways to call `target`. All eight must be found, each attributed
// to the function it is actually written in.

export function target(): number {
  return 1;
}

export class Caller {
  viaMethod(): number {
    return target();
  }

  static viaStatic(): number {
    return target();
  }

  get viaGetter(): number {
    return target();
  }

  set viaSetter(v: number) {
    target();
  }

  viaArrowProp = (): number => target();

  constructor() {
    target();
  }
}

export const viaArrowConst = (): number => target();

export function viaNested(): number {
  // `inner` is the caller, not `viaNested`. Flattening it into the parent
  // reports a call site that does not exist and hides one that does.
  function inner(): number {
    return target();
  }
  return inner();
}

export namespace Ns {
  export function viaNamespace(): number {
    return target();
  }
}

export const obj = {
  viaObjectMethod(): number {
    return target();
  },
  viaObjectArrow: (): number => target(),
};

// Not a caller: only mentions the name.
export function mentionsOnly(): string {
  return "target";
}
