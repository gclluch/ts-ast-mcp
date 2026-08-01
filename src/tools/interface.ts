import ts from "typescript";
import path from "node:path";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLineRange, listTsFiles, loadProgram, assertProgramParsed } from "../parse.js";
import { textResult, safeTool } from "../format.js";

function findInterface(sf: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
  let found: ts.InterfaceDeclaration | undefined;
  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isInterfaceDeclaration(node) && node.name.getText(sf) === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return found;
}

function collectClasses(sf: ts.SourceFile): ts.ClassDeclaration[] {
  const classes: ts.ClassDeclaration[] = [];
  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) classes.push(node);
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sf, visit);
  return classes;
}

function implementsExplicitly(cls: ts.ClassDeclaration, interfaceName: string): boolean {
  return (cls.heritageClauses ?? []).some(
    clause =>
      clause.token === ts.SyntaxKind.ImplementsKeyword &&
      clause.types.some(t => t.expression.getText() === interfaceName),
  );
}

function baseClassName(cls: ts.ClassDeclaration): string | undefined {
  for (const clause of cls.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length) {
      const expr = clause.types[0].expression;
      // A dotted or computed base (`extends Foo.Bar`, `extends mixin(X)`)
      // cannot be resolved from syntax; guessing at the last segment would
      // walk an unrelated class's heritage.
      return ts.isIdentifier(expr) ? expr.getText() : undefined;
    }
  }
  return undefined;
}

/**
 * Why this class satisfies the interface.
 *
 * "structural" for a class that inherits an explicit `implements` from its
 * base is the right answer for the wrong reason: it reads as a coincidence of
 * shape when the author actually declared the intent one level up. Renaming
 * the interface would break it, which is exactly what "structural" says it
 * would not do.
 */
function relationTo(
  cls: ts.ClassDeclaration,
  interfaceName: string,
  byName: Map<string, ts.ClassDeclaration>,
): "explicit" | "inherited" | "structural" {
  if (implementsExplicitly(cls, interfaceName)) return "explicit";
  const seen = new Set<ts.ClassDeclaration>([cls]);
  let base = byName.get(baseClassName(cls) ?? "");
  while (base && !seen.has(base)) {
    seen.add(base);
    if (implementsExplicitly(base, interfaceName)) return "inherited";
    base = byName.get(baseClassName(base) ?? "");
  }
  return "structural";
}

function isAbstract(cls: ts.ClassDeclaration): boolean {
  const mods = ts.canHaveModifiers(cls) ? ts.getModifiers(cls) : undefined;
  return !!mods?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword);
}

export function register(server: McpServer) {
  server.tool(
    "find_implementations",
    "Finds classes that implement a specified interface - explicit 'implements' plus " +
      "structural matches, checked by the TypeScript type checker (member types and " +
      "call signatures, not just names)",
    {
      path: z.string().describe("Absolute path to the file or directory to search"),
      interface: z.string().describe("Name of the interface to check against"),
    },
    safeTool("find implementations", ({ path: targetPath, interface: interfaceName }) => {
      // listTsFiles resolves a file to itself and a directory to its tree,
      // so both cases are the same list from here on.
      const abs = path.resolve(targetPath);
      const files = listTsFiles(abs, true);
      const isFile = files.length === 1 && files[0] === abs;
      const searchDir = isFile ? path.dirname(abs) : abs;

      // Assignability needs resolved types, so this tool runs on the semantic
      // tier. The program spans the whole directory even when the target is a
      // single file - a class's base types and imported member types have to
      // resolve or the comparison silently degrades to `any`.
      const program = loadProgram(searchDir);
      const checker = program.getTypeChecker();
      const sources = files
        .map(f => program.getSourceFile(f))
        .filter((sf): sf is ts.SourceFile => sf !== undefined);
      assertProgramParsed(program, sources);

      let ifaceDecl: ts.InterfaceDeclaration | undefined;
      for (const sf of sources) {
        ifaceDecl = findInterface(sf, interfaceName);
        if (ifaceDecl) break;
      }
      if (!ifaceDecl) return textResult(`Interface "${interfaceName}" not found.`);

      const ifaceSymbol = checker.getSymbolAtLocation(ifaceDecl.name);
      if (!ifaceSymbol) return textResult(`Interface "${interfaceName}" could not be resolved.`);
      const ifaceType = checker.getDeclaredTypeOfSymbol(ifaceSymbol);

      // Every type is assignable to `{}`, so a memberless interface would match
      // every class in the tree. Say so instead of printing that list.
      if (checker.getPropertiesOfType(ifaceType).length === 0) {
        return textResult(
          `Interface "${interfaceName}" declares no members - every class matches it ` +
            `structurally, so the result would be meaningless.`,
        );
      }

      // Base classes may live in another file of the same program, so the
      // lookup has to span every source before any class is classified.
      // A name defined in two files is dropped rather than resolved to
      // whichever was walked last: labelling a class `inherited` on the
      // strength of an unrelated class's `implements` is worse than falling
      // back to `structural`.
      const byName = new Map<string, ts.ClassDeclaration>();
      const ambiguous = new Set<string>();
      for (const sf of sources) {
        for (const cls of collectClasses(sf)) {
          const name = cls.name!.getText(sf);
          if (byName.has(name)) ambiguous.add(name);
          byName.set(name, cls);
        }
      }
      for (const name of ambiguous) byName.delete(name);

      const implementations: {
        name: string; file: string; line: number;
        relation: string; abstract: boolean;
      }[] = [];
      for (const sf of sources) {
        for (const cls of collectClasses(sf)) {
          const symbol = checker.getSymbolAtLocation(cls.name!);
          if (!symbol) continue;
          // getDeclaredTypeOfSymbol on a class gives the *instance* type, which
          // is what an interface is written against.
          if (!checker.isTypeAssignableTo(checker.getDeclaredTypeOfSymbol(symbol), ifaceType)) continue;
          const [line] = getLineRange(sf, cls);
          implementations.push({
            name: cls.name!.getText(sf),
            file: sf.fileName,
            line,
            relation: relationTo(cls, interfaceName, byName),
            abstract: isAbstract(cls),
          });
        }
      }

      if (implementations.length === 0) {
        return textResult(`No classes implementing "${interfaceName}" found.`);
      }

      const baseDir = isFile ? path.dirname(abs) : abs;
      const lines = [`Classes implementing "${interfaceName}" (${implementations.length} found):`, ""];
      for (const impl of implementations) {
        const rel = path.relative(baseDir, impl.file);
        // `abstract` matters to the caller: it satisfies the interface but
        // cannot be instantiated, so it is never the class they want to `new`.
        const marks = [impl.abstract ? "abstract" : "", impl.relation].filter(Boolean);
        lines.push(`  ${impl.name} (${marks.join(", ")}) [${rel}:${impl.line}]`);
      }
      return textResult(lines.join("\n"));
    }),
  );
}
