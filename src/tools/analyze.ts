import ts from "typescript";
import path from "node:path";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange, isExported, isArrowOrFunctionExpr, listTsFiles } from "../parse.js";
import { type FileSymbol, formatSymbols, textResult, safeTool } from "../format.js";

function collectSymbols(sourceFile: ts.SourceFile): FileSymbol[] {
  const symbols: FileSymbol[] = [];

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const [line, endLine] = getLineRange(sourceFile, node);
      const params = node.parameters.map(p => p.getText(sourceFile)).join(", ");
      const ret = node.type ? `: ${node.type.getText(sourceFile)}` : "";
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "Functions",
        exported: isExported(node),
        line,
        endLine,
        signature: `(${params})${ret}`,
      });
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const [line, endLine] = getLineRange(sourceFile, node);
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "Classes",
        exported: isExported(node),
        line,
        endLine,
      });
    }

    if (ts.isInterfaceDeclaration(node)) {
      const [line, endLine] = getLineRange(sourceFile, node);
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "Interfaces",
        exported: isExported(node),
        line,
        endLine,
      });
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const [line, endLine] = getLineRange(sourceFile, node);
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "Types",
        exported: isExported(node),
        line,
        endLine,
      });
    }

    if (ts.isEnumDeclaration(node)) {
      const [line, endLine] = getLineRange(sourceFile, node);
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "Enums",
        exported: isExported(node),
        line,
        endLine,
      });
    }

    // Arrow functions / function expressions at module level
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isVariableDeclaration(decl) && isArrowOrFunctionExpr(decl)) {
          const name = decl.name.getText(sourceFile);
          const [line, endLine] = getLineRange(sourceFile, node);
          const init = decl.initializer!;
          let sig = "";
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            const params = init.parameters.map(p => p.getText(sourceFile)).join(", ");
            const ret = init.type ? `: ${init.type.getText(sourceFile)}` : "";
            sig = `(${params})${ret}`;
          }
          symbols.push({
            name,
            kind: "Functions",
            exported: isExported(node),
            line,
            endLine,
            signature: sig,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  // Only visit top-level children
  ts.forEachChild(sourceFile, visit);
  return symbols;
}

export function register(server: McpServer) {
  server.tool(
    "analyze_file",
    "Provides a high-level summary of all symbols (classes, interfaces, types, enums, functions) in a TypeScript/JavaScript file",
    { path: z.string().describe("Absolute path to the TS/JS file") },
    safeTool(({ path: filePath }) => `analyze ${filePath}`, ({ path: filePath }) => {
      const sf = parseFile(filePath);
      const symbols = collectSymbols(sf);
      return textResult(formatSymbols(symbols, filePath));
    }),
  );

  server.tool(
    "analyze_package",
    "Analyzes all TypeScript/JavaScript files in a directory, providing a package-level summary",
    {
      path: z.string().describe("Absolute path to the directory"),
      include_tests: z.boolean().optional().default(false).describe("Include test files (default: false)"),
    },
    safeTool(({ path: dirPath }) => `analyze ${dirPath}`, ({ path: dirPath, include_tests }) => {
      let files = listTsFiles(dirPath, true);
      if (!include_tests) {
        files = files.filter(f => !f.includes(".test.") && !f.includes(".spec.") && !f.includes("__tests__"));
      }
      if (files.length === 0) return textResult(`No TypeScript/JavaScript files found in ${dirPath}.`);

      const sections: string[] = [`Package: ${dirPath}`, `Files: ${files.length}`, ""];
      for (const file of files) {
        const sf = parseFile(file);
        const symbols = collectSymbols(sf);
        const rel = path.relative(dirPath, file);
        sections.push(formatSymbols(symbols, rel));
        sections.push("");
      }
      return textResult(sections.join("\n"));
    }),
  );
}
