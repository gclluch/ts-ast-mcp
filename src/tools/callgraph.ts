import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, listTsFiles } from "../parse.js";
import { collectFunctionScopes } from "../scopes.js";
import { textResult, safeTool } from "../format.js";

interface CallEdge {
  caller: string;
  callee: string;
}

function collectCallEdges(
  sourceFile: ts.SourceFile,
  opts: { focusFunction?: string; includeExternal?: boolean },
): { edges: CallEdge[]; localFunctions: Set<string> } {
  const scopes = collectFunctionScopes(sourceFile);
  const scopeNodes = new Set<ts.Node>(scopes.map(s => s.node));
  const edges: CallEdge[] = [];

  // Every spelling a call site could use for a definition in this file. A
  // method written `Caller.viaMethod` is called as `this.viaMethod()`, so the
  // bare segment has to be callable too.
  // Three sets, because a call site's text means different things depending on
  // how it is written. Registering every member's bare name as callable made
  // `rows.map(...)` resolve to a class method called `map`: an edge to
  // Array.prototype.map, drawn as if it were local.
  const declared = new Set<string>();   // full dotted names
  const topLevel = new Set<string>();   // callable unqualified from anywhere
  const members = new Set<string>();    // reachable as `this.x` / `super.x`
  for (const s of scopes) {
    declared.add(s.name);
    if (!s.name.includes(".")) topLevel.add(s.name);
    if (s.isMember) members.add(s.name.split(".").pop()!);
  }

  /** Does this call site's text name a definition in this file? */
  const resolves = (callee: string, caller: string): boolean => {
    if (declared.has(callee)) return true;
    const dot = callee.lastIndexOf(".");
    if (dot < 0) {
      // Unqualified: lexical lookup, innermost scope outwards. The caller's
      // own body comes first - `viaNested` calling `inner()` means the `inner`
      // declared inside it - then each enclosing container, so `helper()` in
      // `Outer.Inner.fn` finds `Outer.helper`, then module scope.
      let prefix = caller;
      for (;;) {
        if (declared.has(`${prefix}.${callee}`)) return true;
        const cut = prefix.lastIndexOf(".");
        if (cut < 0) break;
        prefix = prefix.slice(0, cut);
      }
      return topLevel.has(callee);
    }
    const receiver = callee.slice(0, dot);
    return (receiver === "this" || receiver === "super") && members.has(callee.slice(dot + 1));
  };

  // Package scope resolves a call site's text against this set; it writes the
  // bare name, so both spellings belong in it.
  const localFunctions = new Set([...declared, ...topLevel, ...members]);

  for (const scope of scopes) {
    if (opts.focusFunction && !nameMatches(scope.name, opts.focusFunction)) continue;

    // Stop at any nested definition that owns a scope of its own, or its calls
    // would be reported against this function as well as against itself.
    // Anonymous callbacks are not scopes: a call inside one really is made by
    // the function the callback is written in.
    const walkCalls = (node: ts.Node) => {
      if (node !== scope.node && scopeNodes.has(node)) return;
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        const callee = ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)
          ? expr.getText(sourceFile)
          : "<dynamic>";
        if (callee !== "<dynamic>") {
          if (resolves(callee, scope.name) || opts.includeExternal) {
            edges.push({ caller: scope.name, callee });
          }
        }
      }
      ts.forEachChild(node, walkCalls);
    };
    // Start at the body, not the declaration: a decorator and a parameter
    // default are attached to the declaration but are not calls this function
    // makes - `@Log() method() {}` was reporting an edge method --> Log.
    walkCalls(scope.body ?? scope.node);
  }

  return { edges, localFunctions };
}

/** `Class.method` also answers to `method`, and `method` to itself. */
function nameMatches(scopeName: string, target: string): boolean {
  return scopeName === target || scopeName.endsWith(`.${target}`);
}

