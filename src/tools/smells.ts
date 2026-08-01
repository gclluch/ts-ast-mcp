import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange, isArrowOrFunctionExpr } from "../parse.js";
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

  function checkFunction(name: string, node: ts.Node, params: ts.NodeArray<ts.ParameterDeclaration>) {
    if (targetFunction && name !== targetFunction) return;
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

    checkNesting(node, 0, name);
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

    // `: any` in parameters and variable declarations
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
        node.type && node.type.getText(sourceFile) === "any") {
      const [line] = getLineRange(sourceFile, node);
      const name = node.name.getText(sourceFile);
      smells.push({
        kind: "any_cast",
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

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      checkFunction(node.name.getText(sourceFile), node, node.parameters);
    }

    if (ts.isClassDeclaration(node) && node.name) {
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

      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && member.body) {
          checkFunction(`${className}.${member.name.getText(sourceFile)}`, member, member.parameters);
        }
        if (ts.isConstructorDeclaration(member) && member.body) {
          checkFunction(`${className}.constructor`, member, member.parameters);
        }
      }
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isVariableDeclaration(decl) && isArrowOrFunctionExpr(decl)) {
          const init = decl.initializer!;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            checkFunction(decl.name.getText(sourceFile), node, init.parameters);
          }
        }
      }
    }

    // Descend. Without this only top-level declarations were ever checked: a
    // function nested in another function was invisible, so its parameter count
    // and length went unreported, its nesting was attributed to the enclosing
    // function, and asking for it by name returned "No code smells found" - an
    // all-clear for a function that had never been looked at.
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

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
    "Detects code smells: long functions, too many parameters, deep nesting, god classes, 'any' casts, non-null assertions",
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
