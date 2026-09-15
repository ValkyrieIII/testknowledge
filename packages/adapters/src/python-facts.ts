import { parser } from "@lezer/python";

/**
 * Framework-agnostic facts read straight from the Python syntax tree.
 *
 * Nothing here decides whether code is "a test" or what an assertion "means".
 * It only reports what the code literally contains, with exact line locations,
 * so that any framework profile (pytest, unittest, ...) can interpret it later.
 */

type PyNode = {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: PyNode | null;
  readonly nextSibling: PyNode | null;
  readonly parent: PyNode | null;
};

export type FactLocation = { lineStart: number; lineEnd: number };
export type AssertionFact = FactLocation & { text: string };
export type CallFact = FactLocation & { name: string; args: string[]; literals: unknown[] };
export type DecoratorFact = { name: string; args: string[]; literals: unknown[]; text: string };
export type ParameterFact = { name: string; default?: string };
export type WithFact = FactLocation & { call: string; args: string[]; literals: unknown[] };
export type TryFact = FactLocation & { exceptionTypes: string[] };

export type PythonFunctionFacts = {
  name: string;
  lineStart: number;
  lineEnd: number;
  isAsync: boolean;
  enclosingClass: string;
  decorators: DecoratorFact[];
  parameters: ParameterFact[];
  assertions: AssertionFact[];
  calls: CallFact[];
  withBlocks: WithFact[];
  tryHandlers: TryFact[];
};

const MOCK_NAME = /(?:^|\.)(?:patch|Mock|MagicMock)$/u;
const FACTORY_NAME = /(?:^|\.)(?:[A-Z]\w*Factory|[a-z_]\w*_factory)(?:\.(?:build|build_batch|create|create_batch))?$/u;

function childNodes(node: PyNode): PyNode[] {
  const out: PyNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) out.push(child);
  return out;
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

