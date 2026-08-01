import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

// ── Syntactic (fast path) ──────────────────────────────────────────────

/**
 * `ts.createSourceFile` never throws - it returns a best-effort AST for input it
 * could not parse. Left unchecked, a file with a syntax error yields an empty or
 * nonsense tree, and every tool then reports "nothing found", which is
 * indistinguishable from a genuinely clean file. Refuse instead: a caller that
 * gets an error knows the analysis did not happen.
 */
function syntaxError(sf: ts.SourceFile, diags: readonly ts.Diagnostic[]): Error {
  const first = diags[0];
  const { line } = sf.getLineAndCharacterOfPosition(first.start ?? 0);
  const msg = ts.flattenDiagnosticMessageText(first.messageText, " ");
  return new Error(
    `${diags.length} syntax error${diags.length === 1 ? "" : "s"} in ` +
      `${path.basename(sf.fileName)} - first at line ${line + 1}: ${msg}`,
  );
}

function assertParsed(sf: ts.SourceFile): ts.SourceFile {
  // parseDiagnostics is internal to the compiler API but is the only way to see
  // syntax errors without building a full Program.
  const diags = (sf as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
    .parseDiagnostics ?? [];
  if (diags.length === 0) return sf;
  throw syntaxError(sf, diags);
}

/**
 * The Program equivalent of `assertParsed`: same refusal, same message, for
 * tools that go through the semantic tier instead of `parseFile`.
 */
export function assertProgramParsed(program: ts.Program, sources: readonly ts.SourceFile[]): void {
  for (const sf of sources) {
    const diags = program.getSyntacticDiagnostics(sf);
    if (diags.length > 0) throw syntaxError(sf, diags);
  }
}

export function parseFile(filePath: string): ts.SourceFile {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf-8");
  return assertParsed(
    ts.createSourceFile(
      absPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(absPath),
    ),
  );
}

export function parseSource(content: string, fileName = "input.ts"): ts.SourceFile {
  return assertParsed(
    ts.createSourceFile(
      fileName,
      content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(fileName),
    ),
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
//
// Cache key is the tsconfig path, or the directory itself when there is no
// tsconfig. A cache entry is valid only while BOTH hold:
//   - the tsconfig's mtime is unchanged (irrelevant when there is none)
//   - every file that fed the program still has the mtime it had when built
// Recomputing the candidate file list + stat'ing it is cheap (a directory
// walk or a config glob); it's `ts.createProgram`'s parse+bind+check pass
// that's expensive, and that only re-runs when something actually changed.

interface ProgramCache {
  program: ts.Program;
  configMtime: number | undefined;
  fileMtimes: Map<string, number>;
}

const programCache = new Map<string, ProgramCache>();

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.Latest,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  allowJs: true,
};

function statMtimes(files: string[]): Map<string, number> {
  const mtimes = new Map<string, number>();
  for (const file of files) {
    try {
      mtimes.set(file, fs.statSync(file).mtimeMs);
    } catch {
      // Vanished between listing and stat - leave it out so a size/identity
      // mismatch against the cached snapshot forces a rebuild.
    }
  }
  return mtimes;
}

function mtimesMatch(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [file, mtime] of a) {
    if (b.get(file) !== mtime) return false;
  }
  return true;
}

export function loadProgram(dir: string): ts.Program {
  const absDir = path.resolve(dir);
  const configPath = ts.findConfigFile(absDir, ts.sys.fileExists, "tsconfig.json");
  const cacheKey = configPath ?? absDir;

  let fileNames: string[];
  let options: ts.CompilerOptions;
  let configMtime: number | undefined;

  if (configPath) {
    configMtime = fs.statSync(configPath).mtimeMs;
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
    );
    options = parsed.options;
  } else {
    options = DEFAULT_COMPILER_OPTIONS;
  }

  // Options come from the nearest tsconfig; the file list never does.
  // findConfigFile walks UP, so the directory a caller asked about is routinely
  // outside that config's `include` - taking parsed.fileNames would hand back a
  // program that does not contain the files being analysed, and every semantic
  // tool would report nothing found.
  fileNames = collectTsFiles(absDir);

  const fileMtimes = statMtimes(fileNames);
  const cached = programCache.get(cacheKey);
  if (cached && cached.configMtime === configMtime && mtimesMatch(cached.fileMtimes, fileMtimes)) {
    return cached.program;
  }

  const program = ts.createProgram(fileNames, options);
  programCache.set(cacheKey, { program, configMtime, fileMtimes });
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
