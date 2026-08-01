import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile } from "../parse.js";
import { textResult, safeTool } from "../format.js";

function findSymbolNode(sourceFile: ts.SourceFile, targetName: string): ts.Node | undefined {
  const parts = targetName.split(".");
  const isMethod = parts.length === 2;

  let result: ts.Node | undefined;

  function visit(node: ts.Node) {
    if (result) return;

    if (isMethod) {
      const [className, memberName] = parts;
      if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === className) {
        for (const member of node.members) {
          if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) &&
              member.name?.getText(sourceFile) === memberName) {
            result = member;
            return;
          }
        }
      }
    } else {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
           ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
           ts.isEnumDeclaration(node)) && node.name?.getText(sourceFile) === targetName) {
        result = node;
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (decl.name.getText(sourceFile) === targetName) {
            // Return the variable statement for JSDoc (JSDoc attaches to statement)
            result = node;
            return;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return result;
}

function extractJSDoc(sourceFile: ts.SourceFile, node: ts.Node): string | undefined {
  // ts.getJSDocCommentsAndTags approach
  const jsDocNodes = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (jsDocNodes && jsDocNodes.length > 0) {
    return jsDocNodes.map(doc => doc.getText(sourceFile)).join("\n\n");
  }

  // Fallback: look at leading trivia for comment blocks
  const fullStart = node.getFullStart();
  const start = node.getStart(sourceFile);
  const trivia = sourceFile.text.slice(fullStart, start);
  const commentMatch = trivia.match(/\/\*\*[\s\S]*?\*\//g);
  if (commentMatch) {
    return commentMatch.join("\n\n");
  }

  // Single-line comments
  const lineComments = trivia.match(/\/\/.*$/gm);
  if (lineComments) {
    return lineComments.join("\n");
  }

  return undefined;
}

export function register(server: McpServer) {
  server.tool(
    "get_doc",
    "Extracts JSDoc/TSDoc comments for a symbol (function, type, class, variable). Supports Class.method syntax.",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      name: z.string().describe("Symbol name (e.g., 'Config', 'MyClass.method', 'DEFAULT_VALUE')"),
    },
    safeTool("get documentation", ({ path: filePath, name }) => {
      const sf = parseFile(filePath);
      const node = findSymbolNode(sf, name);
      if (!node) return textResult(`Symbol "${name}" not found in ${filePath}.`);

      const doc = extractJSDoc(sf, node);
      if (!doc) return textResult(`No documentation found for "${name}" in ${filePath}.`);

      return textResult(`Documentation for ${name}:\n\n${doc}`);
    }),
  );
}
