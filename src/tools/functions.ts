import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, extractSource, getLineRange } from "../parse.js";
import {
  type FunctionScope,
  collectFunctionScopes,
  findScopes,
  signatureOf,
  withoutOverloadSignatures,
} from "../scopes.js";
import { textResult, safeTool } from "../format.js";
import { findTypeNode } from "./types.js";

/**
 * How a function reads on one line. Every qualifier that changes what the
 * caller may do with it is present: `static` because `Cls.build()` is not
 * `instance.build()`, and `get`/`set` because an accessor is used as a
 * property. Leaving either out made two different members render identically.
 */
function describe(
  scope: FunctionScope,
  sf: ts.SourceFile,
  // list_methods was asked about one type, so repeating that type's export
  // status on every row is noise; `private`/`protected` already say what
  // differs between the members.
  showExported = true,
): string {
  const parts = [
    scope.visibility,
    scope.isStatic ? "static" : "",
    scope.kind === "get" || scope.kind === "set" ? scope.kind : "",
  ].filter(Boolean);
  const prefix = parts.length ? `${parts.join(" ")} ` : "";
  const [line, endLine] = getLineRange(sf, scope.node);
  const exp = showExported && scope.isExported ? " (exported)" : "";
  return `${prefix}${scope.name}${signatureOf(scope, sf)}${exp} [Lines ${line}-${endLine}]`;
}

/**
 * The declaration a caller means by `name`.
 *
 * Preferring a scope that has a body is the point: taking the first name match
 * returned an overload's bodyless signature from a tool called
 * *get function body*.
 */
function findFunctionScope(
  sourceFile: ts.SourceFile,
  targetName: string,
): FunctionScope | undefined {
  const matches = findScopes(collectFunctionScopes(sourceFile), targetName);
  return matches.find(s => s.body) ?? matches[0];
}

export function register(server: McpServer) {
  server.tool(
    "list_functions",
    "Lists all functions and methods in a TypeScript/JavaScript file with their signatures and line ranges",
    { path: z.string().describe("Absolute path to the TS/JS file") },
    safeTool(({ path: filePath }) => `list functions in ${filePath}`, ({ path: filePath }) => {
      const sf = parseFile(filePath);
      const funcs = withoutOverloadSignatures(collectFunctionScopes(sf));
      if (funcs.length === 0) return textResult(`No functions found in ${filePath}.`);
      return textResult(funcs.map(f => describe(f, sf)).join("\n"));
    }),
  );

  server.tool(
    "get_function_body",
    "Extracts the full body of a specific function or method. Supports Class.method syntax.",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      name: z.string().describe("Function name (e.g., 'setup' or 'MyClass.method')"),
    },
    safeTool("get function body", ({ path: filePath, name }) => {
      const sf = parseFile(filePath);
      const scope = findFunctionScope(sf, name);
      if (!scope) return textResult(`Function "${name}" not found in ${filePath}.`);
      // A `const f = () => ...` scope is the declarator, so that each declarator
      // in one statement is its own scope. The source a reader wants is the
      // whole statement, `export const` and all.
      const node = ts.isVariableDeclaration(scope.node) && scope.node.parent?.parent
        ? scope.node.parent.parent
        : scope.node;
      const [line, endLine] = getLineRange(sf, node);
      const source = extractSource(sf, node);
      return textResult(`${name} [Lines ${line}-${endLine}]:\n\n${source}`);
    }),
  );

  server.tool(
    "list_methods",
    "Lists all methods for a specific class or interface in a TypeScript/JavaScript file",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      type: z.string().describe("The class or interface name"),
    },
    safeTool("list methods", ({ path: filePath, type: typeName }) => {
      const sf = parseFile(filePath);
      // Resolve the declaration first so "no methods" and "no such type" stay
      // distinct. Filtering collectFunctions alone conflated them, and the
      // message said "class" either way - an interface always answered
      // "No methods found for class X", which reads as a verdict on X rather
      // than as this tool never having looked at it.
      const decl = findTypeNode(sf, typeName);
      if (!decl) return textResult(`Type "${typeName}" not found in ${filePath}.`);

      // The scope walker covers classes; it feeds list_functions, where an
      // interface member is not a function. Interfaces carry MethodSignatures.
      const lines = ts.isInterfaceDeclaration(decl)
        ? decl.members.filter(ts.isMethodSignature).map(m => {
            const params = m.parameters.map(p => p.getText(sf)).join(", ");
            const ret = m.type ? `: ${m.type.getText(sf)}` : "";
            // `stop?(): void` printed as `stop(): void` reads as required.
            const optional = m.questionToken ? "?" : "";
            const [line, endLine] = getLineRange(sf, m);
            return `${typeName}.${m.name.getText(sf)}${optional}(${params})${ret} [Lines ${line}-${endLine}]`;
          })
        : withoutOverloadSignatures(collectFunctionScopes(sf))
            .filter(f => f.className === typeName)
            .map(f => describe(f, sf, false));

      if (lines.length === 0) return textResult(`"${typeName}" declares no methods in ${filePath}.`);
      return textResult(lines.join("\n"));
    }),
  );
}
