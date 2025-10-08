import {EditorSelection, Direction} from "@wordgard/state"
import {NodePos} from "@wordgard/doc"
import {EditorView} from "./editorview"
import {isEquivalentPosition, getSelection, SelectionRange} from "./dom"
import {findVerticalInTextblock} from "./coords"

export function setDOMSelection(view: EditorView) {
  let {anchor, head, assoc} = view.state.selection
  let anchorDOM = view.docTile.resolve(anchor, anchor == head ? assoc || 1 : anchor < head ? 1 : -1)
  let headDOM = head == anchor ? anchorDOM : view.docTile.resolve(head, head < anchor ? 1 : -1)
  let domSel = getSelection(view.root)
  if (!domSel) return
  if (domSel.focusNode &&
      isEquivalentPosition(anchorDOM.dom, anchorDOM.offset, domSel.anchorNode!, domSel.anchorOffset) &&
      isEquivalentPosition(headDOM.dom, headDOM.offset, domSel.focusNode!, domSel.focusOffset))
    return

  // Selection.extend can be used to create an 'inverted' selection
  // (one where the focus is before the anchor)
  domSel.collapse(anchorDOM.dom, anchorDOM.offset)
  let failed = false
  if (anchor != head) try {
    domSel.extend(headDOM.dom, headDOM.offset)
  } catch (_) {
    // Safari may raise an exception when the editor is hidden
    failed = true
  }
  if (!failed) view.observer.setSelectionRange(anchorDOM, headDOM)
}

export function readDOMSelection(view: EditorView, range: SelectionRange) {
  let anchor = view.docTile.posFromDOM(range.anchorNode!, range.anchorOffset, -1)
  let head = range.anchorNode == range.focusNode && range.anchorOffset == range.focusOffset ? anchor
    : view.docTile.posFromDOM(range.focusNode!, range.focusOffset, -1)
  return EditorSelection.range(anchor, head)
}

export function moveVertically(view: EditorView, start: EditorSelection, forward: boolean, distance: number = 0) {
  let editorRect = view.dom.getBoundingClientRect()
  let coords = view.coordsAtPos(start.head, start.assoc || -1)
  let goalColumn = start.goalColumn ?? coords.left - editorRect.left
  let x = editorRect.left + goalColumn, y = forward ? coords.bottom + distance : coords.top - distance
  for (let scan = start.head;;) {
    let pos = view.state.doc.resolve(scan), block = pos.textblockParent
    if (block) {
      let elt = view.docTile.resolve(block.start, 0)
      let rect = (elt.dom as HTMLElement).getBoundingClientRect()
      if (forward ? rect.bottom >= y : rect.top <= y) {
        let found = findVerticalInTextblock(elt.tile, forward, x, y)
        if (found) return EditorSelection.cursor(found.pos, found.assoc, goalColumn)
      }
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
      if (view.state.isAtom(pos - (forward ? 0 : next.length), next)) {
        index += forward ? 1 : -1
        pos += (forward ? 1 : -1) * next.length
        continue
      }
      let nextPos = pos - (forward ? 0 : next.length)
      let node = new NodePos(parent, next, nextPos + 1, index - (forward ? 0 : 1))
      if (!next.inlineContent && next.type.orientation == "column") {
        // Find the child closest to the given x
        let closest = -1, closestPos = -1, closestDist = -1
        for (let chPos = nextPos + 1, i = 0; i < next.children.length; i++) {
          let ch = next.children[i]
          let {tile} = view.docTile.resolve(chPos + 1, 0)
          let rect = (tile.dom as HTMLElement).getBoundingClientRect()
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
      } else if (next.isTextblock) {
        return node
      } else {
        parent = node
        index = forward ? 0 : next.children.length
        pos += forward ? 1 : -1
      }
    }
  }
}

export function moveToLineBoundary(view: EditorView, start: EditorSelection, forward: boolean) {
  let block = view.state.doc.resolve(start.head).textblockParent
  if (!block) return null
  let startCoords = view.coordsAtPos(start.head, start.assoc || -1)
  let dir = view.state.textDirection(block.node.tag)
  let blockRect = (view.docTile.resolve(block.start, 0).dom as HTMLElement).getBoundingClientRect()
  let pos = view.posAtCoords({x: forward == (dir == Direction.LTR) ? blockRect.right : blockRect.left,
                              y: (startCoords.top + startCoords.bottom) / 2})
  return EditorSelection.cursor(pos, forward ? -1 : 1)
}
