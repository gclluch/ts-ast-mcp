import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, extractSource, getLineRange, isExported, bindingNames } from "../parse.js";
import { textResult, safeTool } from "../format.js";

export function findTypeNode(sourceFile: ts.SourceFile, targetName: string): ts.Node | undefined {
  let result: ts.Node | undefined;

  function visit(node: ts.Node) {
    if (result) return;

    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
         ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) &&
        node.name?.getText(sourceFile) === targetName) {
      result = node;
      return;
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return result;
}

interface DeclInfo {
  name: string;
  kind: string;
  type: string;
  exported: boolean;
  line: number;
}

function collectDeclarations(sourceFile: ts.SourceFile): DeclInfo[] {
  const decls: DeclInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isVariableStatement(node)) {
      const flags = node.declarationList.flags;
      const keyword = flags & ts.NodeFlags.Const ? "const" :
                      flags & ts.NodeFlags.Let ? "let" : "var";
      for (const decl of node.declarationList.declarations) {
        // Skip arrow functions - those are covered by list_functions
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          continue;
        }
        const type = decl.type ? decl.type.getText(sourceFile) : "<inferred>";
        const [line] = getLineRange(sourceFile, node);
        // Destructuring patterns must be expanded: `decl.name.getText()` yields
        // the literal `{ alpha, beta }`, which is not a name anything can look
        // up. One entry per bound identifier instead.
        for (const name of bindingNames(decl.name)) {
          decls.push({
            name,
            kind: keyword,
            type,
            exported: isExported(node),
            line,
          });
        }
      }
    }
  }

  ts.forEachChild(sourceFile, visit);
  return decls;
}

interface ExportInfo {
  name: string;
  kind: string;
  line: number;
  isDefault: boolean;
}

function collectExports(sourceFile: ts.SourceFile): ExportInfo[] {
  const exports: ExportInfo[] = [];

  function visit(node: ts.Node) {
    // export default ...
    if (ts.isExportAssignment(node)) {
      const [line] = getLineRange(sourceFile, node);
      exports.push({ name: "default", kind: "export default", line, isDefault: true });
      return;
    }

    // export { ... } or export { ... } from '...'
    if (ts.isExportDeclaration(node)) {
      const [line] = getLineRange(sourceFile, node);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          exports.push({
            name: spec.name.getText(sourceFile),
            kind: "re-export",
            line,
            isDefault: false,
          });
        }
      } else if (!node.exportClause && node.moduleSpecifier) {
        exports.push({ name: "*", kind: "export *", line, isDefault: false });
      }
      return;
    }

    if (!isExported(node)) return;

    const [line] = getLineRange(sourceFile, node);

    if (ts.isFunctionDeclaration(node) && node.name) {
      exports.push({ name: node.name.getText(sourceFile), kind: "function", line, isDefault: false });
    } else if (ts.isClassDeclaration(node) && node.name) {
      exports.push({ name: node.name.getText(sourceFile), kind: "class", line, isDefault: false });
    } else if (ts.isInterfaceDeclaration(node)) {
      exports.push({ name: node.name.getText(sourceFile), kind: "interface", line, isDefault: false });
    } else if (ts.isTypeAliasDeclaration(node)) {
      exports.push({ name: node.name.getText(sourceFile), kind: "type", line, isDefault: false });
    } else if (ts.isEnumDeclaration(node)) {
      exports.push({ name: node.name.getText(sourceFile), kind: "enum", line, isDefault: false });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        // `export const { a, b } = x` exports a and b, not a symbol named "{ a, b }"
        for (const name of bindingNames(decl.name)) {
          exports.push({ name, kind: "variable", line, isDefault: false });
        }
      }
    }
  }

  ts.forEachChild(sourceFile, visit);
  return exports;
}

export function register(server: McpServer) {
  server.tool(
    "get_type_definition",
    "Extracts the full definition of any type (interface, type alias, class, enum) by name",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      name: z.string().describe("Name of the type to extract"),
    },
    safeTool("get type definition", ({ path: filePath, name }) => {
      const sf = parseFile(filePath);
      const node = findTypeNode(sf, name);
      if (!node) return textResult(`Type "${name}" not found in ${filePath}.`);
      const [line, endLine] = getLineRange(sf, node);
      const source = extractSource(sf, node);
      return textResult(`${name} [Lines ${line}-${endLine}]:\n\n${source}`);
    }),
  );

  server.tool(
    "list_declarations",
    "Lists package-level constant and variable declarations in a TypeScript/JavaScript file",
    { path: z.string().describe("Absolute path to the TS/JS file") },
    safeTool("list declarations", ({ path: filePath }) => {
      const sf = parseFile(filePath);
      const decls = collectDeclarations(sf);
      if (decls.length === 0) return textResult(`No declarations found in ${filePath}.`);

      const lines: string[] = [];
      for (const d of decls) {
        const exp = d.exported ? " (exported)" : "";
        lines.push(`${d.kind} ${d.name}: ${d.type}${exp} [line ${d.line}]`);
      }
      return textResult(lines.join("\n"));
    }),
  );

  server.tool(
    "list_exports",
    "Lists all exported symbols with their kind (function, class, interface, type, variable, re-export)",
    { path: z.string().describe("Absolute path to the TS/JS file") },
    safeTool("list exports", ({ path: filePath }) => {
      const sf = parseFile(filePath);
      const exps = collectExports(sf);
      if (exps.length === 0) return textResult(`No exports found in ${filePath}.`);

      const lines: string[] = [];
      for (const e of exps) {
        const def = e.isDefault ? " (default)" : "";
        lines.push(`${e.name} [${e.kind}]${def} [line ${e.line}]`);
      }
      return textResult(lines.join("\n"));
    }),
  );
}
