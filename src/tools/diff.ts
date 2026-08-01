import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, extractSource, isExported, isArrowOrFunctionExpr } from "../parse.js";
import { type DiffEntry, formatDiff, textResult, safeTool } from "../format.js";

interface SymbolInfo {
  name: string;
  kind: string;
  source: string;
  exported: boolean;
}

function collectAllSymbols(sourceFile: ts.SourceFile): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "function",
        source: extractSource(sourceFile, node),
        exported: isExported(node),
      });
    }
    if (ts.isClassDeclaration(node) && node.name) {
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "class",
        source: extractSource(sourceFile, node),
        exported: isExported(node),
      });
    }
    if (ts.isInterfaceDeclaration(node)) {
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "interface",
        source: extractSource(sourceFile, node),
        exported: isExported(node),
      });
    }
    if (ts.isTypeAliasDeclaration(node)) {
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "type",
        source: extractSource(sourceFile, node),
        exported: isExported(node),
      });
    }
    if (ts.isEnumDeclaration(node)) {
      symbols.push({
        name: node.name.getText(sourceFile),
        kind: "enum",
        source: extractSource(sourceFile, node),
        exported: isExported(node),
      });
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText(sourceFile);
        const kind = isArrowOrFunctionExpr(decl) ? "function" : "variable";
        symbols.push({
          name,
          kind,
          source: extractSource(sourceFile, node),
          exported: isExported(node),
        });
      }
    }
  }

  ts.forEachChild(sourceFile, visit);
  return symbols;
}

function diffSymbols(oldSymbols: SymbolInfo[], newSymbols: SymbolInfo[]): DiffEntry[] {
  const entries: DiffEntry[] = [];
  const oldMap = new Map(oldSymbols.map(s => [s.name, s]));
  const newMap = new Map(newSymbols.map(s => [s.name, s]));

  for (const [name, oldSym] of oldMap) {
    const newSym = newMap.get(name);
    if (!newSym) {
      entries.push({ kind: "removed", symbol: `${oldSym.kind} ${name}` });
    } else if (oldSym.source !== newSym.source) {
      const details: string[] = [];
      if (oldSym.kind !== newSym.kind) details.push(`kind: ${oldSym.kind} -> ${newSym.kind}`);
      if (oldSym.exported !== newSym.exported) details.push(`export: ${oldSym.exported} -> ${newSym.exported}`);
      details.push("body changed");
      entries.push({ kind: "modified", symbol: `${newSym.kind} ${name}`, detail: details.join(", ") });
    }
  }

  for (const [name, newSym] of newMap) {
    if (!oldMap.has(name)) {
      entries.push({ kind: "added", symbol: `${newSym.kind} ${name}` });
    }
  }

  return entries;
}

export function register(server: McpServer) {
  server.tool(
    "diff_ast",
    "Compares two TypeScript/JavaScript files structurally, reporting added/removed/modified symbols",
    {
      old_path: z.string().describe("Absolute path to the old version of the file"),
      new_path: z.string().describe("Absolute path to the new version of the file"),
    },
    safeTool("diff files", ({ old_path, new_path }) => {
      const oldSf = parseFile(old_path);
      const newSf = parseFile(new_path);
      const oldSymbols = collectAllSymbols(oldSf);
      const newSymbols = collectAllSymbols(newSf);
      const entries = diffSymbols(oldSymbols, newSymbols);
      return textResult(formatDiff(entries, old_path, new_path));
    }),
  );
}
