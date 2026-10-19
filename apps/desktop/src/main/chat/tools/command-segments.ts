/**
 * Splits a command into the subcommands the permission gate checks one by one. A saved "npm test *" rule must not
 * authorize "npm test && rm -rf /": every subcommand, including the contents of command substitutions, becomes a
 * resource of its own and the broker requires all of them to be allowed.
 *
 * The scanners fail closed. Syntax they cannot read with certainty makes the whole command unreadable (`null`): the
 * gate then matches it against no saved rule and asks. Unreadable for sh:
 * - unterminated quotes, substitutions, groups, heredocs, or a trailing backslash;
 * - a `)` that closes nothing, and a `(` outside command position (case patterns, function definitions, arrays,
 *   extglob); `case` itself, whose patterns end in unbalanced `)`;
 * - quotes, backslashes or newlines inside `${...}` (or a bare `{`) and `$((...))` (or any character arithmetic does
 *   not use), a `$((` that does not end in `))`, and `$[...]`;
 * - `$'...'` with a backslash (shells without ANSI-C quoting read it differently);
 * - in backquotes: comments, and `\"` inside double quotes or heredocs (both unspecified by POSIX);
 * - a heredoc whose operator line continues past a newline, whose body continues a line with a backslash, or whose
 *   delimiter is not a plain word.
 * Unreadable for PowerShell: unterminated strings, here-strings, comments, subexpressions or blocks; a `)` or `}`
 * that closes nothing; a `#` that does not begin a token; quotes inside `${...}`; and `--%`, after which the rest of
 * the line is not parsed as PowerShell.
 */
import type { CommandDialect } from './command-shell'

class Unreadable extends Error {}

function unreadable(): never {
  throw new Unreadable()
}

/** Subcommands of `command` read with `dialect` rules, or `null` when the command is unreadable. */
export function splitCommand(command: string, dialect: CommandDialect): string[] | null {
  const scanner = dialect === 'powershell' ? new PowerShellScanner(command) : new ShScanner(command)
  try {
    scanner.list(0, null)
  } catch (error) {
    if (error instanceof Unreadable) return null
    throw error
  }
  return scanner.segs
}

