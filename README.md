# TypeScript AST MCP Server

A Model Context Protocol (MCP) server for deep structural analysis of TypeScript and JavaScript source code. Unlike text-based search, this server uses the TypeScript Compiler API (`ts.createSourceFile`, `ts.createProgram`) to understand the actual structure of your code - types, functions, call relationships, interface satisfaction, and more.

Part of a family of AST analysis MCP servers, alongside a Go and Python counterpart.

## Features

- **20 analysis tools** covering file-level, directory-level, and cross-file structural queries
- **Two-tier parsing** - fast syntactic analysis (<5ms) for most tools, semantic analysis with type checker for cross-file queries
- **Arrow function awareness** - `const foo = () => {}` treated as first-class functions throughout
- **Full signature extraction** with parameter types, return types, and class-qualified names
- **Call graph generation** with Mermaid diagrams, forward and reverse traversal, file or package scope
- **Cyclomatic complexity** computation per function
- **Interface implementation discovery** - explicit `implements` and structural matching
- **Structural diffing** between file versions (added/removed/modified symbols)
- **Cursor-position awareness** for IDE integrations
- **JSX/TSX support** - handles React components natively
- **TypeScript-specific quality checks** - `any` casts, non-null assertions, floating promises, empty catches, double assertions
- **Dead code detection** - unreferenced unexported symbols across a directory
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
| `dead_code` | Find unreferenced unexported symbols within a directory | `path` (directory), `include_tests`\* |
| `find_implementations` | Find classes implementing an interface (explicit or structural match) | `path`, `interface` |

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

Tools that operate across files (`dead_code`, `find_implementations`, `analyze_package`) and tools with `scope: "package"` (`call_graph`, `get_callers`) use the **semantic tier** - `ts.createProgram()` loads from the nearest tsconfig for cross-file analysis. The program is cached by tsconfig path + mtime, so repeated calls are fast.

Arrow functions (`const foo = () => {}`) are detected as first-class functions throughout - they appear in `list_functions`, `get_function_body`, `code_complexity`, `code_smells`, and all other function-aware tools.

All output is plain text, not JSON.

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
