import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange } from "../parse.js";
import {
  type FunctionScope,
  collectFunctionScopes,
  findScopes,
  withoutOverloadSignatures,
} from "../scopes.js";
import { type Smell, formatSmells, textResult, safeTool } from "../format.js";

const LONG_FUNCTION_LINES = 50;
const MANY_PARAMS = 5;
const DEEP_NESTING = 4;
const GOD_CLASS_METHODS = 15;

function detectSmells(sourceFile: ts.SourceFile, targetFunction?: string): Smell[] {
  const smells: Smell[] = [];
  const matchedFunctions: ts.Node[] = [];

  function checkNesting(node: ts.Node, depth: number, funcName: string) {
    const nestingNodes = [
      ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement,
      ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement,
      ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement,
      ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.TryStatement,
    ];

    // A nested function is checked in its own right, so descending into it here
    // would report its nesting twice - once under each enclosing function's name,
    // and at a depth that counts the outer function's blocks as its own.
    const descend = (child: ts.Node, childDepth: number) => {
      if (ts.isFunctionLike(child)) return;
      checkNesting(child, childDepth, funcName);
    };

    if (nestingNodes.includes(node.kind)) {
      if (depth >= DEEP_NESTING) {
        const [line] = getLineRange(sourceFile, node);
        smells.push({
          kind: "deep_nesting",
          location: `${funcName} (line ${line})`,
          message: `Nesting depth ${depth + 1} exceeds threshold of ${DEEP_NESTING}`,
        });
      }
      ts.forEachChild(node, child => descend(child, depth + 1));
      return;
    }
    ts.forEachChild(node, child => descend(child, depth));
  }

  function checkFunction(scope: FunctionScope) {
    const { name, node, params } = scope;
    // Remember the matched subtree so the file-wide checks below can be scoped
    // to it too, instead of reporting every `as any` in the file as if it were
    // inside the requested function.
    if (targetFunction) matchedFunctions.push(node);

    const [startLine, endLine] = getLineRange(sourceFile, node);
    const lineCount = endLine - startLine + 1;

    if (lineCount > LONG_FUNCTION_LINES) {
      smells.push({
        kind: "long_function",
        location: `${name} (line ${startLine})`,
        message: `${lineCount} lines exceeds threshold of ${LONG_FUNCTION_LINES}`,
      });
    }

    if (params.length > MANY_PARAMS) {
      smells.push({
        kind: "too_many_parameters",
        location: `${name} (line ${startLine})`,
        message: `${params.length} parameters exceeds threshold of ${MANY_PARAMS}`,
      });
    }

    // Nest-check the body, not the declaration: a `const f = () => {...}`
    // scope node is the declarator, whose child IS the arrow, and `descend`
    // stops at anything function-like - so its nesting was never examined.
    checkNesting(scope.body ?? node, 0, name);
  }

  function checkAnyCasts(node: ts.Node) {
    // `as any`
    if (ts.isAsExpression(node) && node.type.getText(sourceFile) === "any") {
      const [line] = getLineRange(sourceFile, node);
      smells.push({
        kind: "any_cast",
        location: `line ${line}`,
        message: `"as any" cast: ${node.getText(sourceFile).substring(0, 80)}`,
      });
    }

    // `: any` in parameters and variable declarations. Its own category: an
    // annotation is not a cast, and filing both under `any_cast` meant
    // filtering by category could not separate "this value was forced" from
    // "this value was never typed".
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
        node.type && node.type.getText(sourceFile) === "any") {
      const [line] = getLineRange(sourceFile, node);
      const name = node.name.getText(sourceFile);
      smells.push({
        kind: "any_annotation",
        location: `${name} (line ${line})`,
        message: `Explicit "any" type annotation`,
      });
    }

    ts.forEachChild(node, checkAnyCasts);
  }

  function checkNonNullAssertions(node: ts.Node) {
    if (ts.isNonNullExpression(node)) {
      const [line] = getLineRange(sourceFile, node);
      smells.push({
        kind: "non_null_assertion",
        location: `line ${line}`,
        message: `Non-null assertion: ${node.getText(sourceFile).substring(0, 80)}`,
      });
    }
    ts.forEachChild(node, checkNonNullAssertions);
  }

  // The walker shared with list_functions, code_complexity and call_graph.
  // This tool used to carry its own, which knew nothing of accessors, class
  // arrow properties or object-literal methods - so `code_smells` scoped to a
  // getter answered "No code smells found", an all-clear for a function it had
  // never looked at. That is the same defect already fixed here for nested
  // functions, and the reason there is now one walk rather than four.
  const scopes = withoutOverloadSignatures(collectFunctionScopes(sourceFile))
    .filter(s => s.body !== undefined);
  for (const scope of targetFunction ? findScopes(scopes, targetFunction) : scopes) {
    checkFunction(scope);
  }

  function visitClasses(node: ts.Node) {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      const className = node.name.getText(sourceFile);
      const methods = node.members.filter(m =>
        ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m));
      if (methods.length > GOD_CLASS_METHODS) {
        const [line] = getLineRange(sourceFile, node);
        smells.push({
          kind: "god_class",
          location: `${className} (line ${line})`,
          message: `${methods.length} methods exceeds threshold of ${GOD_CLASS_METHODS}`,
        });
      }
    }
    ts.forEachChild(node, visitClasses);
  }

  // A god class is a property of the file, not of any one function, so this
  // stays out of the per-function scan.
  if (!targetFunction) ts.forEachChild(sourceFile, visitClasses);

  // Scope the whole-tree checks to the requested function when there is one.
  // Running them against sourceFile regardless made `function` look like it
  // worked while still reporting casts from everywhere else in the file.
  const roots: ts.Node[] = targetFunction ? matchedFunctions : [sourceFile];
  for (const root of roots) {
    checkAnyCasts(root);
    checkNonNullAssertions(root);
  }

  return smells;
}

export function register(server: McpServer) {
  server.tool(
    "code_smells",
    "Detects code smells: long functions, too many parameters, deep nesting, god classes, " +
      "'as any' casts, explicit 'any' annotations, non-null assertions",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      function: z.string().optional().describe("Scope analysis to a specific function"),
    },
    safeTool("detect code smells", ({ path: filePath, function: targetFunction }) => {
      const sf = parseFile(filePath);
      const smells = detectSmells(sf, targetFunction);
      return textResult(formatSmells(smells, filePath));
    }),
  );
}
