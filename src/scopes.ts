import ts from "typescript";
import { getVisibility, isExported } from "./parse.js";

/**
 * One walker over every construct that owns executable code.
 *
 * `list_functions`, `code_complexity` and `call_graph` each used to carry
 * their own version of this walk, and each version knew about a different
 * subset of the language: accessors, class arrow properties, namespace bodies
 * and object-literal methods were missing from some or all of them, and
 * nested functions were folded into their parent. The tools then disagreed
 * about the same file. There is one walk now, so a construct is either
 * understood everywhere or nowhere.
 */
export interface FunctionScope {
  /** Dotted name a caller would use: `outer.inner`, `Cls.method`, `Ns.fn`. */
  name: string;
  /** The declaration itself. Identity matters: it is what marks the scope. */
  node: ts.Node;
  /** Block, or the expression of a concise arrow. Absent for an overload. */
  body?: ts.Node;
  params: readonly ts.ParameterDeclaration[];
  returnType?: ts.TypeNode;
  kind: "function" | "method" | "constructor" | "get" | "set" | "arrow";
  /** Enclosing class, when a class is what owns this. */
  className?: string;
  /** Declared inside a class or an object literal, rather than standing alone. */
  isMember: boolean;
  /** "", "public", "protected" or "private". */
  visibility: string;
  isStatic: boolean;
  isAsync: boolean;
  /** Reachable from outside the module under this exact name. */
  isExported: boolean;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some(m => m.kind === kind);
}

function isFnExpr(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function fnKind(node: ts.ArrowFunction | ts.FunctionExpression): FunctionScope["kind"] {
  return ts.isArrowFunction(node) ? "arrow" : "function";
}

export function collectFunctionScopes(sf: ts.SourceFile): FunctionScope[] {
  const out: FunctionScope[] = [];
  const text = (n: ts.Node) => n.getText(sf);

  /** Members of a class or of an object literal - the shapes are parallel. */
  function visitMembers(
    members: readonly ts.ClassElement[] | readonly ts.ObjectLiteralElementLike[],
    owner: string,
    ownerExported: boolean,
    className: string | undefined,
  ) {
    for (const m of members) {
      const visibility = getVisibility(m);
      const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword);
      const isAsync = hasModifier(m, ts.SyntaxKind.AsyncKeyword);
      // A private member of an exported class is not itself exported, and
      // labelling it so contradicts the `private` printed on the same line.
      const hidden =
        visibility === "private" ||
        visibility === "protected" ||
        (!!m.name && ts.isPrivateIdentifier(m.name));
      const exported = ownerExported && !hidden;

      const add = (
        shortName: string,
        kind: FunctionScope["kind"],
        node: ts.Node,
        params: readonly ts.ParameterDeclaration[],
        returnType: ts.TypeNode | undefined,
        body: ts.Node | undefined,
      ) => {
        const name = `${owner}.${shortName}`;
        out.push({
          name, node, body, params, returnType, kind, isMember: true,
          className, visibility, isStatic, isAsync, isExported: exported,
        });
        if (body) ts.forEachChild(body, c => visit(c, `${name}.`));
      };

      if (ts.isConstructorDeclaration(m)) {
        add("constructor", "constructor", m, m.parameters, m.type, m.body);
      } else if (ts.isMethodDeclaration(m)) {
        add(text(m.name), "method", m, m.parameters, m.type, m.body);
      } else if (ts.isGetAccessorDeclaration(m)) {
        add(text(m.name), "get", m, m.parameters, m.type, m.body);
      } else if (ts.isSetAccessorDeclaration(m)) {
        add(text(m.name), "set", m, m.parameters, m.type, m.body);
      } else if (
        (ts.isPropertyDeclaration(m) || ts.isPropertyAssignment(m)) && m.initializer
      ) {
        const init = m.initializer;
        if (isFnExpr(init)) {
          add(text(m.name), fnKind(init), m, init.parameters, init.type, init.body);
        } else if (ts.isObjectLiteralExpression(init)) {
          // An object literal held in a class property or nested in another
          // object literal is the same construct in a different position; its
          // methods are functions wherever it is written.
          visitMembers(init.properties, `${owner}.${text(m.name)}`, exported, undefined);
        }
      }
    }
  }

  function visit(node: ts.Node, prefix: string) {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = prefix + text(node.name);
      out.push({
        name,
        node,
        body: node.body,
        params: node.parameters,
        returnType: node.type,
        kind: "function",
        isMember: false,
        visibility: "",
        isStatic: false,
        isAsync: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
        isExported: isExported(node),
      });
      if (node.body) ts.forEachChild(node.body, c => visit(c, `${name}.`));
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const bare = node.name ? text(node.name) : "<anonymous>";
      visitMembers(node.members, prefix + bare, isExported(node), bare);
      return;
    }

    // `namespace Outer { ... }` is a naming scope, not a function. Its members
    // must carry the qualification or two namespaces exporting the same name
    // are indistinguishable in the output.
    if (ts.isModuleDeclaration(node) && node.body) {
      // `declare module "ext"` names another module, not a namespace member -
      // prefixing with a quoted string yields a name no caller can pass back.
      const name = ts.isStringLiteral(node.name) ? prefix : `${prefix}${text(node.name)}.`;
      // `namespace Q.R {}` nests a ModuleDeclaration directly rather than
      // opening a ModuleBlock. forEachChild would step over that inner
      // declaration to its children and lose `R`, leaving `Q.fn` - the exact
      // collision the qualification exists to prevent.
      if (ts.isModuleDeclaration(node.body)) visit(node.body, name);
      else ts.forEachChild(node.body, c => visit(c, name));
      return;
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const bare = text(decl.name);
        const name = prefix + bare;
        if (isFnExpr(decl.initializer)) {
          const init = decl.initializer;
          out.push({
            name,
            node: decl,
            body: init.body,
            params: init.parameters,
            returnType: init.type,
            kind: fnKind(init),
            isMember: false,
            visibility: "",
            isStatic: false,
            isAsync: hasModifier(init, ts.SyntaxKind.AsyncKeyword),
            isExported: isExported(node),
          });
          if (init.body) ts.forEachChild(init.body, c => visit(c, `${name}.`));
        } else if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
          visitMembers(decl.initializer.properties, name, isExported(node), undefined);
        } else if (decl.initializer && ts.isClassExpression(decl.initializer)) {
          visitMembers(decl.initializer.members, name, isExported(node), bare);
        }
      }
      return;
    }

    ts.forEachChild(node, c => visit(c, prefix));
  }

  ts.forEachChild(sf, c => visit(c, ""));
  return out;
}

