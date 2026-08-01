import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange } from "../parse.js";
import { textResult, safeTool } from "../format.js";

interface ImportInfo {
  module: string;
  bindings: string[];
  kind: string;
  line: number;
}

function collectImports(sourceFile: ts.SourceFile): ImportInfo[] {
  const imports: ImportInfo[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node)) {
      const module = node.moduleSpecifier.getText(sourceFile).replace(/['"]/g, "");
      const [line] = getLineRange(sourceFile, node);
      const bindings: string[] = [];
      let kind = "side-effect";

      if (node.importClause) {
        if (node.importClause.name) {
          bindings.push(node.importClause.name.getText(sourceFile));
          kind = "default";
        }
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            for (const spec of node.importClause.namedBindings.elements) {
              const alias = spec.propertyName
                ? `${spec.propertyName.getText(sourceFile)} as ${spec.name.getText(sourceFile)}`
                : spec.name.getText(sourceFile);
              bindings.push(alias);
            }
            kind = node.importClause.name ? "mixed" : "named";
          } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            bindings.push(`* as ${node.importClause.namedBindings.name.getText(sourceFile)}`);
            kind = "namespace";
          }
        }
        if (node.importClause.isTypeOnly) {
          kind = `type ${kind}`;
        }
      }

      imports.push({ module, bindings, kind, line });
    }

    // Dynamic imports handled at call-expression level are not top-level
    // require() calls
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer) &&
            decl.initializer.expression.getText(sourceFile) === "require" &&
            decl.initializer.arguments.length > 0) {
          const module = decl.initializer.arguments[0].getText(sourceFile).replace(/['"]/g, "");
          const name = decl.name.getText(sourceFile);
          const [line] = getLineRange(sourceFile, node);
          imports.push({ module, bindings: [name], kind: "require", line });
        }
      }
    }
  });

  return imports;
}

export function register(server: McpServer) {
  server.tool(
    "list_imports",
    "Lists all import statements in a TypeScript/JavaScript file with their bindings and module paths",
    { path: z.string().describe("Absolute path to the TS/JS file") },
    safeTool("list imports", ({ path: filePath }) => {
      const sf = parseFile(filePath);
      const imps = collectImports(sf);
      if (imps.length === 0) return textResult(`No imports found in ${filePath}.`);

      const lines: string[] = [];
      for (const i of imps) {
        const bindingStr = i.bindings.length > 0 ? `{ ${i.bindings.join(", ")} }` : "(side-effect)";
        lines.push(`[${i.kind}] ${bindingStr} from "${i.module}" [line ${i.line}]`);
      }
      return textResult(lines.join("\n"));
    }),
  );
}
