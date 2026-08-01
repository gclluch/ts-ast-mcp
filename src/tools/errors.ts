import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange } from "../parse.js";
import { type ErrorFinding, formatErrors, textResult, safeTool } from "../format.js";

/**
 * Names of functions this file declares `async`.
 *
 * A syntactic tool cannot know a call's return type, so the previous version
 * guessed from the callee's *name* against a verb list
 * (get/send/update/delete/save/...). Those are ordinary method names: it
 * reported `map.get(k)` and `map.delete(k)` as unhandled promises while missing
 * a real `saveUser()`, because the list matched whole names only. Resolving the
 * callee to an `async` declaration in the same file is narrower - it says
 * nothing about imported functions - but it does not invent findings.
 */
function collectAsyncNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name && hasAsyncModifier(node)) {
      names.add(node.name.getText(sourceFile));
    }
    // `const f = async () => {}` carries the modifier on the initializer, not
    // on the declaration that names it.
    if (ts.isVariableDeclaration(node) && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
        hasAsyncModifier(node.initializer)) {
      names.add(node.name.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return names;
}

function detectErrors(sourceFile: ts.SourceFile, targetFunction?: string): ErrorFinding[] {
  const errors: ErrorFinding[] = [];
  const asyncNames = collectAsyncNames(sourceFile);

  function isInsideFunction(node: ts.Node, funcName?: string): boolean {
    if (!funcName) return true;
    let current = node.parent;
    while (current) {
      if (ts.isFunctionDeclaration(current) && current.name?.getText(sourceFile) === funcName) return true;
      if (ts.isMethodDeclaration(current) && current.name?.getText(sourceFile) === funcName) return true;
      if (ts.isVariableDeclaration(current) && current.name.getText(sourceFile) === funcName) return true;
      current = current.parent;
    }
    return false;
  }

  function visit(node: ts.Node) {
    if (targetFunction && !isInsideFunction(node, targetFunction)) {
      ts.forEachChild(node, visit);
      return;
    }

    // Empty catch blocks
    if (ts.isCatchClause(node)) {
      const block = node.block;
      if (block.statements.length === 0) {
        const [line] = getLineRange(sourceFile, node);
        errors.push({
          kind: "empty_catch",
          location: `line ${line}`,
          message: "Empty catch block swallows errors silently",
        });
      }
    }

    // Floating promises: a call statement whose result is discarded, where the
    // callee is a function this file declares `async`.
    //
    // An awaited call is an AwaitExpression, not a CallExpression, so anything
    // reaching here already discards its value - there is no separate "is it
    // awaited" test to make.
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const callee = node.expression.expression;
      const callName = ts.isPropertyAccessExpression(callee)
        ? callee.name.getText(sourceFile)
        : callee.getText(sourceFile);
      if (asyncNames.has(callName) || callName === "fetch") {
        const [line] = getLineRange(sourceFile, node);
        errors.push({
          kind: "floating_promise",
          location: `line ${line}`,
          message: `Unhandled promise: ${node.getText(sourceFile).substring(0, 80)}`,
        });
      }
    }

    // Unsafe type assertions (as X without null check)
    if (ts.isAsExpression(node)) {
      const typeText = node.type.getText(sourceFile);
      if (typeText !== "any" && typeText !== "unknown" && typeText !== "const") {
        // Check if it's a double assertion (expr as unknown as Type)
        if (ts.isAsExpression(node.expression)) {
          const [line] = getLineRange(sourceFile, node);
          errors.push({
            kind: "double_assertion",
            location: `line ${line}`,
            message: `Double type assertion: ${node.getText(sourceFile).substring(0, 80)}`,
          });
        }
      }
    }

    // Non-null assertion in optional chain (x?.y!)
    if (ts.isNonNullExpression(node) && node.expression.getText(sourceFile).includes("?.")) {
      const [line] = getLineRange(sourceFile, node);
      errors.push({
        kind: "optional_chain_non_null",
        location: `line ${line}`,
        message: `Non-null assertion on optional chain defeats safety: ${node.getText(sourceFile).substring(0, 80)}`,
      });
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return errors;
}

function hasAsyncModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

export function register(server: McpServer) {
  server.tool(
    "find_errors",
    "Analyzes TypeScript-specific error patterns: floating promises, empty catches, unsafe type assertions, double assertions",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      function: z.string().optional().describe("Scope analysis to a specific function"),
    },
    safeTool("find errors", ({ path: filePath, function: targetFunction }) => {
      const sf = parseFile(filePath);
      const findings = detectErrors(sf, targetFunction);
      return textResult(formatErrors(findings, filePath));
    }),
  );
}
