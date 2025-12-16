import {ChangeSet, ChangeSpec, Node} from "wordgard/doc"
import {resolveTransactionInner, mergeTransaction, Transaction} from "./transaction"
import {EditorState} from "./state"

/// Post-process the given transaction spec to check for any block
/// boundaries touched by the changes in it that can be
/// [auto-joined](#doc.NodeSpec.autoJoin). If any are found, the spec
/// is updated to perform those joins.
export function autoJoinBlocks(state: EditorState, tr: Transaction.Spec): Transaction.Spec {
  if (!tr.changes) return tr
  let changes = ChangeSet.create(state.doc, tr.changes), doc = changes.apply(state.doc)
  if (changes.empty) return tr
  let append: ChangeSpec[] = []
  let cursor = doc.resolve(0), check = (pos: number) => {
    cursor = cursor.advance(pos - cursor.pos)
    let before = cursor.nodeBefore, after = cursor.nodeAfter
    if (before && after && before.isBlock && before.type == after.type) {
      let {autoJoin} = after.type.spec
      if (autoJoin && (typeof autoJoin != "function" || autoJoin(before.tag, after.tag))) {
        let from = pos - 1, to = pos + 1
        for (;;) {
          let last: Node | null = before!.lastChild, first: Node | null = after!.firstChild
          if (!first || !last || first.type != last.type || first.isInline) break
          autoJoin = last.type.spec.autoJoin
          if (!autoJoin || (typeof autoJoin == "function" && !autoJoin(last.tag, first.tag))) break
          from--, to++
          before = last; after = first
        }
        append.push({from, to})
      }
    }
  }

  changes.iterGaps(() => {}, (_fromA, _toA, fromB, toB) => {
    check(fromB)
    if (toB > fromB) check(toB)
  })
  if (!append.length) return {...tr, changes}
  return mergeTransaction(state.doc, resolveTransactionInner(state.doc, tr), resolveTransactionInner(doc, {changes: append}), true)
}
