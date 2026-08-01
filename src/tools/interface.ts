import ts from "typescript";
import path from "node:path";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseFile, getLineRange, listTsFiles } from "../parse.js";
import { textResult, safeTool } from "../format.js";

interface InterfaceInfo {
  name: string;
  methods: Set<string>;
  properties: Set<string>;
}

function extractInterfaceInfo(sourceFile: ts.SourceFile, interfaceName: string): InterfaceInfo | undefined {
  let result: InterfaceInfo | undefined;

  function visit(node: ts.Node) {
    if (result) return;
    if (ts.isInterfaceDeclaration(node) && node.name.getText(sourceFile) === interfaceName) {
      const methods = new Set<string>();
      const properties = new Set<string>();
      for (const member of node.members) {
        if (ts.isMethodSignature(member) && member.name) {
          methods.add(member.name.getText(sourceFile));
        }
        if (ts.isPropertySignature(member) && member.name) {
          properties.add(member.name.getText(sourceFile));
        }
      }
      result = { name: interfaceName, methods, properties };
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return result;
}

interface ClassInfo {
  name: string;
  file: string;
  line: number;
  implements: string[];
  methods: Set<string>;
  properties: Set<string>;
}

function collectClasses(sourceFile: ts.SourceFile, filePath: string): ClassInfo[] {
  const classes: ClassInfo[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const [line] = getLineRange(sourceFile, node);
      const implementsList: string[] = [];
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
            for (const type of clause.types) {
              implementsList.push(type.expression.getText(sourceFile));
            }
          }
        }
      }

      const methods = new Set<string>();
      const properties = new Set<string>();
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name) {
          methods.add(member.name.getText(sourceFile));
        }
        if (ts.isPropertyDeclaration(member) && member.name) {
          properties.add(member.name.getText(sourceFile));
          // Check if property is an arrow function (counts as method impl)
          if (member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) {
            methods.add(member.name.getText(sourceFile));
          }
        }
      }

      classes.push({
        name: node.name.getText(sourceFile),
        file: filePath,
        line,
        implements: implementsList,
        methods,
        properties,
      });
    }
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);
  return classes;
}

function classImplementsInterface(cls: ClassInfo, iface: InterfaceInfo): boolean {
  // Explicit implements
  if (cls.implements.includes(iface.name)) return true;

  // Structural: class has all methods and properties of interface
  for (const method of iface.methods) {
    if (!cls.methods.has(method)) return false;
  }
  for (const prop of iface.properties) {
    if (!cls.properties.has(prop) && !cls.methods.has(prop)) return false;
  }
  return iface.methods.size > 0 || iface.properties.size > 0;
}

export function register(server: McpServer) {
  server.tool(
    "find_implementations",
    "Finds classes that implement a specified interface (explicit 'implements' or structural match)",
    {
      path: z.string().describe("Absolute path to the file or directory to search"),
      interface: z.string().describe("Name of the interface to check against"),
    },
    safeTool("find implementations", ({ path: targetPath, interface: interfaceName }) => {
      // listTsFiles resolves a file to itself and a directory to its tree,
      // so both cases are the same list from here on.
      const files = listTsFiles(targetPath, true);
      const isFile = files.length === 1 && files[0] === path.resolve(targetPath);

      let iface: InterfaceInfo | undefined;
      for (const file of files) {
        const sf = parseFile(file);
        iface = extractInterfaceInfo(sf, interfaceName);
        if (iface) break;
      }

      if (!iface) return textResult(`Interface "${interfaceName}" not found.`);

      // Collect all classes and check which implement the interface
      const allClasses: ClassInfo[] = [];
      for (const file of files) {
        const sf = parseFile(file);
        allClasses.push(...collectClasses(sf, file));
      }

      const implementations = allClasses.filter(cls => classImplementsInterface(cls, iface!));

      if (implementations.length === 0) {
        return textResult(`No classes implementing "${interfaceName}" found.`);
      }

      const baseDir = isFile ? path.dirname(targetPath) : targetPath;
      const lines = [`Classes implementing "${interfaceName}" (${implementations.length} found):`, ""];
      for (const impl of implementations) {
        const rel = path.relative(baseDir, impl.file);
        const explicit = impl.implements.includes(interfaceName) ? " (explicit)" : " (structural)";
        lines.push(`  ${impl.name}${explicit} [${rel}:${impl.line}]`);
      }
      return textResult(lines.join("\n"));
    }),
  );
}
