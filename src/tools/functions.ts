import ts from "typescript";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, extractSource, getLineRange, isExported, isArrowOrFunctionExpr, getVisibility } from "../parse.js";
import { textResult, safeTool } from "../format.js";

interface FuncInfo {
  name: string;
  signature: string;
  line: number;
  endLine: number;
  exported: boolean;
  className?: string;
  visibility?: string;
}

function collectFunctions(sourceFile: ts.SourceFile): FuncInfo[] {
  const funcs: FuncInfo[] = [];

  function visitClassMembers(classNode: ts.ClassDeclaration) {
    const className = classNode.name?.getText(sourceFile) ?? "<anonymous>";
    for (const member of classNode.members) {
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
        const name = ts.isConstructorDeclaration(member)
          ? "constructor"
          : member.name?.getText(sourceFile) ?? "<computed>";
        const params = member.parameters.map(p => p.getText(sourceFile)).join(", ");
        const ret = member.type ? `: ${member.type.getText(sourceFile)}` : "";
        const [line, endLine] = getLineRange(sourceFile, member);
        funcs.push({
          name: `${className}.${name}`,
          signature: `(${params})${ret}`,
          line,
          endLine,
          exported: isExported(classNode),
          className,
          visibility: getVisibility(member),
        });
      }

      // Arrow function properties in classes
      if (ts.isPropertyDeclaration(member) && member.initializer &&
          (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) {
        const name = member.name?.getText(sourceFile) ?? "<computed>";
        const init = member.initializer;
        const params = init.parameters.map(p => p.getText(sourceFile)).join(", ");
        const ret = init.type ? `: ${init.type.getText(sourceFile)}` : "";
        const [line, endLine] = getLineRange(sourceFile, member);
        funcs.push({
          name: `${className}.${name}`,
          signature: `(${params})${ret}`,
          line,
          endLine,
          exported: isExported(classNode),
          className,
          visibility: getVisibility(member),
        });
      }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const params = node.parameters.map(p => p.getText(sourceFile)).join(", ");
      const ret = node.type ? `: ${node.type.getText(sourceFile)}` : "";
      const [line, endLine] = getLineRange(sourceFile, node);
      funcs.push({
        name: node.name.getText(sourceFile),
        signature: `(${params})${ret}`,
        line,
        endLine,
        exported: isExported(node),
      });
    }

    if (ts.isClassDeclaration(node)) {
      visitClassMembers(node);
    }

    // Module-level arrow functions
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isVariableDeclaration(decl) && isArrowOrFunctionExpr(decl)) {
          const name = decl.name.getText(sourceFile);
          const init = decl.initializer!;
          let sig = "";
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            const params = init.parameters.map(p => p.getText(sourceFile)).join(", ");
            const ret = init.type ? `: ${init.type.getText(sourceFile)}` : "";
            sig = `(${params})${ret}`;
          }
          const [line, endLine] = getLineRange(sourceFile, node);
          funcs.push({
            name,
            signature: sig,
            line,
            endLine,
            exported: isExported(node),
          });
        }
      }
    }
  }

  ts.forEachChild(sourceFile, visit);
  return funcs;
}

function findFunctionNode(sourceFile: ts.SourceFile, targetName: string): ts.Node | undefined {
  // Support Class.method syntax
  const parts = targetName.split(".");
  const isMethod = parts.length === 2;

  let result: ts.Node | undefined;

  function visit(node: ts.Node) {
    if (result) return;

    if (isMethod) {
      const [className, methodName] = parts;
      if (ts.isClassDeclaration(node) && node.name?.getText(sourceFile) === className) {
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member) && methodName === "constructor") {
            result = member;
            return;
          }
          if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) &&
              member.name?.getText(sourceFile) === methodName) {
            result = member;
            return;
          }
        }
      }
    } else {
      if (ts.isFunctionDeclaration(node) && node.name?.getText(sourceFile) === targetName) {
        result = node;
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (decl.name.getText(sourceFile) === targetName && isArrowOrFunctionExpr(decl)) {
            result = node;
            return;
          }
        }
      }
      // Check class methods without class prefix
      if (ts.isClassDeclaration(node)) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name?.getText(sourceFile) === targetName) {
            result = member;
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

export function register(server: McpServer) {
  server.tool(
    "list_functions",
    "Lists all functions and methods in a TypeScript/JavaScript file with their signatures and line ranges",
    { path: z.string().describe("Absolute path to the TS/JS file") },
    safeTool(({ path: filePath }) => `list functions in ${filePath}`, ({ path: filePath }) => {
      const sf = parseFile(filePath);
      const funcs = collectFunctions(sf);
      if (funcs.length === 0) return textResult(`No functions found in ${filePath}.`);

      const lines: string[] = [];
      for (const f of funcs) {
        const exp = f.exported ? " (exported)" : "";
        const vis = f.visibility ? `${f.visibility} ` : "";
        lines.push(`${vis}${f.name}${f.signature}${exp} [Lines ${f.line}-${f.endLine}]`);
      }
      return textResult(lines.join("\n"));
    }),
  );

  server.tool(
    "get_function_body",
    "Extracts the full body of a specific function or method. Supports Class.method syntax.",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      name: z.string().describe("Function name (e.g., 'setup' or 'MyClass.method')"),
    },
    safeTool("get function body", ({ path: filePath, name }) => {
      const sf = parseFile(filePath);
      const node = findFunctionNode(sf, name);
      if (!node) return textResult(`Function "${name}" not found in ${filePath}.`);
      const [line, endLine] = getLineRange(sf, node);
      const source = extractSource(sf, node);
      return textResult(`${name} [Lines ${line}-${endLine}]:\n\n${source}`);
    }),
  );

  server.tool(
    "list_methods",
    "Lists all methods for a specific class in a TypeScript/JavaScript file",
    {
      path: z.string().describe("Absolute path to the TS/JS file"),
      type: z.string().describe("The class name"),
    },
    safeTool("list methods", ({ path: filePath, type: className }) => {
      const sf = parseFile(filePath);
      const funcs = collectFunctions(sf).filter(f => f.className === className);
      if (funcs.length === 0) return textResult(`No methods found for class "${className}" in ${filePath}.`);

      const lines: string[] = [];
      for (const f of funcs) {
        const vis = f.visibility ? `${f.visibility} ` : "";
        lines.push(`${vis}${f.name}${f.signature} [Lines ${f.line}-${f.endLine}]`);
      }
      return textResult(lines.join("\n"));
    }),
  );
}
