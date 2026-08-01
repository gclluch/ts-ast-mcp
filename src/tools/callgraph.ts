import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, isArrowOrFunctionExpr, listTsFiles } from "../parse.js";
import { textResult, safeTool } from "../format.js";

interface CallEdge {
  caller: string;
  callee: string;
}

function collectCallEdges(
  sourceFile: ts.SourceFile,
  opts: { focusFunction?: string; includeExternal?: boolean },
): { edges: CallEdge[]; localFunctions: Set<string> } {
  const localFunctions = new Set<string>();
  const edges: CallEdge[] = [];

  // First pass: collect all local function names
  function collectNames(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      localFunctions.add(node.name.getText(sourceFile));
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.getText(sourceFile);
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          localFunctions.add(`${className}.${member.name.getText(sourceFile)}`);
        }
        if (ts.isConstructorDeclaration(member)) {
          localFunctions.add(`${className}.constructor`);
        }
      }
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isVariableDeclaration(decl) && isArrowOrFunctionExpr(decl)) {
          localFunctions.add(decl.name.getText(sourceFile));
        }
      }
    }
  }

  ts.forEachChild(sourceFile, collectNames);

  // Second pass: collect call edges
  function visitBody(body: ts.Node, callerName: string) {
    function walkCalls(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        let callee: string;

        if (ts.isIdentifier(expr)) {
          callee = expr.getText(sourceFile);
        } else if (ts.isPropertyAccessExpression(expr)) {
          callee = expr.getText(sourceFile);
        } else {
          callee = "<dynamic>";
        }

        if (callee !== "<dynamic>") {
          const isLocal = localFunctions.has(callee) ||
            localFunctions.has(callee.split(".").pop()!);
          if (isLocal || opts.includeExternal) {
            edges.push({ caller: callerName, callee });
          }
        }
      }
      ts.forEachChild(node, walkCalls);
    }
    ts.forEachChild(body, walkCalls);
  }

  function extractCalls(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const name = node.name.getText(sourceFile);
      if (!opts.focusFunction || name === opts.focusFunction) {
        visitBody(node.body, name);
      }
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.getText(sourceFile);
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && member.body) {
          const methodName = `${className}.${member.name.getText(sourceFile)}`;
          if (!opts.focusFunction || methodName === opts.focusFunction ||
              member.name.getText(sourceFile) === opts.focusFunction) {
            visitBody(member.body, methodName);
          }
        }
        if (ts.isConstructorDeclaration(member) && member.body) {
          const ctorName = `${className}.constructor`;
          if (!opts.focusFunction || ctorName === opts.focusFunction) {
            visitBody(member.body, ctorName);
          }
        }
      }
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isVariableDeclaration(decl) && isArrowOrFunctionExpr(decl)) {
          const name = decl.name.getText(sourceFile);
          if (!opts.focusFunction || name === opts.focusFunction) {
            visitBody(decl.initializer!, name);
          }
        }
      }
    }
  }

  ts.forEachChild(sourceFile, extractCalls);

  return { edges, localFunctions };
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
