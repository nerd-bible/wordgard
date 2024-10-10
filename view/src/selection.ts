import {EditorSelection} from "@willows/state"
import {EditorView} from "./editorview"
import {isEquivalentPosition, getSelection, SelectionRange} from "./dom"

export function setDOMSelection(view: EditorView) {
  let {anchor, head, assoc} = view.state.selection.main
  let anchorDOM = view.docElt.resolve(anchor, anchor == head ? assoc || 1 : anchor < head ? 1 : -1)
  let headDOM = head == anchor ? anchorDOM : view.docElt.resolve(head, head < anchor ? 1 : -1)
  let domSel = getSelection(view.root)
  if (!domSel) return
  if (domSel.focusNode &&
      isEquivalentPosition(anchorDOM.node, anchorDOM.offset, domSel.anchorNode!, domSel.anchorOffset) &&
      isEquivalentPosition(headDOM.node, headDOM.offset, domSel.focusNode!, domSel.focusOffset))
    return

  // Selection.extend can be used to create an 'inverted' selection
  // (one where the focus is before the anchor)
  domSel.collapse(anchorDOM.node, anchorDOM.offset)
  let failed = false
  if (anchor != head) try {
    domSel.extend(headDOM.node, headDOM.offset)
  } catch (_) {
    // Safari may raise an exception when the editor is hidden
    failed = true
  }
  if (!failed) view.observer.setSelectionRange(anchorDOM, headDOM)
}

export function readDOMSelection(view: EditorView, range: SelectionRange) {
  let anchor = view.docElt.posFromDOM(range.anchorNode!, range.anchorOffset, -1)
  let head = range.anchorNode == range.focusNode && range.anchorOffset == range.focusOffset ? anchor
    : view.docElt.posFromDOM(range.focusNode!, range.focusOffset, -1)
  return EditorSelection.range(anchor, head).asSelection()
}
