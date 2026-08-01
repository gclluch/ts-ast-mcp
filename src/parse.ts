import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

// ── Syntactic (fast path) ──────────────────────────────────────────────

export function parseFile(filePath: string): ts.SourceFile {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf-8");
  return ts.createSourceFile(
    absPath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(absPath),
  );
}

export function parseSource(content: string, fileName = "input.ts"): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(fileName),
  );
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js": return ts.ScriptKind.JS;
    case ".mjs": return ts.ScriptKind.JS;
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

// ── Semantic (slower, cached) ──────────────────────────────────────────

interface ProgramCache {
  program: ts.Program;
  configMtime: number;
  configPath: string;
}

const programCache = new Map<string, ProgramCache>();

export function loadProgram(dir: string): ts.Program {
  const absDir = path.resolve(dir);
  const configPath = ts.findConfigFile(absDir, ts.sys.fileExists, "tsconfig.json");

  if (configPath) {
    const stat = fs.statSync(configPath);
    const mtime = stat.mtimeMs;
    const cached = programCache.get(configPath);
    if (cached && cached.configMtime === mtime) {
      return cached.program;
    }

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
    );
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    programCache.set(configPath, { program, configMtime: mtime, configPath });
    return program;
  }

  // No tsconfig - create a program from all TS files in the directory
  const files = collectTsFiles(absDir);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    allowJs: true,
  });
  return program;
}

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && /\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function extractSource(sourceFile: ts.SourceFile, node: ts.Node): string {
  return sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
}

export function getLineRange(sourceFile: ts.SourceFile, node: ts.Node): [number, number] {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return [start.line + 1, end.line + 1];
}

export function getNodeName(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) || ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node)) {
    return node.name?.getText();
  }
  if (ts.isVariableDeclaration(node)) {
    return node.name.getText();
  }
  return undefined;
}

export function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  // Check if parent is an export declaration
  if (node.parent && ts.isExportAssignment(node.parent)) return true;
  return false;
}

/**
 * Names actually bound by a declaration.
 *
 * `decl.name.getText()` returns the literal `{ a, b }` for a destructuring
 * pattern, which matches no identifier anywhere - so callers that compare or
 * count names must expand the pattern instead.
 */
export function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.getText()];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  }
  return out;
}

export function isArrowOrFunctionExpr(node: ts.VariableDeclaration): boolean {
  return !!node.initializer && (
    ts.isArrowFunction(node.initializer) ||
    ts.isFunctionExpression(node.initializer)
  );
}

export function getVisibility(node: ts.Node): string {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (!modifiers) return "";
  for (const m of modifiers) {
    if (m.kind === ts.SyntaxKind.PublicKeyword) return "public";
    if (m.kind === ts.SyntaxKind.PrivateKeyword) return "private";
    if (m.kind === ts.SyntaxKind.ProtectedKeyword) return "protected";
  }
  return "";
}

/** Collect TS/JS files under a path. A file resolves to itself. */
export function listTsFiles(dir: string, recursive = false): string[] {
  const absDir = path.resolve(dir);
  // Callers pass either a directory or a single file; without this a file path
  // reaches readdirSync and throws ENOTDIR.
  if (fs.existsSync(absDir) && fs.statSync(absDir).isFile()) {
    return /\.(tsx?|jsx?|mjs|cjs)$/.test(absDir) ? [absDir] : [];
  }
  if (!recursive) {
    return fs.readdirSync(absDir)
      .filter(f => /\.(tsx?|jsx?|mjs|cjs)$/.test(f) && !f.endsWith(".d.ts"))
      .map(f => path.join(absDir, f));
  }
  return collectTsFiles(absDir).filter(f => !f.endsWith(".d.ts"));
}
