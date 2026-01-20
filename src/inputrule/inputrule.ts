import {EditorView, ViewUpdate} from "wordgard/view"
import {Extension, Facet, autoJoinBlocks} from "wordgard/state"
import {isolateHistory} from "wordgard/history"
import {Leaf, Plot, Pos, ChangeSet} from "wordgard/doc"
import {findWrappable, wrapBlockRange} from "wordgard/command"

export const inputRule = Facet.define<InputRule>()

export const beforeUpdate = EditorView.beforeUpdate.of(applyInputRules)

export class InputRule {
  extension: Extension
  lookahead: RegExp | undefined
  inCode: boolean

  private constructor(readonly expr: RegExp,
                      readonly apply: (view: EditorView, match: DocMatchArray) => boolean,
                      spec: InputRule.Spec) {
    this.lookahead = spec.lookahead
    this.inCode = !!spec.inCode
    this.extension = [inputRule.of(this), beforeUpdate]
  }

  static define(spec: InputRule.Spec) {
    return new InputRule(ensureAnchor(spec.expr),
                         typeof spec.apply == "string" ? applyString(spec.apply) : spec.apply,
                         spec)
  }

  /// Build an input rule for automatically wrapping a textblock when
  /// a given string is typed. The `expr` argument is directly passed
  /// through to the `InputRule` constructor. You'll probably want the
  /// regexp to start with `^`, so that the pattern can only occur at
  /// the start of a textblock. `tag` gives the type of plot to wrap in.
  static wrapping(
    expr: RegExp,
    tag: Plot.Tag.Any | ((match: DocMatchArray) => Plot.Tag.Any)
  ) {
    return InputRule.define({
      expr,
      apply: (view, match) => {
        let wrapper = typeof tag == "function" ? tag(match) : tag
        let {from, to} = match[0]
        let changes: ChangeSet.Spec[] = [{from: from.pos, to: to.pos}]
        let range = findWrappable(from, from, wrapper)
        if (!range) return false
        changes.push(wrapBlockRange(range, wrapper))
        view.dispatch(autoJoinBlocks(view.state, {
          changes,
          annotations: isolateHistory.of("full")
        }))
        return true
      }
    })
  }

  /// Build an input rule that changes the type of a textblock when the
  /// matched text is typed into it. You'll usually want to start your
  /// regexp with `^` so that it is only matched at the start of a
  /// textblock. The optional `getAttrs` parameter can be used to compute
  /// the new node's attributes, and works the same as in the
  /// `wrappingInputRule` function.
  static textblockType(
    expr: RegExp,
    tag: Plot.Tag.Any | ((match: DocMatchArray) => Plot.Tag.Any)
  ) {
    return InputRule.define({
      expr,
      apply: (view, match) => {
        let {from, to} = match[0]
        let block = typeof tag == "function" ? tag(match) : tag
        let outer = from.parent.parent
        if (!outer || !outer.node.type.canContain(block.type)) return false
        view.dispatch({
          changes: [{from: from.pos - 1, to: to.pos, insert: [block]}],
          annotations: isolateHistory.of("full")
        })
        return true
      }
    })
  }
}

export namespace InputRule {
  export interface Spec {
    /// The regular expression to match against the text before the
    /// input. This expression should end in a `$` marker.
    expr: RegExp,
    /// Handler to call when this rule matches. `match` will contain
    /// the document positions of the full match and all matched
    /// groups in `expr`. Should return `true` when it has taken an
    /// action, `false` when it didn't. You probably want to include
    /// `isolateHistory.of("full")` in any transactions you dispatch
    /// from a rule handler, so that users can undo the adjustment if
    /// it wasn't what they wanted.
    ///
    /// When given as a string, the full match will be replaced by
    /// that string.
    apply: ((view: EditorView, match: DocMatchArray) => boolean) | string,
    /// Because the regular expression given in `expr` must end at the
    /// cursor, it is matched against a string that stops at the
    /// cursor, and cannot look beyond it. You can provide an
    /// additional expression here (which should start with `^`) to
    /// enforce a lookahead condition.
    lookahead?: RegExp,
    /// By default, input rules don't apply inside nodes with a
    /// `"Code"` group. Set this to `true` to allow matches in code.
    inCode?: boolean
  }
}

function ensureAnchor(regexp: RegExp) {
  let needsIndex = (regexp as any).hasIndices === false, needsAnchor = !/\$$/.test(regexp.source)
  if (!needsIndex && !needsAnchor) return regexp
  return new RegExp(needsAnchor ? "(?:" + regexp.source + ")$" : regexp.source, regexp.flags + (needsIndex ? "d" : ""))
}

function applyString(text: string) {
  return (view: EditorView, match: DocMatchArray) => {
    view.dispatch({
      changes: {from: match[0].from.pos, to: match[0].to.pos, insert: [Leaf.text(text)]},
      annotations: isolateHistory.of("full")
    })
    return true
  }
}

function getGroupIndices(match: RegExpMatchArray): ([number, number] | undefined)[] {
  if ((match as any).indices) return (match as any).indices
  let result: ([number, number] | undefined)[] = [[0, match[0].length]]
  for (let i = 1, pos = 0; i < match.length; i++) {
    let found = match[i] ? match[0].indexOf(match[i], pos) : -1
    result.push(found < 0 ? undefined : [found, pos = found + match[i].length])
  }
  return result
}

export type DocMatch = {from: Pos, to: Pos, text: string}
export type DocMatchArray = readonly (DocMatch | null)[] & {0: DocMatch}

function applyInputRules(update: ViewUpdate) {
  let typed = -1
  for (let i = update.transactions.length - 1; i >= 0; i--) {
    if (update.transactions[i].isUserEvent("input.type")) {
      for (let j = i + 1; j < update.transactions.length; j++) if (update.transactions[j].selection) return
      typed = i
      break
    }
  }
  if (typed < 0) return
  let {state} = update, cursor = state.sel.head, block = cursor.textblockParent
  if (!block) return
  let map = state.textblockMap(block)
  let curIndex = map.toIndex(cursor.pos), textBefore = map.text.slice(0, curIndex), textAfter: string | undefined
  rules: for (let rule of state.facet(inputRule)) {
    if (!rule.inCode && block.node.type.inGroup("Code")) continue
    let match = rule.expr.exec(textBefore)
    if (!match || rule.lookahead && !rule.lookahead.test(textAfter ?? (textAfter = map.text.slice(curIndex))))
      continue
    let indices = getGroupIndices(match)
    let docMatch: (DocMatch | null)[] = [], parent = -1
    for (let i = 0; i < match.length; i++) {
      let text = match[i]
      if (text == null) {
        docMatch.push(null)
      } else {
        let is = indices[i]!
        let from = state.doc.resolve(map.fromIndex(is[0]))
        let to = state.doc.resolve(map.fromIndex(is[1]))
        // All match boundaries must fall in the same parent node
        if (parent < 0) parent = from.parent.before
        if (parent != from.parent.before || parent != to.parent.before) continue rules
        if (!rule.inCode && from.parent.node.type.inGroup("Code")) continue rules
        docMatch.push({from, to, text})
      }
    }
    if (rule.apply(update.view, docMatch as any as DocMatchArray)) break
  }
}
