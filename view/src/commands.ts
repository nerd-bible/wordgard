import {Node, Slice, Text} from "@willows/doc"
import {EditorSelection} from "@willows/state"
import {EditorView} from "./editorview"

/// Command functions are used in key bindings and other types of user
/// actions. Given an editor view, they check whether their effect can
/// apply to the editor, and if it can, perform it as a side effect
/// (which usually means [dispatching](#view.EditorView.dispatch) a
/// transaction) and return `true`.
export type Command = (target: EditorView) => boolean

export const insertLineBreakInCode: Command = view => {
  let {doc, mainSel: sel} = view.state
  if (!sel.from.node.type.preserveWhitespace || sel.from.start != sel.to.start) return false
  let props = view.state.selection.props || sel.from.props(sel.to)
  view.dispatch({
    changes: {from: sel.from.pos, to: sel.to.pos,
              insert: new Slice([(doc.schema.lineBreak ? doc.schema.lineBreak.create() : Node.text("\n")).withProps(props)])},
    selection: EditorSelection.cursor(sel.from.pos + 1, -1),
    scrollIntoView: true
  })
  return true
}

/// If the selection is not in an inline context, insert an empty
/// default textblock in its position.
export const createTextblock: Command = view => {
  let {state} = view, sel = state.mainSel
  if (sel.head.node.inlineContent() || sel.anchor.node.inlineContent()) return false
  let wrap = state.doc.schema.findWrapping(sel.from.node.type, Text)
  if (!wrap) return false
  let content: Node[] = []
  for (let i = wrap.length - 1; i >= 0; i--) content = [wrap[i].create(content)]
  let slice = new Slice(content)
  view.dispatch({
    changes: {from: sel.from.pos, to: sel.to.pos, insert: slice, fit: true},
    selection: EditorSelection.cursor(sel.from.pos + slice.length, -1),
    normalizeSelection: true,
    scrollIntoView: true
  })
  return true
}

export const defaultEnter: Command = (view: EditorView) => {
  return insertLineBreakInCode(view) ||
    createTextblock(view)
  // || liftEmptyBlock(view) || splitBlock(view)
}
