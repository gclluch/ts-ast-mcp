import ts from "typescript";
import path from "node:path";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, isExported, isArrowOrFunctionExpr, listTsFiles, getLineRange, bindingNames, getVisibility } from "../parse.js";
import { textResult, safeTool } from "../format.js";

interface UnexportedSymbol {
  /** How it reads in the report, e.g. `Sedan.secret`. */
  name: string;
  /** The bare identifier to count occurrences of. Defaults to `name`. */
  lookup?: string;
  kind: string;
  file: string;
  line: number;
}

function collectUnexportedSymbols(sourceFile: ts.SourceFile, filePath: string): UnexportedSymbol[] {
  const symbols: UnexportedSymbol[] = [];

  function visit(node: ts.Node) {
    if (isExported(node)) return; // Skip exported symbols

    if (ts.isFunctionDeclaration(node) && node.name) {
      const [line] = getLineRange(sourceFile, node);
      symbols.push({ name: node.name.getText(sourceFile), kind: "function", file: filePath, line });
    }
    if (ts.isClassDeclaration(node) && node.name) {
      const [line] = getLineRange(sourceFile, node);
      symbols.push({ name: node.name.getText(sourceFile), kind: "class", file: filePath, line });
    }
    if (ts.isInterfaceDeclaration(node)) {
      const [line] = getLineRange(sourceFile, node);
      symbols.push({ name: node.name.getText(sourceFile), kind: "interface", file: filePath, line });
    }
    if (ts.isTypeAliasDeclaration(node)) {
      const [line] = getLineRange(sourceFile, node);
      symbols.push({ name: node.name.getText(sourceFile), kind: "type", file: filePath, line });
    }
    if (ts.isEnumDeclaration(node)) {
      const [line] = getLineRange(sourceFile, node);
      symbols.push({ name: node.name.getText(sourceFile), kind: "enum", file: filePath, line });
    }
    if (ts.isVariableStatement(node)) {  // exported already returned above
      for (const decl of node.declarationList.declarations) {
        const kind = isArrowOrFunctionExpr(decl) ? "function" : "variable";
        const [line] = getLineRange(sourceFile, node);
        // destructuring binds several names; each is tracked on its own
        for (const name of bindingNames(decl.name)) {
          symbols.push({ name, kind, file: filePath, line });
        }
      }
    }
  }

  ts.forEachChild(sourceFile, visit);
  return symbols;
}

/**
 * Class members no other file can reach: `private`, or a `#name`.
 *
 * These are as module-local as an unexported function, and were the one kind
 * of dead code this tool could never report - it only ever looked at top-level
 * declarations, so a private method nobody calls stayed invisible.
 *
 * `protected` is deliberately excluded: a subclass in another file may use it,
 * and this tool does not read other files.
 */
function collectPrivateMembers(sourceFile: ts.SourceFile, filePath: string): UnexportedSymbol[] {
  const symbols: UnexportedSymbol[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const className = node.name?.getText(sourceFile) ?? "<anonymous>";
      for (const member of node.members) {
        if (!member.name) continue;
        const isHashPrivate = ts.isPrivateIdentifier(member.name);
        if (!isHashPrivate && getVisibility(member) !== "private") continue;
        const kind = ts.isMethodDeclaration(member) ? "private method"
          : ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)
            ? "private accessor"
            : "private field";
        const [line] = getLineRange(sourceFile, member);
        const bare = member.name.getText(sourceFile);
        symbols.push({ name: `${className}.${bare}`, lookup: bare, kind, file: filePath, line });
      }
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return symbols;
}

/** Occurrence count per identifier name. Counts, not just presence, so a
 *  symbol's own declaration can be told apart from real uses. */
function countIdentifiers(sourceFile: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();

  function visit(node: ts.Node) {
    // A `#name` is a PrivateIdentifier, not an Identifier: counting only the
    // latter left every `#field` at zero occurrences, declaration included.
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const name = node.getText(sourceFile);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return counts;
}

export function register(server: McpServer) {
  server.tool(
    "dead_code",
    "Finds unreferenced module-local symbols within a directory: unexported functions, " +
      "types and variables, plus 'private' and '#name' class members. Reports a symbol " +
      "never named anywhere but its own declaration.",
    {
      path: z.string().describe("Absolute path to the directory"),
      include_tests: z.boolean().optional().default(false).describe("Include test files (default: false)"),
    },
    safeTool("find dead code", ({ path: dirPath, include_tests }) => {
      let files = listTsFiles(dirPath, true);
      if (!include_tests) {
        files = files.filter(f => !f.includes(".test.") && !f.includes(".spec.") && !f.includes("__tests__"));
      }

      if (files.length === 0) return textResult(`No TypeScript/JavaScript files found in ${dirPath}.`);

      // These symbols are unexported, so they are module-local by definition and
      // no other file can reference them. An earlier version also scanned every
      // other file for the bare name and treated a hit as a use, which is not a
      // weaker check but a wrong one: it silenced any symbol sharing a name with
      // an identifier anywhere in the tree, so anything called `id`, `config`,
      // `parse` or `visit` was permanently immune.
      //
      // Dead = named at most once in its own file, that once being the declaration.
      // ponytail: a same-named local in another scope of the same file still reads
      // as a use. Under-reports, never over-reports; needs symbol identity from
      // the checker to close, which costs a full Program for every directory.
      const dead: UnexportedSymbol[] = [];
      for (const file of files) {
        const sf = parseFile(file);
        const counts = countIdentifiers(sf);
        const candidates = [
          ...collectUnexportedSymbols(sf, file),
          ...collectPrivateMembers(sf, file),
        ];
        for (const sym of candidates) {
          if ((counts.get(sym.lookup ?? sym.name) ?? 0) <= 1) dead.push(sym);
        }
      }

      if (dead.length === 0) return textResult(`No dead code found in ${dirPath}.`);

      const lines = [`Dead code in ${dirPath} (${dead.length} unreferenced symbols):`, ""];
      for (const d of dead) {
        const rel = path.relative(dirPath, d.file);
        lines.push(`  ${d.kind} ${d.name} [${rel}:${d.line}]`);
      }
      return textResult(lines.join("\n"));
    }),
  );
}
