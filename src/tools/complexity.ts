import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange, isArrowOrFunctionExpr } from "../parse.js";
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

  ts.forEachChild(node, walk);
  return complexity;
}

function collectComplexity(sourceFile: ts.SourceFile, targetFunction?: string): ComplexityResult[] {
  const results: ComplexityResult[] = [];

  function processFunction(name: string, body: ts.Node, line: number) {
    if (targetFunction && name !== targetFunction) return;
    results.push({ name, complexity: computeComplexity(body), line });
  }

  // `prefix` builds a dotted path for nested definitions (`outer.helper`), so
  // two functions with the same short name in one file stay distinguishable -
  // and it matches the qualified names the Python sibling emits.
  function visit(node: ts.Node, prefix: string) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const name = prefix + node.name.getText(sourceFile);
      const [line] = getLineRange(sourceFile, node);
      processFunction(name, node.body, line);
      ts.forEachChild(node.body, child => visit(child, `${name}.`));
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const className = prefix + node.name.getText(sourceFile);
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && member.body) {
          const methodName = `${className}.${member.name.getText(sourceFile)}`;
          const [line] = getLineRange(sourceFile, member);
          processFunction(methodName, member.body, line);
          ts.forEachChild(member.body, child => visit(child, `${methodName}.`));
        }
        if (ts.isConstructorDeclaration(member) && member.body) {
          const ctorName = `${className}.constructor`;
          const [line] = getLineRange(sourceFile, member);
          processFunction(ctorName, member.body, line);
          ts.forEachChild(member.body, child => visit(child, `${ctorName}.`));
        }
      }
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isVariableDeclaration(decl) && isArrowOrFunctionExpr(decl)) {
          const name = prefix + decl.name.getText(sourceFile);
          const init = decl.initializer!;
          const body = (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? (init.body ?? init) : init;
          const [line] = getLineRange(sourceFile, node);
          processFunction(name, body, line);
          ts.forEachChild(body, child => visit(child, `${name}.`));
        }
      }
      return;
    }

    // Namespaces and plain blocks are not scopes worth naming, but the
    // functions inside them still are - keep descending.
    ts.forEachChild(node, child => visit(child, prefix));
  }

  ts.forEachChild(sourceFile, child => visit(child, ""));
  return results;
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