function stringValue(raw: string): string {
  const match = /^[a-zA-Z]*(["'])([\s\S]*)\1$/u.exec(raw);
  return match?.[2] ?? raw;
}

/** Literal value of a node, or undefined when it is not a literal. */
function literalOf(node: PyNode, text: string): unknown {
  switch (node.name) {
    case "String":
      return stringValue(text.slice(node.from, node.to));
    case "Number": {
      const raw = text.slice(node.from, node.to).replaceAll("_", "");
      const value = Number(raw);
      return Number.isNaN(value) ? raw : value;
    }
    case "Boolean":
      return text.slice(node.from, node.to) === "True";
    case "None":
      return null;
    case "ArrayExpression":
    case "TupleExpression": {
      const values: unknown[] = [];
      for (const child of childNodes(node)) {
        const value = literalOf(child, text);
        if (value !== undefined) values.push(value);
      }
      return values;
    }
    case "UnaryExpression": {
      const [operator, operand] = childNodes(node);
      if (!operator || !operand) return undefined;
      const value = literalOf(operand, text);
      return operator.name === "-" && typeof value === "number" ? -value : undefined;
    }
    default:
      return undefined;
  }
}

function calleeName(call: PyNode, text: string): string {
  const callee = call.firstChild;
  return callee ? text.slice(callee.from, callee.to) : "";
}

function argListOf(call: PyNode): PyNode | null {
  return childNodes(call).find((child) => child.name === "ArgList") ?? null;
}

/** Source text of each top-level argument, split on commas. */
function argumentTexts(list: PyNode, text: string): string[] {
  const out: string[] = [];
  let start: number | null = null;
  let end: number | null = null;
  const flush = (): void => {
    if (start !== null && end !== null) {
      const value = text.slice(start, end).trim();
      if (value) out.push(value);
    }
    start = null;
    end = null;
  };
  for (const child of childNodes(list)) {
    if (child.name === "(" || child.name === ")") continue;
    if (child.name === ",") {
      flush();
      continue;
    }
    if (start === null) start = child.from;
    end = child.to;
  }
  flush();
  return out;
}

function argLiterals(list: PyNode, text: string): unknown[] {
  const values: unknown[] = [];
  for (const child of childNodes(list)) {
    const value = literalOf(child, text);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function callFact(call: PyNode, text: string): CallFact {
  const list = argListOf(call);
  return {
    name: calleeName(call, text),
    args: list ? argumentTexts(list, text) : [],
    literals: list ? argLiterals(list, text) : [],
    lineStart: lineAt(text, call.from),
    lineEnd: lineAt(text, call.to),
  };
}

function decoratorFacts(fn: PyNode, text: string): DecoratorFact[] {
  const parent = fn.parent;
  if (!parent || parent.name !== "DecoratedStatement") return [];
  const out: DecoratorFact[] = [];
  for (const child of childNodes(parent)) {
    if (child.name !== "Decorator") continue;
    const raw = text.slice(child.from, child.to).trim();
    const list = childNodes(child).find((item) => item.name === "ArgList");
    out.push({
      name: raw.replace(/^@/u, "").split("(")[0]?.trim() ?? "",
      args: list ? argumentTexts(list, text) : [],
      literals: list ? argLiterals(list, text) : [],
      text: raw,
    });
  }
  return out;
}

function parameterFacts(paramList: PyNode, text: string): ParameterFact[] {
  const out: ParameterFact[] = [];
  let current: ParameterFact | null = null;
  let star = false;
  for (const child of childNodes(paramList)) {
    if (child.name === ",") {
      star = false;
      continue;
    }
    if (child.name === "*" || child.name === "**") {
      star = true;
      continue;
    }
    if (child.name === "VariableName") {
      if (star) {
        star = false;
        continue;
      }
      current = { name: text.slice(child.from, child.to) };
      out.push(current);
      continue;
    }
    if (child.name === "AssignOp" && current) {
      const valueNode = child.nextSibling;
      if (valueNode) current.default = text.slice(valueNode.from, valueNode.to);
    }
  }
  return out.filter((item) => item.name !== "self" && item.name !== "cls");
}

/** Calls that appear in a `with` header (before its body). */
function withFacts(node: PyNode, text: string): WithFact[] {
  const out: WithFact[] = [];
  for (const child of childNodes(node)) {
    if (child.name === "Body") break;
    if (child.name !== "CallExpression") continue;
    const list = argListOf(child);
    out.push({
      call: calleeName(child, text),
      args: list ? argumentTexts(list, text) : [],
      literals: list ? argLiterals(list, text) : [],
      lineStart: lineAt(text, child.from),
      lineEnd: lineAt(text, child.to),
    });
  }
  return out;
}

function exceptionTypes(node: PyNode, text: string): string[] {
  if (node.name === "VariableName" || node.name === "MemberExpression") return [text.slice(node.from, node.to)];
  if (node.name === "TupleExpression") {
    return childNodes(node)
      .filter((child) => child.name === "VariableName" || child.name === "MemberExpression")
      .map((child) => text.slice(child.from, child.to));
  }
  return [];
}

function tryFacts(node: PyNode, text: string): TryFact[] {
  const out: TryFact[] = [];
  let pending = false;
  for (const child of childNodes(node)) {
    if (child.name === "except") {
      pending = true;
      continue;
    }
    if (!pending) continue;
    if (child.name === "Body") {
      out.push({ exceptionTypes: [], lineStart: lineAt(text, child.from), lineEnd: lineAt(text, child.to) });
      pending = false;
      continue;
    }
    out.push({ exceptionTypes: exceptionTypes(child, text), lineStart: lineAt(text, child.from), lineEnd: lineAt(text, child.to) });
    pending = false;
  }
  return out;
}

function collectFacts(root: PyNode, text: string): Pick<PythonFunctionFacts, "assertions" | "calls" | "withBlocks" | "tryHandlers"> {
  const assertions: AssertionFact[] = [];
  const calls: CallFact[] = [];
  const withBlocks: WithFact[] = [];
  const tryHandlers: TryFact[] = [];
  const visit = (node: PyNode, isRoot: boolean): void => {
    if (!isRoot && (node.name === "FunctionDefinition" || node.name === "ClassDefinition")) return;
    if (node.name === "AssertStatement") {
      assertions.push({
        text: text.slice(node.from, node.to).replace(/^\s*assert\s+/u, ""),
        lineStart: lineAt(text, node.from),
        lineEnd: lineAt(text, node.to),
      });
    } else if (node.name === "CallExpression") {
      calls.push(callFact(node, text));
    } else if (node.name === "WithStatement") {
      withBlocks.push(...withFacts(node, text));
    } else if (node.name === "TryStatement") {
      tryHandlers.push(...tryFacts(node, text));
    }
    for (const child of childNodes(node)) visit(child, false);
  };
  visit(root, true);
  return { assertions, calls, withBlocks, tryHandlers };
}

function className(node: PyNode, text: string): string {
  const nameNode = childNodes(node).find((child) => child.name === "VariableName");
  return nameNode ? text.slice(nameNode.from, nameNode.to) : "anonymous";
}

function functionFacts(node: PyNode, text: string, enclosingClass: string): PythonFunctionFacts {
  const children = childNodes(node);
  const nameNode = children.find((child) => child.name === "VariableName");
  const paramList = children.find((child) => child.name === "ParamList") ?? null;
  return {
    name: nameNode ? text.slice(nameNode.from, nameNode.to) : "anonymous",
    lineStart: lineAt(text, node.from),
    lineEnd: lineAt(text, node.to),
    isAsync: children.some((child) => child.name === "async"),
    enclosingClass,
    decorators: decoratorFacts(node, text),
    parameters: paramList ? parameterFacts(paramList, text) : [],
    ...collectFacts(node, text),
  };
}

/** Every function in the file, with the class it is nested in (if any). */
export function extractFunctions(text: string): PythonFunctionFacts[] {
  const root = parser.parse(text).topNode as unknown as PyNode;
  const out: PythonFunctionFacts[] = [];
  const visit = (node: PyNode, classStack: string[]): void => {
    const stack = node.name === "ClassDefinition" ? [...classStack, className(node, text)] : classStack;
    if (node.name === "FunctionDefinition") out.push(functionFacts(node, text, stack.at(-1) ?? ""));
    for (const child of childNodes(node)) visit(child, stack);
  };
  visit(root, []);
  return out;
}

export function isMockCall(name: string): boolean {
  return MOCK_NAME.test(name);
}

/** Conservative factory recognition: explicit Factory classes or *_factory helpers only. */
export function isFactoryCall(name: string): boolean {
  return FACTORY_NAME.test(name);
}
