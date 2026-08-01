// ── Shared types ────────────────────────────────────────────────────────

export interface FileSymbol {
  name: string;
  kind: string;
  exported: boolean;
  line: number;
  endLine: number;
  signature?: string;
}

/** A located, categorised remark about a span of code. */
export interface Finding {
  kind: string;
  location: string;
  message: string;
}

export type Smell = Finding;
export type ErrorFinding = Finding;

export interface ComplexityResult {
  name: string;
  complexity: number;
  line: number;
}

export interface DiffEntry {
  kind: "added" | "removed" | "modified";
  symbol: string;
  detail?: string;
}

// ── MCP response helpers ────────────────────────────────────────────────

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * Wraps a tool handler so a thrown error becomes a readable result instead of
 * killing the request. Every tool needs this, so it lives here once rather than
 * as a try/catch in each of them.
 *
 * `label` completes the sentence "Failed to ...", and may be a function when the
 * message should mention an argument.
 */
export function safeTool<A, R>(
  label: string | ((args: A) => string),
  handler: (args: A) => R,
) {
  return async (args: A) => {
    try {
      return handler(args);
    } catch (e) {
      const what = typeof label === "function" ? label(args) : label;
      return errorResult(`Failed to ${what}: ${(e as Error).message}`);
    }
  };
}

// ── Formatters ──────────────────────────────────────────────────────────

export function formatSymbols(symbols: FileSymbol[], filePath?: string): string {
  const header = filePath ? `File: ${filePath}\n` : "";
  if (symbols.length === 0) return header + "No symbols found.";

  const grouped = new Map<string, FileSymbol[]>();
  for (const sym of symbols) {
    const list = grouped.get(sym.kind) ?? [];
    list.push(sym);
    grouped.set(sym.kind, list);
  }

  const sections: string[] = [];
  if (header) sections.push(header);

  for (const [kind, items] of grouped) {
    sections.push(`${kind}:`);
    for (const item of items) {
      const exp = item.exported ? " (exported)" : "";
      const sig = item.signature ? ` - ${item.signature}` : "";
      sections.push(`  ${item.name}${exp} [Lines ${item.line}-${item.endLine}]${sig}`);
    }
  }

  return sections.join("\n");
}

function formatFindings(findings: Finding[], filePath: string, label: string): string {
  if (findings.length === 0) return `No ${label} found in ${filePath}.`;
  const lines = [`${label[0].toUpperCase()}${label.slice(1)} in ${filePath}:`, ""];
  for (const f of findings) {
    lines.push(`[${f.kind}] ${f.location}: ${f.message}`);
  }
  return lines.join("\n");
}

export const formatSmells = (smells: Smell[], filePath: string) =>
  formatFindings(smells, filePath, "code smells");

export const formatErrors = (errors: ErrorFinding[], filePath: string) =>
  formatFindings(errors, filePath, "error patterns");

export function formatComplexity(results: ComplexityResult[], filePath: string): string {
  if (results.length === 0) return `No functions found in ${filePath}.`;
  const lines = [`Cyclomatic complexity for ${filePath}:`, ""];
  for (const r of results) {
    lines.push(`  ${r.name} (line ${r.line}): ${r.complexity}`);
  }
  return lines.join("\n");
}

export function formatDiff(entries: DiffEntry[], oldPath: string, newPath: string): string {
  if (entries.length === 0) return `No structural differences between ${oldPath} and ${newPath}.`;
  const lines = [`Structural diff: ${oldPath} -> ${newPath}`, ""];
  for (const e of entries) {
    const prefix = e.kind === "added" ? "+" : e.kind === "removed" ? "-" : "~";
    const detail = e.detail ? ` (${e.detail})` : "";
    lines.push(`${prefix} ${e.symbol}${detail}`);
  }
  return lines.join("\n");
}
