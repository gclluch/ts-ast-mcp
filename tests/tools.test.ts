import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import url from "node:url";
import fs from "node:fs";
import os from "node:os";
import { listTsFiles, bindingNames, loadProgram, parseFile } from "../src/parse.js";
import { parseSource } from "../src/parse.js";
import ts from "typescript";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const SHAPES = path.join(FIXTURES, "shapes.ts");
const SIBLING = path.join(FIXTURES, "sibling.ts");
const DIST = path.join(HERE, "..", "dist", "index.js");

// ── unit: the two root causes behind the bugs this suite guards ──────────

describe("listTsFiles", () => {
  it("resolves a file to itself instead of throwing ENOTDIR", () => {
    // Callers pass either a file or a directory. Scanning a file path with
    // readdirSync threw ENOTDIR and broke three separate tools.
    expect(listTsFiles(SHAPES, true)).toEqual([SHAPES]);
  });

  it("still walks a directory", () => {
    const files = listTsFiles(FIXTURES, true);
    expect(files).toContain(SHAPES);
    expect(files.length).toBeGreaterThan(1);
  });

  it("ignores a non-TS file", () => {
    expect(listTsFiles(path.join(HERE, "..", "package.json"), true)).toEqual([]);
  });
});

describe("bindingNames", () => {
  const firstDecl = (src: string) => {
    const sf = parseSource(src);
    let name: ts.BindingName | undefined;
    ts.forEachChild(sf, n => {
      if (ts.isVariableStatement(n)) name ??= n.declarationList.declarations[0].name;
    });
    return name!;
  };

  it("returns a plain identifier", () => {
    expect(bindingNames(firstDecl("const solo = 1;"))).toEqual(["solo"]);
  });

  it("expands object destructuring", () => {
    // getText() would return the literal "{ a, b }", which matches no identifier
    expect(bindingNames(firstDecl("const { a, b } = x;"))).toEqual(["a", "b"]);
  });

  it("expands array destructuring", () => {
    expect(bindingNames(firstDecl("const [x, y] = arr;"))).toEqual(["x", "y"]);
  });

  it("expands nested and renamed bindings", () => {
    expect(bindingNames(firstDecl("const { a: { b }, c: renamed } = x;")))
      .toEqual(["b", "renamed"]);
  });
});

describe("syntax errors are never reported as clean", () => {
  it("parseSource refuses a file it could not parse", () => {
    expect(() => parseSource("export function busted({, { , { oops\n  const x = ;;;\n"))
      .toThrow(/syntax error/i);
  });

  it("names the first error and its line", () => {
    let msg = "";
    try {
      parseSource("const ok = 1;\nfunction broken({, { {\n");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/line 2/);
  });

  it("still parses valid source", () => {
    expect(() => parseSource("export const a = 1;\n")).not.toThrow();
  });

  it("parseFile refuses a broken file on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsast-broken-"));
    const f = path.join(dir, "broken.ts");
    fs.writeFileSync(f, "class Foo { bar( { , { \n");
    try {
      expect(() => parseFile(f)).toThrow(/syntax error/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadProgram", () => {
  const tmpDirs: string[] = [];

  const mkTmpDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-ast-mcp-loadprogram-"));
    tmpDirs.push(dir);
    return dir;
  };

  // Filesystem mtime resolution varies (some are 1s granularity); bump the
  // mtime explicitly into the future so the change is always detectable,
  // rather than depending on real wall-clock elapsed time between writes.
  const writeAndBumpMtime = (file: string, content: string, aheadMs: number) => {
    fs.writeFileSync(file, content);
    const future = new Date(Date.now() + aheadMs);
    fs.utimesSync(file, future, future);
  };

  afterEach(() => {
    while (tmpDirs.length) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("reuses the cached Program when nothing changed", () => {
    const dir = mkTmpDir();
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ include: ["**/*"] }));
    fs.writeFileSync(path.join(dir, "a.ts"), "export const value = 1;\n");

    const first = loadProgram(dir);
    const second = loadProgram(dir);
    expect(second).toBe(first);
  });

  it("picks up a source file edit (tsconfig project)", () => {
    const dir = mkTmpDir();
    const file = path.join(dir, "a.ts");
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ include: ["**/*"] }));
    fs.writeFileSync(file, "export const value = 1;\n");

    const before = loadProgram(dir);
    expect(before.getSourceFile(file)!.text).toContain("value = 1");

    writeAndBumpMtime(file, "export const value = 2;\n", 5000);

    const after = loadProgram(dir);
    expect(after).not.toBe(before);
    expect(after.getSourceFile(file)!.text).toContain("value = 2");
  });

  it("reuses the cached Program when nothing changed (no tsconfig)", () => {
    // The no-tsconfig branch previously had no cache at all: every call ran
    // collectTsFiles + ts.createProgram from scratch, so this identity check
    // fails against the old code even with zero file changes.
    const dir = mkTmpDir();
    fs.writeFileSync(path.join(dir, "a.ts"), "export const value = 1;\n");

    const first = loadProgram(dir);
    const second = loadProgram(dir);
    expect(second).toBe(first);
  });

  it("picks up a source file edit (no tsconfig)", () => {
    const dir = mkTmpDir();
    const file = path.join(dir, "a.ts");
    fs.writeFileSync(file, "export const value = 1;\n");

    const before = loadProgram(dir);
    expect(before.getSourceFile(file)!.text).toContain("value = 1");

    writeAndBumpMtime(file, "export const value = 2;\n", 5000);

    const after = loadProgram(dir);
    expect(after).not.toBe(before);
    expect(after.getSourceFile(file)!.text).toContain("value = 2");
  });
});

