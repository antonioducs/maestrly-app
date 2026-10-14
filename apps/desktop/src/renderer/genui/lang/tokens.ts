// Adapted from OpenUI lang-core (packages/lang-core/src/parser/tokens.ts at f7109dd, MIT, Copyright (c) Thesys Inc.).
// See resources/licenses/openui-MIT.txt.

/** Token kinds; a plain object instead of the upstream `const enum`, which isolated transpilers do not inline. */
export const T = {
  Newline: 0,
  LParen: 1,
  RParen: 2,
  LBrack: 3,
  RBrack: 4,
  LBrace: 5,
  RBrace: 6,
  Comma: 7,
  Colon: 8,
  Equals: 9,
  True: 10,
  False: 11,
  Null: 12,
  EOF: 13,
  Str: 14,
  Num: 15,
  /** A lowercase identifier: a reference. */
  Ident: 16,
  /** A PascalCase identifier: a component name or a reference. */
  Type: 17,
  /** `$name`: a state variable. */
  StateVar: 18,
  Dot: 19,
  Plus: 20,
  Minus: 21,
  Star: 22,
  Slash: 23,
  Percent: 24,
  EqEq: 25,
  NotEq: 26,
  Greater: 27,
  Less: 28,
  GreaterEq: 29,
  LessEq: 30,
  And: 31,
  Or: 32,
  Not: 33,
  Question: 34,
  /** `@Name`: a built-in or library function, or an action step. */
  BuiltinCall: 35,
} as const

export type T = (typeof T)[keyof typeof T]

export interface Token {
  t: T
  v?: string | number
}
