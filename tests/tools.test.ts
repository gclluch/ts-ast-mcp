import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import url from "node:url";
import { listTsFiles, bindingNames } from "../src/parse.js";
import { parseSource } from "../src/parse.js";
import ts from "typescript";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const SHAPES = path.join(FIXTURES, "shapes.ts");
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

  it("reports a missing file as an error, not a crash", async () => {
    const out = await server.call("analyze_file", { path: "/no/such/file.ts" });
    expect(out).toMatch(/Failed|ENOENT/);
    // server must still be alive
    const r = await server.request("tools/list", {});
    expect(r.result.tools).toHaveLength(20);
  });
});
