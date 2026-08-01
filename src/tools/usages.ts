import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange } from "../parse.js";
import { textResult, safeTool } from "../format.js";

interface UsageInfo {
  line: number;
  column: number;
  context: string;
  kind: string;
}

function findUsages(sourceFile: ts.SourceFile, identifier: string): UsageInfo[] {
  const usages: UsageInfo[] = [];

  function getContext(node: ts.Node): string {
    // Get the line text
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);
    const lineEnd = line + 1 < sourceFile.getLineStarts().length
      ? sourceFile.getPositionOfLineAndCharacter(line + 1, 0) - 1
      : sourceFile.text.length;
    return sourceFile.text.slice(lineStart, lineEnd).trim();
  }

  function getUsageKind(node: ts.Node): string {
    const parent = node.parent;
    if (!parent) return "reference";

    if (ts.isVariableDeclaration(parent) && parent.name === node) return "declaration";
    if (ts.isParameter(parent) && parent.name === node) return "parameter";
    if (ts.isFunctionDeclaration(parent) && parent.name === node) return "function-declaration";
    if (ts.isClassDeclaration(parent) && parent.name === node) return "class-declaration";
    if (ts.isInterfaceDeclaration(parent) && parent.name === node) return "interface-declaration";
    if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return "type-declaration";
    if (ts.isEnumDeclaration(parent) && parent.name === node) return "enum-declaration";
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return "property-access";
    if (ts.isCallExpression(parent) && parent.expression === node) return "call";
    if (ts.isTypeReferenceNode(parent)) return "type-reference";
    if (ts.isImportSpecifier(parent)) return "import";
    if (ts.isExportSpecifier(parent)) return "export";
    if (ts.isPropertyDeclaration(parent) && parent.name === node) return "property-declaration";
    if (ts.isMethodDeclaration(parent) && parent.name === node) return "method-declaration";
    return "reference";
  }

  function visit(node: ts.Node) {
    if (ts.isIdentifier(node) && node.getText(sourceFile) === identifier) {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      usages.push({
        line: pos.line + 1,
        column: pos.character + 1,
        context: getContext(node),
        kind: getUsageKind(node),
      });
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return usages;
}

function findNodeAtPosition(sourceFile: ts.SourceFile, line: number, column: number): ts.Node | undefined {
  // getPositionOfLineAndCharacter asserts internally on an out-of-range line or
  // column, surfacing a raw "Debug Failure" instead of a usable message. Clamp
  // to the file's own bounds first and let the caller report "no node here".
  const starts = sourceFile.getLineStarts();
  const lineIndex = line - 1;
  if (lineIndex < 0 || lineIndex >= starts.length) return undefined;

  const lineStart = starts[lineIndex];
  const lineEnd = lineIndex + 1 < starts.length ? starts[lineIndex + 1] : sourceFile.end;
  const position = Math.min(lineStart + Math.max(column - 1, 0), Math.max(lineEnd - 1, lineStart));

  function visit(node: ts.Node): ts.Node | undefined {
    if (node.getStart(sourceFile) <= position && position < node.getEnd()) {
      // Try children first for more specific match
      let child: ts.Node | undefined;
      ts.forEachChild(node, (n) => {
        if (!child && n.getStart(sourceFile) <= position && position < n.getEnd()) {
          child = visit(n);
        }
      });
      return child ?? node;
    }
    return undefined;
  }

  let result: ts.Node | undefined;
  ts.forEachChild(sourceFile, (n) => {
    if (!result) result = visit(n);
  });
  return result;
}

export function register(server: McpServer) {
  server.tool(
    "find_usages",
    "Finds all occurrences of a specific identifier (variable, function, type) within a file",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      identifier: z.string().describe("The name of the identifier to search for"),
    },
    safeTool("find usages", ({ path: filePath, identifier }) => {
      const sf = parseFile(filePath);
      const usages = findUsages(sf, identifier);
      if (usages.length === 0) return textResult(`No usages of "${identifier}" found in ${filePath}.`);

      const lines: string[] = [`Usages of "${identifier}" in ${filePath} (${usages.length} found):`, ""];
      for (const u of usages) {
        lines.push(`  Line ${u.line}, Col ${u.column} [${u.kind}]: ${u.context}`);
      }
      return textResult(lines.join("\n"));
    }),
  );

  server.tool(
    "find_node_at_position",
    "Identifies the AST node at a given cursor position (line and column) in a TypeScript/JavaScript file",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      line: z.number().describe("Line number (1-based)"),
      column: z.number().describe("Column number (1-based)"),
    },
    safeTool("find node at position", ({ path: filePath, line, column }) => {
      const sf = parseFile(filePath);
      const node = findNodeAtPosition(sf, line, column);
      if (!node) return textResult(`No AST node found at ${line}:${column} in ${filePath}.`);

      const [startLine, endLine] = getLineRange(sf, node);
      const kindName = ts.SyntaxKind[node.kind];
      const text = node.getText(sf).substring(0, 200);
      const parentKind = node.parent ? ts.SyntaxKind[node.parent.kind] : "none";

      const lines = [
        `Node at ${line}:${column} in ${filePath}:`,
        `  Kind: ${kindName}`,
        `  Parent: ${parentKind}`,
        `  Lines: ${startLine}-${endLine}`,
        `  Text: ${text}${text.length >= 200 ? "..." : ""}`,
      ];
      return textResult(lines.join("\n"));
    }),
  );
}
