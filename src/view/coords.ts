import {Direction} from "wordgard/state"
import {textRange, maxOffset, singleRect} from "./dom"
import {dirAt} from "./tile"
import {EditorView} from "./editorview"

// Given a position in the document model, get a bounding box of the
// character at that position, relative to the window.
export function coordsAtPos(view: EditorView, pos: number, assoc: -1 | 1): DOMRect {
  let tile = view.docTile.resolve(pos, assoc)
  let node = tile.dom, {offset} = tile

  if (node.nodeType == 3) {
    let len = node.nodeValue!.length
    if (!len) return singleRect(textRange(node as Text, 0, 0), 1)
    let from = offset, to = offset, side = assoc < 0 && from || from == len ? 1 : -1
    if (side < 0) to++
    else from--
    return flattenV(singleRect(textRange(node as Text, from, to), side),
                    (side < 0) == (dirAt(view.state, pos, assoc) == Direction.LTR))
  }

  let tagTile = tile.tile
  while (!tagTile.node) tagTile = tagTile.parent!
  // Return a horizontal line in block context
  if (!tagTile.node.isLeaf && tagTile.node.type.orientation == "column") {
    if (offset && (assoc < 0 || offset == maxOffset(node))) {
      let before = node.childNodes[offset - 1]
      if (before.nodeType == 1) return flattenH((before as HTMLElement).getBoundingClientRect(), false)
    }
    if (offset < maxOffset(node)) {
      let after = node.childNodes[offset]
      if (after.nodeType == 1) return flattenH((after as HTMLElement).getBoundingClientRect(), true)
    }
    return flattenH((node as HTMLElement).getBoundingClientRect(), assoc > 0)
  }

  // Inline, not in text node
  if (offset && (assoc < 0 || offset == maxOffset(node))) {
    let before = node.childNodes[offset - 1]
    let target = before.nodeType == 3 ? textRange(before as Text, maxOffset(before))
        // BR nodes tend to only return the rectangle before them.
        // Only use them if they are the last element in their parent
        : before.nodeType == 1 && (before.nodeName != "BR" || !before.nextSibling) ? before : null
    if (target) return flattenV(singleRect(target as Range | HTMLElement, 1), dirAt(view.state, pos, assoc) == Direction.RTL)
  }
  if (offset < maxOffset(node)) {
    let after = node.childNodes[offset]
    let target = !after ? null : after.nodeType == 3 ? textRange(after as Text, 0, 0)
        : after.nodeType == 1 ? after : null
    if (target) return flattenV(singleRect(target as Range | HTMLElement, -1), dirAt(view.state, pos, assoc) == Direction.LTR)
  }
  // All else failed, just try to get a rectangle for the target node
  return flattenV(singleRect(node.nodeType == 3 ? textRange(node as Text, 0, node.nodeValue!.length) : node as HTMLElement, -assoc),
                  assoc > 0)
}

function flattenV(rect: DOMRect, left: boolean) {
  return rect.width ? new DOMRect(left ? rect.left : rect.right, rect.top, 0, rect.height) : rect
}

function flattenH(rect: DOMRect, top: boolean) {
  return rect.height ? new DOMRect(rect.left, top ? rect.top : rect.bottom, rect.width, 0) : rect
}