// ── integration: drive the real stdio server ────────────────────────────

class Server {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number, (m: any) => void>();
  private id = 0;

  constructor() {
    this.proc = spawn("node", [DIST], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", d => {
      this.buf += d.toString();
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          this.pending.get(m.id)?.(m);
          this.pending.delete(m.id);
        } catch { /* not a complete JSON line */ }
      }
    });
  }

  request(method: string, params: unknown): Promise<any> {
    const id = ++this.id;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async start() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const r = await this.request("tools/call", { name, arguments: args });
    return (r.result?.content ?? []).map((c: any) => c.text).join("\n");
  }

  stop() { this.proc.kill(); }
}

describe("tools over stdio", () => {
  let server: Server;
  beforeAll(async () => { server = new Server(); await server.start(); }, 30_000);
  afterAll(() => server?.stop());

  it("exposes 20 tools", async () => {
    const r = await server.request("tools/list", {});
    expect(r.result.tools).toHaveLength(20);
  });

  // Each of these three threw "ENOTDIR: not a directory" before the fix.
  it("find_implementations accepts a file path", async () => {
    const out = await server.call("find_implementations", { path: SHAPES, interface: "Greeter" });
    expect(out).not.toMatch(/ENOTDIR|^Failed/);
    expect(out).toContain("LoudGreeter");
  });

  it("find_implementations finds structural matches too", async () => {
    const out = await server.call("find_implementations", { path: SHAPES, interface: "Greeter" });
    expect(out).toContain("QuietGreeter");
    expect(out).toMatch(/LoudGreeter \(explicit\)/);
  });

  it("call_graph scope=package resolves the containing directory", async () => {
    const out = await server.call("call_graph", { path: SHAPES, scope: "package" });
    expect(out).not.toMatch(/ENOTDIR|^Failed/);
    expect(out).toContain("flowchart");
  });

  it("get_callers scope=package reaches a sibling file", async () => {
    // callsEntry lives in sibling.ts - file scope alone cannot see it
    const out = await server.call("get_callers", { path: SHAPES, function: "entry", scope: "package" });
    expect(out).not.toMatch(/ENOTDIR|^Failed/);
    expect(out).toContain("callsEntry");
  });

  it("dead_code does not report destructured bindings as dead", async () => {
    // `const { gamma, delta }` is unexported and both names are used. Keyed on
    // the raw pattern text they matched nothing and were reported dead.
    const out = await server.call("dead_code", { path: FIXTURES });
    expect(out).not.toContain("{ gamma, delta }");
    expect(out).not.toMatch(/\bgamma\b/);
    expect(out).not.toMatch(/\bdelta\b/);
  });

  it("dead_code still finds a genuinely unreferenced symbol", async () => {
    const out = await server.call("dead_code", { path: FIXTURES });
    expect(out).toContain("UnusedShape");
  });

  it("list_exports expands a destructured export", async () => {
    const out = await server.call("list_exports", { path: SHAPES });
    expect(out).toContain("alpha");
    expect(out).toContain("beta");
    expect(out).not.toContain("{ alpha, beta }");
  });

  it.each([
    ["column past end of a blank line", { line: 6, column: 10 }],
    ["line past end of file", { line: 999, column: 1 }],
    ["zero/negative position", { line: 0, column: 0 }],
  ])("find_node_at_position handles %s", async (_label, pos) => {
    // These leaked raw TypeScript internals: "Debug Failure. False expression."
    // and "Debug Failure. Bad line number."
    const out = await server.call("find_node_at_position", { path: SHAPES, ...pos });
    expect(out).not.toMatch(/Debug Failure/);
    expect(out).toMatch(/No AST node found/);
  });

  it("reports a missing file as an error, not a crash", async () => {
    const out = await server.call("analyze_file", { path: "/no/such/file.ts" });
    expect(out).toMatch(/Failed|ENOENT/);
    // server must still be alive
    const r = await server.request("tools/list", {});
    expect(r.result.tools).toHaveLength(20);
  });
});

