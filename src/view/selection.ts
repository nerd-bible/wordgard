import {GardSelection, Direction} from "wordgard/state"
import {Pos} from "wordgard/doc"
import {EditorView} from "./editorview"
import {isEquivalentPosition, getSelection, SelectionRange} from "./dom"

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
  return GardSelection.range(anchor, head)
}

const Y_STEP = 5

export function moveVertically(view: EditorView, start: GardSelection, forward: boolean,
                               distance: number = 0, selectNode = false) {
  let editorRect = view.contentDOM.getBoundingClientRect()
  let coords = view.coordsAtPos(start.head, start.assoc || -1)
  let goalColumn = start.goalColumn ?? coords.left - editorRect.left // FIXME does this need to be flipped if RTL?
  let x = editorRect.left + goalColumn, y = forward ? coords.bottom + distance : coords.top - distance
  for (let scan = start.head;;) {
    let pos = view.state.doc.resolve(scan), block = pos.textblockParent
    if (block) {
      let elt = view.docTile.resolve(block.start, 0)
      let rect = (elt.dom as HTMLElement).getBoundingClientRect()
      if (forward ? y < rect.top : y > rect.bottom) y = forward ? rect.top : rect.bottom
      while (forward ? rect.bottom >= y : rect.top <= y) {
        let found = elt.tile.posAtCoords(view.state, x, y)
        if (!found.vertOutside && found.pos != start.head) return GardSelection.cursor(found.pos, found.assoc, goalColumn)
        y += forward ? Y_STEP : -Y_STEP
      }
      if (!block.parent) return null
      scan = forward ? block.after : block.before
    }

    let nextCursor = GardSelection.cursor(scan, 0).nextNormalCursor(view.state, forward)
    if (!nextCursor) return null
    let nextNode = findTargetVertically(view, scan, forward, x, selectNode)
    if (!nextNode || (forward ? nextCursor.head <= nextNode.before : nextCursor.head >= nextNode.after)) {
      let coords = view.coordsAtPos(nextCursor.head, nextCursor.assoc || -1)
      if (forward ? coords.bottom > y : coords.top < y)
        return GardSelection.cursor(nextCursor.head, nextCursor.assoc, goalColumn)
      if (!nextNode) return null
    }
    if (nextNode instanceof Pos.Plot) {
      scan = forward ? nextNode.start : nextNode.end
    } else {
      let coords = view.coordsForElement(nextNode.before)!
      if (forward ? coords.bottom > y : coords.top < y)
        return GardSelection.range(nextNode.before, nextNode.after, goalColumn)
      scan = forward ? nextNode.after : nextNode.before
    }
  }
}

function findTargetVertically(view: EditorView, from: number, forward: boolean, x: number, allowNode: boolean) {
  let {parent, index, pos} = view.state.doc.resolve(from), entering = false
  for (;;) {
    if ((forward ? index == parent.node.content.length : !index) ||
        parent.node.type.orientation == "row" && !entering) {
      if (!parent.parent) return null
      index = parent.index + (forward ? 1 : 0)
      pos += (forward ? 1 : -1)
      parent = parent.parent
      entering = false
    } else {
      let next = parent.node.content[index - (forward ? 0 : 1)]
      let nextPos = pos - (forward ? 0 : next.length)
      if (next.isLeaf || next.type.isAtom) {
        if (allowNode && next.isLeaf && next.type.isSelectable)
          return new Pos.Node(parent, next, nextPos, index - (forward ? 0 : 1))
        index += forward ? 1 : -1
        pos += (forward ? 1 : -1) * next.length
        continue
      }
      let node = new Pos.Plot(parent, next, nextPos, index - (forward ? 0 : 1))
      if (!next.inlineContent && next.type.orientation == "row") {
        // Find the child closest to the given x
        let closest = -1, closestPos = -1, closestDist = -1
        for (let chPos = nextPos + 1, i = 0; i < next.content.length; i++) {
          let ch = next.content[i]
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
        index = forward ? 0 : next.content.length
        pos += forward ? 1 : -1
      }
    }
  }
}

export function moveToLineBoundary(view: EditorView, start: GardSelection, forward: boolean) {
  let block = view.state.doc.resolve(start.head).textblockParent
  if (!block) return null
  let startCoords = view.coordsAtPos(start.head, start.assoc || -1)
  let dir = view.state.textDirection(block.node.tag)
  let blockRect = (view.docTile.resolve(block.start, 0).dom as HTMLElement).getBoundingClientRect()
  let {pos} = view.posAtCoords({x: forward == (dir == Direction.LTR) ? blockRect.right : blockRect.left,
                                y: (startCoords.top + startCoords.bottom) / 2})
  return GardSelection.cursor(pos, forward ? -1 : 1)
}
