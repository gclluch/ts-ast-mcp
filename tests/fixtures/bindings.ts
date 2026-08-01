// Destructured declarations: list_declarations and diff_ast must report the
// bound names, not the literal pattern text.
export const { alpha, beta } = { alpha: 1, beta: 2 };
const [first, second] = [1, 2];
export const plain: number = 3;

export function scopedTarget(x: any) {
  const inside = x as any;
  return inside!;
}

export function otherFunction(y: any) {
  const elsewhere = y as any;
  return elsewhere!;
}