// ── every tool, happy path and failure path ─────────────────────────────
//
// Covers all 20 registrations so the shared error wrapper can be changed with
// confidence: each tool must produce real output for good input, and a
// "Failed to ..." string (never a crash) for a path that does not exist.

const MISSING = "/no/such/dir/file.ts";

const ALL_TOOLS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ["analyze_file",           { path: SHAPES }, { path: MISSING }],
  ["analyze_package",        { path: FIXTURES }, { path: "/no/such/dir" }],
  ["list_functions",         { path: SHAPES }, { path: MISSING }],
  ["get_function_body",      { path: SHAPES, name: "entry" }, { path: MISSING, name: "entry" }],
  ["list_methods",           { path: SHAPES, type: "LoudGreeter" }, { path: MISSING, type: "X" }],
  ["get_type_definition",    { path: SHAPES, name: "Greeter" }, { path: MISSING, name: "X" }],
  ["list_declarations",      { path: SHAPES }, { path: MISSING }],
  ["list_exports",           { path: SHAPES }, { path: MISSING }],
  ["list_imports",           { path: SIBLING }, { path: MISSING }],
  ["find_usages",            { path: SHAPES, identifier: "entry" }, { path: MISSING, identifier: "x" }],
  ["call_graph",             { path: SHAPES }, { path: MISSING }],
  ["get_callers",            { path: SHAPES, function: "usedHelper" }, { path: MISSING, function: "x" }],
  ["code_complexity",        { path: SHAPES }, { path: MISSING }],
  ["code_smells",            { path: SHAPES }, { path: MISSING }],
  ["find_errors",            { path: SHAPES }, { path: MISSING }],
  ["dead_code",              { path: FIXTURES }, { path: "/no/such/dir" }],
  ["find_implementations",   { path: SHAPES, interface: "Greeter" }, { path: MISSING, interface: "X" }],
  ["get_doc",                { path: SHAPES, name: "entry" }, { path: MISSING, name: "x" }],
  ["diff_ast",               { old_path: SHAPES, new_path: SIBLING }, { old_path: MISSING, new_path: MISSING }],
  ["find_node_at_position",  { path: SHAPES, line: 7, column: 14 }, { path: MISSING, line: 1, column: 1 }],
];

describe("every tool", () => {
  let server: Server;
  beforeAll(async () => { server = new Server(); await server.start(); }, 30_000);
  afterAll(() => server?.stop());

  it("the table covers every registered tool", async () => {
    const r = await server.request("tools/list", {});
    const registered = new Set(r.result.tools.map((t: any) => t.name));
    const covered = new Set(ALL_TOOLS.map(([n]) => n));
    expect([...registered].sort()).toEqual([...covered].sort());
  });

  it.each(ALL_TOOLS)("%s returns output for valid input", async (name, good) => {
    const out = await server.call(name, good);
    expect(out.trim()).not.toBe("");
    expect(out).not.toMatch(/^Failed to /);
  });

  it.each(ALL_TOOLS)("%s reports failure without crashing", async (name, _good, bad) => {
    const out = await server.call(name, bad);
    expect(out).toMatch(/^Failed to /);
    // and the process is still serving
    const r = await server.request("tools/list", {});
    expect(r.result.tools).toHaveLength(20);
  });
});
