// Fixture: separates a discarded promise from an ordinary method call whose
// name happens to look async. `get` and `delete` were on a verb list, so the
// two Map calls were reported and the two real ones were not.

const cache = new Map<string, number>();

async function saveUser(): Promise<void> {}

export async function asyncCaller(): Promise<void> {
  cache.get("k");
  cache.delete("k");
  saveUser();
  await saveUser();
}

export function syncCaller(): void {
  // A non-async caller discards it just as thoroughly.
  saveUser();
}
