import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange } from "../parse.js";
import { collectFunctionScopes, findScopes, withoutOverloadSignatures } from "../scopes.js";
import { type ComplexityResult, formatComplexity, textResult, safeTool } from "../format.js";

/** Nodes that own their own complexity score rather than contributing to a parent's. */
function isFunctionLike(n: ts.Node): boolean {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) || ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n);
}

function computeComplexity(node: ts.Node): number {
  let complexity = 1; // base path

  function walk(n: ts.Node) {
    // A nested function is scored separately, so its branches must not be
    // added to the enclosing function's total. Without this, a trivial wrapper
    // around a branchy helper reports the helper's score as its own.
    if (isFunctionLike(n)) return;

    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression: // ternary
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.CaseClause:
        complexity++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const binExpr = n as ts.BinaryExpression;
        if (binExpr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            binExpr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            binExpr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
          complexity++;
        }
        break;
      }
    }
    ts.forEachChild(n, walk);
  }

  // A concise arrow's body IS the expression, so walking only its children
  // skipped the decision point itself: `(x) => x ? 1 : 2` scored 1, not 2.
  // A Block is never a decision point, so descending into it is the same walk
  // - and a body that is itself a function must be descended into too, or
  // `(a) => (b) => a ? b : 0` is scored by nobody: `walk` bails on a
  // function-like node, and the returned arrow is not a scope of its own.
  if (ts.isBlock(node) || isFunctionLike(node)) ts.forEachChild(node, walk);
  else walk(node);
  return complexity;
}

function collectComplexity(sourceFile: ts.SourceFile, targetFunction?: string): ComplexityResult[] {
  // One walker for every construct that owns code, shared with list_functions
  // and call_graph. Accessors used to be missing here: a getter with a
  // decision tree in it was simply not scored.
  const all = withoutOverloadSignatures(collectFunctionScopes(sourceFile))
    .filter(s => s.body !== undefined);
  // `findScopes` is the same lookup get_function_body and get_callers use, so
  // `function: "description"` resolves `BaseCar.description` here too. An
  // exact-match filter answered "no functions found" for a name the other
  // tools resolve.
  return (targetFunction ? findScopes(all, targetFunction) : all)
    .map(s => ({
      name: s.name,
      complexity: computeComplexity(s.body!),
      line: getLineRange(sourceFile, s.node)[0],
    }));
}

export function register(server: McpServer) {
  server.tool(
    "code_complexity",
    "Computes cyclomatic complexity for functions in a TypeScript/JavaScript file",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      function: z.string().optional().describe("Compute only for this function (omit for all)"),
    },
    safeTool("compute complexity", ({ path: filePath, function: targetFunction }) => {
      const sf = parseFile(filePath);
      const results = collectComplexity(sf, targetFunction);
      return textResult(formatComplexity(results, filePath));
    }),
  );
}