/** Words after which the next word is still in command position. */
const SH_PREFIX_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time'])
const SH_BLANK = new Set([' ', '\t'])
const SH_OPERATOR = new Set([';', '&', '|', '<', '>', '(', ')', '\n'])
/** Characters `$((...))` accepts besides expansions and parentheses. */
const ARITHMETIC_CHAR = /[\w \t+\-*/%<>=!&|^~?:,.#@$[\]]/
const HEREDOC_DELIMITER = /^[\w.-]+$/

interface Heredoc {
  delimiter: string
  stripTabs: boolean
  expands: boolean
}

type ShContext = 'plain' | 'double' | 'heredoc'

class ShScanner {
  readonly segs: string[] = []

  constructor(
    private readonly src: string,
    private readonly inBackquotes = false
  ) {}

  /** Scans a command list from `start`. With `close` (`)`) it ends at the parenthesis that closes it and returns that index. */
  list(start: number, close: ')' | null): number {
    const src = this.src
    let cur = ''
    let quote: "'" | '"' | null = null
    let inWord = false
    let word = ''
    let plainWord = true
    let commandPosition = true
    let afterRedirect = false
    let heredocs: Heredoc[] = []
    let heredocAt = -1
    const push = () => {
      const text = cur.trim()
      if (text) this.segs.push(text)
      cur = ''
    }
    const beginWord = (plain: boolean, text = '') => {
      if (!inWord) {
        inWord = true
        word = ''
        plainWord = true
      }
      if (plain) word += text
      else plainWord = false
    }
    const endWord = () => {
      if (!inWord) return
      inWord = false
      if (!commandPosition) return
      if (plainWord && word === 'case') unreadable()
      commandPosition = plainWord && SH_PREFIX_WORDS.has(word)
    }
    const separate = () => {
      endWord()
      push()
      commandPosition = true
    }

    let i = start
    for (; i < src.length; i++) {
      const ch = src[i]
      const redirected = afterRedirect
      afterRedirect = false
      if (quote === "'") {
        cur += ch
        if (ch === "'") quote = null
        continue
      }
      if (quote === '"') {
        if (ch === '"') {
          quote = null
          cur += ch
          continue
        }
        // Inside double quotes a backslash escapes $ ` " \ and newline; before anything else both stay literal.
        if (ch === '\\') {
          if (i + 1 >= src.length) unreadable()
          cur += src.slice(i, i + 2)
          i++
          continue
        }
        const end = this.expansion(i, 'double')
        if (end >= 0) {
          cur += src.slice(i, end + 1)
          i = end
          continue
        }
        cur += ch
        continue
      }
      if (ch === '\\') {
        if (i + 1 >= src.length) unreadable()
        // A line continuation joins the lines and leaves the word as it was.
        if (src[i + 1] !== '\n') beginWord(false)
        cur += src.slice(i, i + 2)
        i++
        continue
      }
      if (ch === "'" || ch === '"') {
        beginWord(false)
        quote = ch
        cur += ch
        continue
      }
      if (ch === '#' && !inWord) {
        // A comment runs to the end of the line; quotes and separators in it do nothing.
        if (this.inBackquotes) unreadable()
        const newline = src.indexOf('\n', i)
        const end = newline === -1 ? src.length : newline
        cur += src.slice(i, end)
        i = end - 1
        continue
      }
      if (ch === '$' && src[i + 1] === "'") {
        const end = src.indexOf("'", i + 2)
        if (end === -1 || src.slice(i + 2, end).includes('\\')) unreadable()
        beginWord(false)
        cur += src.slice(i, end + 1)
        i = end
        continue
      }
      const expansion = this.expansion(i, 'plain')
      if (expansion >= 0) {
        beginWord(false)
        cur += src.slice(i, expansion + 1)
        i = expansion
        continue
      }
      if (SH_BLANK.has(ch)) {
        endWord()
        cur += ch
        continue
      }
      if (!SH_OPERATOR.has(ch)) {
        beginWord(true, ch)
        cur += ch
        continue
      }
      endWord()
      if (ch === '\n') {
        push()
        commandPosition = true
        if (heredocs.length) {
          // The bodies start on the line after the operators, which must all sit on this one line.
          if (src.slice(heredocAt, i).includes('\n')) unreadable()
          i = this.heredocBodies(i + 1, heredocs) - 1
          heredocs = []
          heredocAt = -1
        }
        continue
      }
      if (ch === ';') {
        separate()
        continue
      }
      if (ch === '&') {
        // >&2, <&0: a descriptor, not a background separator.
        if (redirected) {
          cur += ch
          continue
        }
        if (src[i + 1] === '&') i++
        separate()
        continue
      }
      if (ch === '|') {
        // >| overwrites a file even with noclobber set.
        if (redirected && src[i - 1] === '>') {
          cur += ch
          continue
        }
        if (src[i + 1] === '|' || src[i + 1] === '&') i++
        separate()
        continue
      }
      if (ch === '(') {
        if (!commandPosition) unreadable()
        // A subshell: its commands are segments of their own; what follows it (redirections) is another one.
        i = this.list(i + 1, ')')
        commandPosition = false
        continue
      }
      if (ch === ')') {
        if (close !== ')' || heredocs.length) unreadable()
        push()
        return i
      }
      // < or >
      if (src[i + 1] === '(') {
        if (redirected) unreadable()
        // Process substitution <(...) >(...) runs its contents as commands.
        const end = this.list(i + 2, ')')
        beginWord(false)
        cur += src.slice(i, end + 1)
        i = end
        continue
      }
      if (ch === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        const heredoc = this.heredocOperator(i)
        heredocs.push(heredoc.doc)
        if (heredocAt < 0) heredocAt = i
        cur += src.slice(i, heredoc.end)
        i = heredoc.end - 1
        continue
      }
      if (ch === '<' && src.startsWith('<<<', i)) {
        cur += '<<<'
        i += 2
        continue
      }
      cur += ch
      afterRedirect = true
    }
    if (quote || close || heredocs.length) unreadable()
    endWord()
    push()
    return i
  }

  /** If an expansion that can run commands starts at `i`, gates those commands and returns its last index; else -1. */
  private expansion(i: number, context: ShContext): number {
    const src = this.src
    if (src[i] === '`') return this.backquotes(i, context)
    if (src[i] !== '$') return -1
    if (src[i + 1] === '(') return src[i + 2] === '(' ? this.arithmetic(i + 3) : this.list(i + 2, ')')
    if (src[i + 1] === '{') return this.parameter(i + 2)
    if (src[i + 1] === '[') unreadable()
    return -1
  }

  /** `$((...))`: arithmetic, though substitutions inside it still run. */
  private arithmetic(start: number): number {
    const src = this.src
    let depth = 0
    for (let i = start; i < src.length; i++) {
      const end = this.expansion(i, 'double')
      if (end >= 0) {
        i = end
        continue
      }
      const ch = src[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        if (depth > 0) depth--
        else if (src[i + 1] === ')') return i + 1
        else unreadable()
      } else if (!ARITHMETIC_CHAR.test(ch)) unreadable()
    }
    return unreadable()
  }

  /** `${...}`: its word may hold substitutions; quoting inside it differs between shells. */
  private parameter(start: number): number {
    const src = this.src
    for (let i = start; i < src.length; i++) {
      const end = this.expansion(i, 'double')
      if (end >= 0) {
        i = end
        continue
      }
      const ch = src[i]
      if (ch === '}') return i
      if (ch === "'" || ch === '"' || ch === '\\' || ch === '{' || ch === '\n') unreadable()
    }
    return unreadable()
  }

  /** Backquotes end at the first unescaped backquote; `` \` ``, `\\` and `\$` lose their backslash inside. */
  private backquotes(start: number, context: ShContext): number {
    const src = this.src
    let inner = ''
    for (let i = start + 1; i < src.length; i++) {
      const ch = src[i]
      if (ch === '`') {
        const nested = new ShScanner(inner, true)
        nested.list(0, null)
        this.segs.push(...nested.segs)
        return i
      }
      if (ch === '\\') {
        const next = src[i + 1]
        if (next === undefined || (next === '"' && context !== 'plain')) unreadable()
        if (next === '`' || next === '\\' || next === '$') {
          inner += next
          i++
          continue
        }
      }
      inner += ch
    }
    return unreadable()
  }

  /** Reads `<<WORD` / `<<-WORD` at `start`; `end` is the index after the delimiter. */
  private heredocOperator(start: number): { doc: Heredoc; end: number } {
    const src = this.src
    const stripTabs = src[start + 2] === '-'
    let i = start + (stripTabs ? 3 : 2)
    while (SH_BLANK.has(src[i])) i++
    let delimiter = ''
    let quoted = false
    for (; i < src.length; i++) {
      const ch = src[i]
      if (SH_BLANK.has(ch) || SH_OPERATOR.has(ch)) break
      if (ch === "'" || ch === '"') {
        const end = src.indexOf(ch, i + 1)
        if (end === -1) unreadable()
        delimiter += src.slice(i + 1, end)
        quoted = true
        i = end
      } else if (ch === '\\') {
        if (i + 1 >= src.length) unreadable()
        delimiter += src[i + 1]
        quoted = true
        i++
      } else delimiter += ch
    }
    if (!HEREDOC_DELIMITER.test(delimiter)) unreadable()
    return { doc: { delimiter, stripTabs, expands: !quoted }, end: i }
  }

  /** Reads the bodies that start at `pos`, in order, gating substitutions in unquoted ones; returns the index after them. */
  private heredocBodies(pos: number, docs: Heredoc[]): number {
    const src = this.src
    for (const doc of docs) {
      let lineStart = pos
      for (;;) {
        if (lineStart > src.length) unreadable()
        const newline = src.indexOf('\n', lineStart)
        const lineEnd = newline === -1 ? src.length : newline
        const line = src.slice(lineStart, lineEnd)
        if ((doc.stripTabs ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
          if (doc.expands) this.heredocText(pos, lineStart)
          pos = lineEnd + 1
          break
        }
        // In an unquoted body a trailing backslash joins the next line, which then cannot end the body.
        if (doc.expands && line.endsWith('\\')) unreadable()
        lineStart = lineEnd + 1
      }
    }
    return Math.min(pos, src.length)
  }

  private heredocText(from: number, to: number): void {
    for (let i = from; i < to; i++) {
      if (this.src[i] === '\\') {
        i++
        continue
      }
      const end = this.expansion(i, 'heredoc')
      if (end < 0) continue
      if (end >= to) unreadable()
      i = end
    }
  }
}

/** Quote characters PowerShell accepts: the ASCII ones plus the typographic variants it treats the same way. */
const PS_SINGLE_QUOTES = new Set(["'", '‘', '’', '‚', '‛'])
const PS_DOUBLE_QUOTES = new Set(['"', '“', '”', '„'])
const PS_QUOTES = new Set([...PS_SINGLE_QUOTES, ...PS_DOUBLE_QUOTES])
/** Characters after which a token starts, so a `#` there begins a comment. */
const PS_TOKEN_START = new Set([' ', '\t', '\r', '\n', ';', '|', '(', '{'])

/**
 * PowerShell syntax: the backtick escapes, a backslash is a plain character, typographic quotes open and close strings,
 * a here-string runs from `@"`/`@'` at the end of a line to `"@`/`'@` at the start of one, `#` and `<# #>` are
 * comments, and `(...)`, `$(...)`, `@(...)` and `{...}` hold statements of their own (an argument in parentheses runs
 * as a command). Reading it with the sh rules could take a separator that runs as code for part of a string and join
 * two commands into one resource.
 */
class PowerShellScanner {
  readonly segs: string[] = []

  constructor(private readonly src: string) {}

  /** Scans statements from `start`; with `close` it ends at the `)` or `}` that closes it and returns that index. */
  list(start: number, close: ')' | '}' | null): number {
    const src = this.src
    let cur = ''
    let single = false
    let double = false
    let afterRedirect = false
    const push = () => {
      const text = cur.trim()
      if (text) this.segs.push(text)
      cur = ''
    }
    let i = start
    for (; i < src.length; i++) {
      const ch = src[i]
      const redirected = afterRedirect
      afterRedirect = false
      if (single) {
        cur += ch
        if (PS_SINGLE_QUOTES.has(ch)) single = false
        continue
      }
      if (ch === '`') {
        if (i + 1 >= src.length) unreadable()
        cur += src.slice(i, i + 2)
        i++
        continue
      }
      if (double) {
        if (PS_DOUBLE_QUOTES.has(ch)) double = false
        const end = src.startsWith('$(', i) ? this.list(i + 2, ')') : src.startsWith('${', i) ? this.braced(i) : -1
        if (end >= 0) {
          cur += src.slice(i, end + 1)
          i = end
          continue
        }
        cur += ch
        continue
      }
      if (ch === '@') {
        const end = this.hereString(i)
        if (end >= 0) {
          cur += src.slice(i, end + 1)
          i = end
          continue
        }
      }
      if (PS_SINGLE_QUOTES.has(ch)) {
        single = true
        cur += ch
        continue
      }
      if (PS_DOUBLE_QUOTES.has(ch)) {
        double = true
        cur += ch
        continue
      }
      if (ch === '#' || (ch === '<' && src[i + 1] === '#')) {
        if (!this.tokenStarts(i)) unreadable()
        const end = ch === '#' ? this.lineEnd(i) : src.indexOf('#>', i + 2) + 1
        if (end === 0) unreadable()
        cur += src.slice(i, end + 1)
        i = end
        continue
      }
      if (src.startsWith('--%', i)) unreadable()
      let end = -1
      if (src.startsWith('${', i)) end = this.braced(i)
      else if (src.startsWith('$(', i) || src.startsWith('@(', i)) end = this.list(i + 2, ')')
      else if (src.startsWith('@{', i)) end = this.list(i + 2, '}')
      else if (ch === '(') end = this.list(i + 1, ')')
      else if (ch === '{') end = this.list(i + 1, '}')
      if (end >= 0) {
        cur += src.slice(i, end + 1)
        i = end
        continue
      }
      if (ch === ')' || ch === '}') {
        if (ch !== close) unreadable()
        push()
        return i
      }
      if ((ch === '&' || ch === '|') && src[i + 1] === ch) {
        push()
        i++
        continue
      }
      if (ch === '|' || ch === ';' || ch === '\n' || ch === '\r') {
        push()
        continue
      }
      // The call operator & starts a command; after > it is redirection (2>&1, *>&1).
      if (ch === '&' && !redirected) {
        push()
        continue
      }
      if (ch === '>') afterRedirect = true
      cur += ch
    }
    if (single || double || close) unreadable()
    push()
    return i
  }

  /** Whether a token starts at `i`: at the start or after an unescaped blank, separator or opening bracket. */
  private tokenStarts(i: number): boolean {
    return i === 0 || (PS_TOKEN_START.has(this.src[i - 1]) && !this.escaped(i - 1))
  }

  /** Whether the character at `i` follows an escaping backtick. */
  private escaped(i: number): boolean {
    let ticks = 0
    for (let j = i - 1; j >= 0 && this.src[j] === '`'; j--) ticks++
    return ticks % 2 === 1
  }

  /** Index of the last character before the line break that ends the line holding `i`. */
  private lineEnd(i: number): number {
    let j = i
    while (j + 1 < this.src.length && this.src[j + 1] !== '\n' && this.src[j + 1] !== '\r') j++
    return j
  }

  /** `${name}`: a variable name that runs to the first unescaped `}`. */
  private braced(start: number): number {
    const src = this.src
    for (let i = start + 2; i < src.length; i++) {
      if (src[i] === '`') i++
      else if (src[i] === '}') return i
      else if (PS_QUOTES.has(src[i])) unreadable()
    }
    return unreadable()
  }

  /** If a here-string opens at `start`, returns its last index (gating subexpressions in expandable ones); else -1. */
  private hereString(start: number): number {
    const src = this.src
    const opener = /^@(["'‘’‚‛“”„])[ \t]*\r?\n/.exec(src.slice(start))
    if (!opener) return -1
    const expands = PS_DOUBLE_QUOTES.has(opener[1])
    const quotes = expands ? PS_DOUBLE_QUOTES : PS_SINGLE_QUOTES
    for (let j = start + opener[0].length - 1; j < src.length; j++) {
      if (src[j] === '\n' && quotes.has(src[j + 1] ?? '') && src[j + 2] === '@') return j + 2
      if (!expands) continue
      if (src[j] === '`') j++
      else if (src.startsWith('$(', j)) j = this.list(j + 2, ')')
    }
    return unreadable()
  }
}