/**
 * Overload signatures dropped in favour of the implementation they describe.
 *
 * `function parse(x: string): number;` written three times over one
 * implementation is a single symbol named `parse`, not four. Only the
 * implementation has a body, and it is the one a caller asking for `parse`
 * wants. A signature with no implementation anywhere is ambient (`declare`),
 * so one of those is kept.
 */
export function withoutOverloadSignatures(scopes: FunctionScope[]): FunctionScope[] {
  const implemented = new Set(scopes.filter(s => s.body).map(s => s.name));
  const keptBodyless = new Set<string>();
  return scopes.filter(s => {
    if (s.body) return true;
    if (implemented.has(s.name)) return false;
    // A getter and a setter share one dotted name, so deduping on the name
    // alone dropped the setter of a bodyless pair - `abstract get x()` /
    // `abstract set x(v)` listed only the getter.
    const key = `${s.name} ${s.kind}`;
    if (keptBodyless.has(key)) return false;
    keptBodyless.add(key);
    return true;
  });
}

/** Exact name, else `Class.method` answering to `method`. */
export function findScopes(scopes: FunctionScope[], target: string): FunctionScope[] {
  const exact = scopes.filter(s => s.name === target);
  return exact.length ? exact : scopes.filter(s => s.name.endsWith(`.${target}`));
}

/** Rendered signature, `(a: string): void`. */
export function signatureOf(scope: FunctionScope, sf: ts.SourceFile): string {
  const params = scope.params.map(p => p.getText(sf)).join(", ");
  const ret = scope.returnType ? `: ${scope.returnType.getText(sf)}` : "";
  return `(${params})${ret}`;
}
