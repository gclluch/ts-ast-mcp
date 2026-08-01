import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange } from "../parse.js";
import { type ErrorFinding, formatErrors, textResult, safeTool } from "../format.js";

function detectErrors(sourceFile: ts.SourceFile, targetFunction?: string): ErrorFinding[] {
  const errors: ErrorFinding[] = [];

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

    // Floating promises (expression statements that are call expressions returning promise-like)
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const callText = node.expression.expression.getText(sourceFile);
      // Heuristic: async-looking call without await
      if (ts.isAwaitExpression(node.expression)) {
        // It's awaited, fine
      } else {
        // Check parent - if we're in an async function, flag unhandled call expressions
        // that look like they return promises (fetch, async methods)
        const parent = findParentFunction(node);
        if (parent && hasAsyncModifier(parent)) {
          // Only flag calls that look like promise-returning
          const callName = callText.split(".").pop() ?? callText;
          const asyncPatterns = /^(fetch|then|catch|finally|save|create|update|delete|remove|send|post|get|put|patch)$/i;
          if (asyncPatterns.test(callName) || callText.endsWith("Async")) {
            const [line] = getLineRange(sourceFile, node);
            errors.push({
              kind: "floating_promise",
              location: `line ${line}`,
              message: `Potentially unhandled promise: ${node.getText(sourceFile).substring(0, 80)}`,
            });
          }
        }
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

function findParentFunction(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) ||
        ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
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
