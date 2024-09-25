import {EditorView} from "./editorview"

/// Command functions are used in key bindings and other types of user
/// actions. Given an editor view, they check whether their effect can
/// apply to the editor, and if it can, perform it as a side effect
/// (which usually means [dispatching](#view.EditorView.dispatch) a
/// transaction) and return `true`.
export type Command = (target: EditorView) => boolean

// FIXME put these somewhere else?

export let defaultEnter: Command = (view: EditorView) => {
  // newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock
  return false
}
