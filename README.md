# TypeScript AST MCP Server

A Model Context Protocol (MCP) server for deep structural analysis of TypeScript and JavaScript source code. Unlike text-based search, this server parses your code with the TypeScript Compiler API and walks the real AST - types, functions, call relationships, interface satisfaction, and more.

Most tools run on the syntactic tier (`ts.createSourceFile`, no type resolution) because it is fast and needs no build. `find_implementations` runs on the semantic tier - a full `ts.Program` and its type checker - because deciding whether a class satisfies an interface cannot be done from syntax alone. Each tool's tier is stated in the table below.

Companion to [py-ast-mcp](https://github.com/gclluch/py-ast-mcp), the same idea applied to Python; a Go AST MCP server by another author served as prior art for this one.

## Features

- **20 analysis tools** covering file-level, directory-level, and cross-file structural queries
- **Fast syntactic parsing** - `ts.createSourceFile()` per file, under 5ms; cross-file tools re-parse in scope, so results always reflect the latest edit
- **Arrow function awareness** - `const foo = () => {}` treated as first-class functions throughout
- **Signature extraction** - parameters, class-qualified names, and return types **as written**. These come from the annotation, so an unannotated return reads as blank rather than as the inferred type
- **Call graph generation** with Mermaid diagrams, forward and reverse traversal, file or package scope
- **Cyclomatic complexity** computation per function
- **Interface implementation discovery** - explicit `implements` plus structural matches decided by the type checker's own assignability rules, so member types and call signatures count, not just member names
- **Structural diffing** between file versions (added/removed/modified symbols)
- **Cursor-position awareness** for IDE integrations
- **JSX/TSX parsing** - `.tsx`/`.jsx` files parse under the right `ScriptKind`, so every tool works on React source. There is no React-specific analysis: a component is a function like any other
- **TypeScript-specific quality checks** - `any` casts, non-null assertions, floating promises, empty catches, double assertions
- **Dead code detection** - unexported symbols never referenced within their own file. Unexported means file-local, so that is the whole search space. A same-named binding in another scope of the same file still reads as a use, which makes this under-report rather than over-report
- **JSDoc/TSDoc extraction** for any symbol

## Tools

### Structural Queries

| Tool | Description | Parameters |
|------|-------------|------------|
| `analyze_file` | High-level summary of all symbols (classes, interfaces, types, enums, functions) | `path` |
| `list_functions` | List all functions/methods with full signatures and line ranges | `path` |
| `get_function_body` | Extract a function/method body (supports `Class.method` syntax) | `path`, `name` |
| `list_methods` | List all methods for a class | `path`, `type` |
| `get_type_definition` | Extract any type definition (interface, type alias, class, enum) | `path`, `name` |
| `list_declarations` | List module-level const/let/var with types | `path` |
| `list_exports` | List all exported symbols with kind (function, class, type, re-export) | `path` |
| `list_imports` | List all import statements with bindings and module paths | `path` |
| `find_usages` | Find all occurrences of an identifier with source context | `path`, `identifier` |

### Call Analysis

| Tool | Description | Parameters |
|------|-------------|------------|
| `call_graph` | Generate a Mermaid call graph diagram | `path`, `function`\*, `direction`\*, `include_external`\*, `scope`\* |
| `get_callers` | Reverse call graph - find all callers of a function | `path`, `function`, `scope`\* |

\* Optional `call_graph` parameters:
- `function` - Focus on calls reachable from this function only
- `direction` - `TD` (top-down, default) or `LR` (left-right)
- `include_external` - Include calls to functions not defined in the file (default: `false`)
- `scope` - `file` (default) or `package` (cross-file analysis)

\* Optional `get_callers` parameter:
- `scope` - `file` (default) or `package` (search all files in the directory)

### Code Quality

| Tool | Description | Parameters |
|------|-------------|------------|
| `code_complexity` | Cyclomatic complexity per function | `path`, `function`\* |
| `code_smells` | Long functions, deep nesting, god classes, `any` casts, non-null assertions | `path`, `function`\* |
| `find_errors` | Floating promises, empty catches, double type assertions, optional chain + non-null | `path`, `function`\* |

A floating promise here means a discarded call to a function the **same file** declares `async` (or to `fetch`). Without type resolution that is the limit of what can be claimed soundly - an imported `async` function is not detected. It under-reports on purpose: the alternative is guessing from the callee's name, which reports `map.get(k)`.
| `dead_code` | Find unexported symbols never referenced inside their own file | `path` (directory), `include_tests`\* |
| `find_implementations` | Find classes satisfying an interface - explicit `implements` or type-checked structural match (**semantic tier**) | `path`, `interface` |

\* Optional - omit to report all functions / exclude test files.

### Documentation & Metadata

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_doc` | Extract JSDoc/TSDoc comments for any symbol (supports `Class.method`) | `path`, `name` |

### Multi-File Analysis

| Tool | Description | Parameters |
|------|-------------|------------|
| `analyze_package` | Directory-level summary of all TS/JS files | `path`, `include_tests`\* |
| `diff_ast` | Structural diff between two file versions (added/removed/modified) | `old_path`, `new_path` |

\* Optional - include test files (default: `false`).

### IDE Integration

| Tool | Description | Parameters |
|------|-------------|------------|
| `find_node_at_position` | Identify the AST node at a cursor position | `path`, `line`, `column` |

## Configuration

### Claude Code

Add a `.mcp.json` file to the repository root:
```json
{
  "mcpServers": {
    "ts-ast": {
      "command": "npx",
      "args": ["-y", "github:gclluch/ts-ast-mcp"]
    }
  }
}
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):
```json
{
  "mcpServers": {
    "ts-ast": {
      "command": "npx",
      "args": ["-y", "github:gclluch/ts-ast-mcp"]
    }
  }
}
```