function toMermaid(edges: CallEdge[], direction: string): string {
  if (edges.length === 0) return "No call edges found.";

  const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, "_");
  const lines = [`flowchart ${direction}`];
  const seen = new Set<string>();

  for (const edge of edges) {
    const key = `${edge.caller}->${edge.callee}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`  ${sanitize(edge.caller)}["${edge.caller}"] --> ${sanitize(edge.callee)}["${edge.callee}"]`);
  }

  return lines.join("\n");
}

function collectPackageCallEdges(
  target: string,
  opts: { focusFunction?: string; includeExternal?: boolean },
): { edges: CallEdge[]; localFunctions: Set<string> } {
  // Both call sites pass the tool's `path`, which is a file. "Package" scope
  // means the directory that file lives in.
  const dir = fs.existsSync(target) && fs.statSync(target).isFile()
    ? path.dirname(target)
    : target;
  const files = listTsFiles(dir, true);
  const allEdges: CallEdge[] = [];
  const allLocalFunctions = new Set<string>();

  // Names are only unique within a file. Collect per-file first, then qualify:
  // merging on the bare name made every `register()` in the package collapse
  // into one node that appeared to call everything any of them called.
  const perFile = files.map(file => {
    const sf = parseFile(file);
    const { edges, localFunctions } = collectCallEdges(sf, { ...opts, includeExternal: true });
    return { file, edges, localFunctions };
  });

  // name -> files that define it, used to point a call at the right definition.
  const definedIn = new Map<string, string[]>();
  for (const { file, localFunctions } of perFile) {
    for (const fn of localFunctions) {
      const entry = definedIn.get(fn);
      if (entry) entry.push(file); else definedIn.set(fn, [file]);
    }
  }

  const qualify = (file: string, name: string) => `${path.basename(file)}#${name}`;

  for (const { file, localFunctions } of perFile) {
    for (const fn of localFunctions) allLocalFunctions.add(qualify(file, fn));
  }

  for (const { file, edges, localFunctions } of perFile) {
    for (const edge of edges) {
      let callee = edge.callee;
      if (localFunctions.has(callee)) {
        // A definition in the same file wins: that is what the call resolves to.
        callee = qualify(file, callee);
      } else {
        const candidates = definedIn.get(callee);
        // Only qualify when there is exactly one definition package-wide.
        // Anything ambiguous stays bare rather than inventing a resolution -
        // this is a syntactic walker, not a type checker.
        if (candidates && candidates.length === 1) callee = qualify(candidates[0], callee);
      }
      allEdges.push({ ...edge, caller: qualify(file, edge.caller), callee });
    }
  }

  // Filter to only local if not including external
  const filtered = opts.includeExternal
    ? allEdges
    : allEdges.filter(e => allLocalFunctions.has(e.callee));

  return { edges: filtered, localFunctions: allLocalFunctions };
}

export function register(server: McpServer) {
  server.tool(
    "call_graph",
    "Generates a Mermaid flowchart showing the call graph of functions in a TypeScript/JavaScript file or directory",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      function: z.string().optional().describe("Focus on calls reachable from this function only"),
      include_external: z.boolean().optional().default(false).describe("Include calls to external functions"),
      direction: z.enum(["TD", "LR"]).optional().default("TD").describe("Graph direction: TD (top-down) or LR (left-right)"),
      scope: z.enum(["file", "package"]).optional().default("file").describe("Analysis scope: 'file' or 'package'"),
    },
    safeTool("generate call graph", ({ path: filePath, function: focusFunction, include_external, direction, scope }) => {
      const opts = { focusFunction, includeExternal: include_external };
      const { edges } = scope === "package"
        ? collectPackageCallEdges(filePath, opts)
        : collectCallEdges(parseFile(filePath), opts);
      return textResult(toMermaid(edges, direction));
    }),
  );

  server.tool(
    "get_callers",
    "Finds all functions in a file or package that call the specified function (reverse call graph)",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      function: z.string().describe("Name of the target function (e.g., 'setup' or 'MyClass.method')"),
      scope: z.enum(["file", "package"]).optional().default("file").describe("Analysis scope: 'file' or 'package'"),
    },
    safeTool("find callers", ({ path: filePath, function: targetFunction, scope }) => {
      const { edges } = scope === "package"
        ? collectPackageCallEdges(filePath, { includeExternal: true })
        : collectCallEdges(parseFile(filePath), { includeExternal: true });

      const callers = edges
        // In package scope names carry a `file.ts#` prefix, so match on the
        // bare name too - a caller should be findable without knowing which
        // file the callee happens to live in.
        .filter(e => {
          const bare = e.callee.includes("#") ? e.callee.slice(e.callee.indexOf("#") + 1) : e.callee;
          return bare === targetFunction || bare.endsWith(`.${targetFunction}`);
        })
        .map(e => e.caller);

      if (callers.length === 0) return textResult(`No callers found for "${targetFunction}".`);

      const unique = [...new Set(callers)];
      const lines = [`Callers of "${targetFunction}" (${unique.length} found):`, ""];
      for (const c of unique) {
        lines.push(`  ${c}`);
      }
      return textResult(lines.join("\n"));
    }),
  );
}
