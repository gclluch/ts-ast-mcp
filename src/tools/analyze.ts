import ts from "typescript";
import path from "node:path";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange, isExported, listTsFiles } from "../parse.js";
import { collectFunctionScopes, signatureOf, withoutOverloadSignatures } from "../scopes.js";
import { type FileSymbol, formatSymbols, textResult, safeTool } from "../format.js";

function collectSymbols(sourceFile: ts.SourceFile): FileSymbol[] {
  const symbols: FileSymbol[] = [];

  // Functions come from the walker shared with list_functions and
  // code_complexity, so the three tools cannot disagree about one file:
  // namespace members are qualified (`Outer.Inner.deeplyNested`, not a bare
  // `deeplyNested` that two namespaces could both claim) and an overloaded
  // function appears once. Class members are deliberately left to
  // list_functions; this tool summarises the file's own symbols.
  for (const scope of withoutOverloadSignatures(collectFunctionScopes(sourceFile))) {
    // Members of a class *or* of an object literal belong to the thing that
    // owns them; `list_methods` expands those. Filtering on `className` alone
    // let object-literal methods through while their object went unlisted.
    if (scope.isMember) continue;
    const [line, endLine] = getLineRange(sourceFile, scope.node);
    symbols.push({
      name: scope.name,
      kind: "Functions",
      exported: scope.isExported,
      line,
      endLine,
      signature: signatureOf(scope, sourceFile),
    });
  }

  // `prefix` qualifies anything declared inside a namespace. Two namespaces
  // may each declare `Inner` or `Config`, and a bare name cannot tell them
  // apart - the same collision already fixed for functions.
  function visit(node: ts.Node, prefix: string) {
    const push = (name: ts.Node, kind: string) => {
      const [line, endLine] = getLineRange(sourceFile, node);
      symbols.push({
        name: prefix + name.getText(sourceFile),
        kind,
        exported: isExported(node),
        line,
        endLine,
      });
    };

    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      push(node.name, "Namespaces");
      const inner = `${prefix}${node.name.getText(sourceFile)}.`;
      ts.forEachChild(node.body, c => visit(c, inner));
      return;
    }
    if (ts.isClassDeclaration(node) && node.name) push(node.name, "Classes");
    else if (ts.isInterfaceDeclaration(node)) push(node.name, "Interfaces");
    else if (ts.isTypeAliasDeclaration(node)) push(node.name, "Types");
    else if (ts.isEnumDeclaration(node)) push(node.name, "Enums");

    ts.forEachChild(node, c => visit(c, prefix));
  }

  ts.forEachChild(sourceFile, c => visit(c, ""));
  return symbols;
}

export function register(server: McpServer) {
  server.tool(
    "analyze_file",
    "Provides a high-level summary of a TypeScript/JavaScript file's own symbols: " +
      "classes, interfaces, types, enums, namespaces and functions. Class members " +
      "are not expanded here - use list_methods or list_functions for those.",
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