### GitHub Copilot (VS Code)

Create `.vscode/mcp.json` in the project root:
```json
{
  "mcpServers": {
    "ts-ast": {
      "command": "npx",
      "args": ["-y", "github:gclluch/ts-ast-mcp"]
    }
  }
}
```

### VSCode Extensions (Cline / Roo Code)

Add to the extension's MCP settings:
```json
{
  "mcpServers": {
    "ts-ast": {
      "command": "npx",
      "args": ["-y", "github:gclluch/ts-ast-mcp"],
      "env": {}
    }
  }
}
```

### Local development

For working on ts-ast-mcp itself, clone and build locally:

```bash
git clone https://github.com/gclluch/ts-ast-mcp.git
cd ts-ast-mcp
npm install    # prepare script builds automatically
```

Then point your `.mcp.json` at the local build:
```json
{
  "mcpServers": {
    "ts-ast": {
      "command": "node",
      "args": ["/path/to/ts-ast-mcp/dist/index.js"]
    }
  }
}
```

## Two-Tier Parsing

Most tools use the **syntactic tier** - `ts.createSourceFile()` parses a single file in under 5ms. No tsconfig or type checker needed.

Tools that operate across files (`dead_code`, `analyze_package`) and tools with `scope: "package"` (`call_graph`, `get_callers`) do this by re-parsing every file in scope on each call via the syntactic parser - always correct on the latest edit, at the cost of re-parsing repeatedly.

The **semantic tier** backs `find_implementations`, the one question that syntax cannot answer: whether a class satisfies an interface depends on member *types* and call signatures, not member names. `loadProgram()` (in `src/parse.ts`) builds a cached `ts.Program` and hands the tool the real type checker, which then answers via `isTypeAssignableTo` - the same rule the compiler applies to an `implements` clause.

Compiler options come from the nearest `tsconfig.json`; the file list never does. `findConfigFile` walks *up*, so the directory you asked about is routinely outside that config's `include`, and building from the config's own file list would produce a program that doesn't contain the files under analysis. The cache invalidates when the tsconfig's mtime changes *or* any file feeding the program changes, so an edit is always reflected on the next call while an unchanged tree reuses the `Program`.

Cost of the semantic tier is real: the first `find_implementations` call on a directory pays a full parse-bind-check pass. Subsequent calls on an unchanged tree are cache hits.

Arrow functions (`const foo = () => {}`) are detected as first-class functions throughout - they appear in `list_functions`, `get_function_body`, `code_complexity`, `code_smells`, and all other function-aware tools.

All output is plain text, not JSON.

## Development

```bash
npm install
npm test        # builds, then runs the vitest suite
```

The suite covers the pure helpers (`listTsFiles`, `bindingNames`) plus an
integration layer that spawns the real stdio server and drives it over JSON-RPC,
so tool wiring is exercised the way a client actually uses it.

## How to Verify

Once registered, you can ask your AI assistant to:
- *"List all functions in `Dashboard.tsx` with their signatures."*
- *"Extract the full definition of the `UserConfig` interface."*
- *"Show me who calls the `useApiQuery` hook."*
- *"Generate a call graph for `utils/ErrorUtils.ts`."*
- *"What's the cyclomatic complexity of functions in `DataTable.tsx`?"*
- *"Which classes implement the `DataProvider` interface?"*
- *"Compare the old and new versions of `api.ts` structurally."*
- *"What AST node is at line 42, column 10?"*
- *"Give me a directory-level summary of `src/hooks/`."*
- *"Find error patterns in `AuthService.ts`."*
- *"Run a code smell check on `BigComponent.tsx`."*
- *"Find dead code in `src/utils/`."*
- *"What's the JSDoc for the `useApiQuery` function?"*
- *"List all exports from `src/types/index.ts`."*
