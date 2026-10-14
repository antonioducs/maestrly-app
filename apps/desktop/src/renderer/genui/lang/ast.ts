// Adapted from OpenUI lang-core (packages/lang-core/src/parser/ast.ts at f7109dd, MIT, Copyright (c) Thesys Inc.).
// See resources/licenses/openui-MIT.txt. Query and Mutation references are gone: programs cannot reach tools.

import { writeField } from './safe'

/**
 * Every value of an openui-lang expression; `k` is the discriminant.
 *
 * - Literals and structure: `Comp` (`Header("Hi")`), `Str`, `Num`, `Bool`, `Null`, `Arr`, `Obj`, `Ref` (another
 *   statement), `Ph` (a reference that cannot be resolved).
 * - Runtime expressions: `StateRef` (`$count`), `BinOp`, `UnaryOp`, `Ternary`, `Member` (`a.b`), `Index` (`a[0]`) and
 *   `Assign` (`$count = $count + 1`, a binding that computes what it stores).
 */
export type ASTNode =
  | {
      k: 'Comp'
      name: string
      args: ASTNode[]
      mappedProps?: Record<string, ASTNode>
      /** Set on an `@Name(...)` call whose name is not a built-in or action step. */
      fn?: true
    }
  | { k: 'Str'; v: string }
  | { k: 'Num'; v: number }
  | { k: 'Bool'; v: boolean }
  | { k: 'Null' }
  | { k: 'Arr'; els: ASTNode[] }
  | { k: 'Obj'; entries: [string, ASTNode][] }
  | { k: 'Ref'; n: string }
  | { k: 'Ph'; n: string }
  | { k: 'StateRef'; n: string }
  | { k: 'BinOp'; op: string; left: ASTNode; right: ASTNode }
  | { k: 'UnaryOp'; op: string; operand: ASTNode }
  | { k: 'Ternary'; cond: ASTNode; ifTrue: ASTNode; ifFalse: ASTNode }
  | { k: 'Member'; obj: ASTNode; field: string }
  | { k: 'Index'; obj: ASTNode; index: ASTNode }
  | { k: 'Assign'; target: string; value: ASTNode }

/** The nodes that survive parsing and are resolved by the evaluator. */
export type RuntimeExprNode = Extract<
  ASTNode,
  | { k: 'StateRef' }
  | { k: 'BinOp' }
  | { k: 'UnaryOp' }
  | { k: 'Ternary' }
  | { k: 'Member' }
  | { k: 'Index' }
  | { k: 'Assign' }
>

export function isRuntimeExpr(node: ASTNode): node is RuntimeExprNode {
  switch (node.k) {
    case 'StateRef':
    case 'BinOp':
    case 'UnaryOp':
    case 'Ternary':
    case 'Member':
    case 'Index':
    case 'Assign':
      return true
    default:
      return false
  }
}

const AST_KINDS = new Set([
  'Comp',
  'Ref',
  'StateRef',
  'BinOp',
  'UnaryOp',
  'Ternary',
  'Member',
  'Index',
  'Assign',
  'Str',
  'Num',
  'Bool',
  'Null',
  'Arr',
  'Obj',
  'Ph',
])

export function isASTNode(value: unknown): value is ASTNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return AST_KINDS.has((value as Record<string, unknown>).k as string)
}

export function walkAST(node: ASTNode, visit: (node: ASTNode) => void): void {
  const walk = (current: ASTNode) => {
    visit(current)
    switch (current.k) {
      case 'Comp':
        current.args.forEach(walk)
        Object.values(current.mappedProps ?? {}).forEach(walk)
        break
      case 'Arr':
        current.els.forEach(walk)
        break
      case 'Obj':
        current.entries.forEach(([, value]) => walk(value))
        break
      case 'BinOp':
        walk(current.left)
        walk(current.right)
        break
      case 'UnaryOp':
        walk(current.operand)
        break
      case 'Ternary':
        walk(current.cond)
        walk(current.ifTrue)
        walk(current.ifFalse)
        break
      case 'Member':
        walk(current.obj)
        break
      case 'Index':
        walk(current.obj)
        walk(current.index)
        break
      case 'Assign':
        walk(current.value)
        break
    }
  }
  walk(node)
}

/** A statement, classified at parse time: `$name = …` declares state, anything else is a value. */
export type Statement = { kind: 'value'; id: string; expr: ASTNode } | { kind: 'state'; id: string; init: ASTNode }

// {n: [1]} -> {k: "Obj", entries: [["n", {k: "Arr", els: [Num 1]}]]}
export function toLiteralAST(value: unknown): ASTNode {
  if (value === null || value === undefined) return { k: 'Null' }
  if (typeof value === 'string') return { k: 'Str', v: value }
  if (typeof value === 'number') return { k: 'Num', v: value }
  if (typeof value === 'boolean') return { k: 'Bool', v: value }
  if (Array.isArray(value)) return { k: 'Arr', els: value.map(toLiteralAST) }
  if (typeof value === 'object') {
    return {
      k: 'Obj',
      entries: Object.entries(value).map(([k, v]) => [k, toLiteralAST(v)] as [string, ASTNode]),
    }
  }
  return { k: 'Null' }
}

// {k: "Arr", els: [Num 1]} -> {v: [1]}; a Ref or a call -> undefined
export function literalValue(node: ASTNode): { v: unknown } | undefined {
  switch (node.k) {
    case 'Str':
    case 'Num':
    case 'Bool':
      return { v: node.v }
    case 'Null':
      return { v: null }
    case 'Arr': {
      const v: unknown[] = []
      for (const e of node.els) {
        const lit = literalValue(e)
        if (!lit) return undefined
        v.push(lit.v)
      }
      return { v }
    }
    case 'Obj': {
      const v: Record<string, unknown> = {}
      for (const [k, e] of node.entries) {
        const lit = literalValue(e)
        if (!lit) return undefined
        writeField(v, k, lit.v)
      }
      return { v }
    }
    default:
      return undefined
  }
}
