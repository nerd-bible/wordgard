import {EditorSelection} from "@willows/state"
import {NodePos} from "@willows/doc"
import {EditorView} from "./editorview"
import {isEquivalentPosition, getSelection, SelectionRange} from "./dom"
import {findVerticalInTextblock} from "./coords"

export function setDOMSelection(view: EditorView) {
  let {anchor, head, assoc} = view.state.selection
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
  return EditorSelection.range(anchor, head)
}

export function moveVertically(view: EditorView, start: EditorSelection, forward: boolean, distance: number = 0) {
  let editorRect = view.dom.getBoundingClientRect()
  let coords = view.coordsAtPos(start.head, start.assoc || -1)
  let goalColumn = start.goalColumn ?? coords.left - editorRect.left
  let x = editorRect.left + goalColumn
  for (let scan = start.head, y = forward ? coords.bottom + distance : coords.top - distance;;) {
    let pos = view.state.doc.resolve(start.head), block = pos.textblockParent
    if (block) {
      let elt = view.docElt.resolve(block.start, -1)
      let rect = (elt.elt.dom as HTMLElement).getBoundingClientRect()
      if (forward ? rect.bottom >= y : rect.top <= y) {
        let found = findVerticalInTextblock(elt.elt, forward, x, y)
        if (found) return EditorSelection.cursor(found.pos, found.assoc, goalColumn)
      }
      y = forward ? rect.bottom + 1 : rect.top - 1
      if (!block.parent) return null
      scan = forward ? block.after : block.before
    }
    let nextCursor = (forward ? EditorSelection.nextNormalCursor : EditorSelection.prevNormalCursor)
      (view.state, EditorSelection.cursor(scan, 0))
    if (!nextCursor) return null
    let nextBlock = findTextblockVertically(view, scan, forward, x)
    if (!nextBlock || (forward ? nextCursor.head < nextBlock.start : nextCursor.head > nextBlock.end)) {
      let coords = view.coordsAtPos(nextCursor.head, nextCursor.assoc || -1)
      if (forward ? coords.bottom > y : coords.top < y)
        return EditorSelection.cursor(nextCursor.head, nextCursor.assoc, goalColumn)
      if (!nextBlock) return null
    }
    scan = forward ? nextBlock.start : nextBlock.end
  }
}

function findTextblockVertically(view: EditorView, from: number, forward: boolean, x: number) {
  let {parent, index, pos} = view.state.doc.resolve(from)
  for (let p: NodePos | null = parent; p; p = p.parent) {
    if (p.node.type.orientation == "column") {
      if (!p.parent) return null
      index = p.index + (forward ? 1 : 0)
      pos = forward ? p.after : p.before
      parent = p.parent
    }
  }
  for (;;) {
    if (parent.node.type.orientation == "column" || forward ? index == parent.node.children.length : !index) {
      if (!parent.parent) return null
      index = parent.index + (forward ? 1 : 0)
      pos += (forward ? 1 : -1)
      parent = parent.parent
    } else {
      let next = parent.node.children[index - (forward ? 0 : 1)]
      if (next.isAtom()) {
        index += forward ? 1 : -1
        pos += forward ? 1 : -1
        continue
      }
      let nextPos = pos - (forward ? 0 : next.length)
      let node = new NodePos(parent, next, nextPos + 1, index - (forward ? 0 : 1))
      if (!next.inlineContent() && next.type.orientation == "column") {
        // Find the child closest to the given x
        let closest = -1, closestPos = -1, closestDist = -1
        for (let chPos = nextPos + 1, i = 0; i < next.children.length; i++) {
          let ch = next.children[i]
          let {elt} = view.docElt.resolve(chPos + 1, -1)
          let rect = (elt.dom as HTMLElement).getBoundingClientRect()
          let dist = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
          if (closestDist < 0 || dist < closestDist) {
            closestDist = dist
            closest = i + (forward ? 0 : 1)
            closestPos = chPos + (forward ? 0 : ch.length)
          }
          chPos += ch.length
        }
        parent = node
        index = closest
        pos = closestPos
      } else if (next.isTextblock()) {
        return node
      } else {
        parent = node
        index = forward ? 0 : next.children.length
        pos += forward ? 1 : -1
      }
    }
  }
}
