import {Rect, textRange, maxOffset, clientRectsFor, singleRect} from "./dom"
import browser from "./browser"
import {EditorView} from "./editorview"
import {Tile, Orientation} from "./content"

// Given an x,y position on the editor, get the position in the document.
export function posAtCoords(view: EditorView, coords: {x: number, y: number}) {
  let elt = ((view.root as any).elementFromPoint ? view.root : view.dom.ownerDocument)
              .elementFromPoint(coords.x, coords.y) as HTMLElement
  let tile = (elt && view.docTile.nearest(elt)) || view.docTile
  return tile.posAtCoords(view.state, coords.x, coords.y)
}

const BIDI = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/

// Given a position in the document model, get a bounding box of the
// character at that position, relative to the window.
export function coordsAtPos(view: EditorView, pos: number, assoc: number): Rect {
  let tile = view.docTile.resolve(pos, assoc < 0 ? -1 : 1)
  let node = tile.dom, {offset} = tile

  if (node.nodeType == 3) {
    // These browsers support querying empty text ranges. Prefer that in
    // bidi context or when at the end of a node.
    if (BIDI.test(node.nodeValue!) || (assoc < 0 ? !offset : offset == node.nodeValue!.length)) {
      let rect = singleRect(textRange(node as Text, offset, offset), assoc)
      // Firefox returns bad results (the position before the space)
      // when querying a position directly after line-broken
      // whitespace. Detect this situation and and kludge around it
      if (browser.gecko && offset && /\s/.test(node.nodeValue![offset - 1]) && offset < node.nodeValue!.length) {
        let rectBefore = singleRect(textRange(node as Text, offset - 1, offset - 1), -1)
        if (rectBefore.top == rect.top) {
          let rectAfter = singleRect(textRange(node as Text, offset, offset + 1), -1)
          if (rectAfter.top != rect.top)
            return flattenV(rectAfter, rectAfter.left < rectBefore.left)
        }
      }
      return rect
    } else {
      let from = offset, to = offset, takeSide = assoc < 0 ? 1 : -1
      if (assoc < 0 && !offset) { to++; takeSide = -1 }
      else if (assoc >= 0 && offset == node.nodeValue!.length) { from--; takeSide = 1 }
      else if (assoc < 0) { from-- }
      else { to ++ }
      return flattenV(singleRect(textRange(node as Text, from, to), takeSide), takeSide < 0)
    }
  }

  let tagTile = tile.tile
  while (!tagTile.nodeTag) tagTile = tagTile.parent!
  // Return a horizontal line in block context
  if (tagTile.nodeTag.type.orientation == "row") {
    if (offset && (assoc < 0 || offset == maxOffset(node))) {
      let before = node.childNodes[offset - 1]
      if (before.nodeType == 1) return flattenH((before as HTMLElement).getBoundingClientRect(), false)
    }
    if (offset < maxOffset(node)) {
      let after = node.childNodes[offset]
      if (after.nodeType == 1) return flattenH((after as HTMLElement).getBoundingClientRect(), true)
    }
    return flattenH((node as HTMLElement).getBoundingClientRect(), assoc >= 0)
  }

  // Inline, not in text node (this is not Bidi-safe)
  if (offset && (assoc < 0 || offset == maxOffset(node))) {
    let before = node.childNodes[offset - 1]
    let target = before.nodeType == 3 ? textRange(before as Text, maxOffset(before))
        // BR nodes tend to only return the rectangle before them.
        // Only use them if they are the last element in their parent
        : before.nodeType == 1 && (before.nodeName != "BR" || !before.nextSibling) ? before : null
    if (target) return flattenV(singleRect(target as Range | HTMLElement, 1), false)
  }
  if (offset < maxOffset(node)) {
    let after = node.childNodes[offset]
    let target = !after ? null : after.nodeType == 3 ? textRange(after as Text, 0, 0)
        : after.nodeType == 1 ? after : null
    if (target) return flattenV(singleRect(target as Range | HTMLElement, -1), true)
  }
  // All else failed, just try to get a rectangle for the target node
  return flattenV(singleRect(node.nodeType == 3 ? textRange(node as Text, 0, node.nodeValue!.length) : node as HTMLElement, -assoc),
                  assoc >= 0)
}

function flattenV(rect: DOMRect, left: boolean) {
  if (rect.width == 0) return rect
  let x = left ? rect.left : rect.right
  return {top: rect.top, bottom: rect.bottom, left: x, right: x}
}

function flattenH(rect: DOMRect, top: boolean) {
  if (rect.height == 0) return rect
  let y = top ? rect.top : rect.bottom
  return {top: y, bottom: y, left: rect.left, right: rect.right}
}

// FIXME see if this can be rolled into Tile.posAtCoords
export function findVerticalInTextblock(
  view: EditorView, elt: Tile, forward: boolean, x: number, y: number
): {pos: number, assoc: number} | null {
  let closest: Rect | null = null, closestX = -1, closestTile = null as Tile | null
  let scan = (elt: Tile) => {
    if (elt.isNode && elt.isAtom) {
      let rects = clientRectsFor(elt.dom)
      for (let i = 0; i < rects.length; i++) {
        let rect = rects[i]
        if (forward ? rect.top < y : rect.bottom > y) continue
        if (closest) {
          if (forward ? rect.bottom < closest.top : rect.top > closest.bottom) closest = null
          else if (forward ? rect.top > closest.bottom : rect.bottom < closest.top) continue
        }
        let xDist = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
        if (!closest || closestX > xDist) {
          closest = rect
          closestX = xDist
          closestTile = elt
        }
      }
    } else {
      for (let ch of elt.children) scan(ch)
    }
  }
  scan(elt)
  if (!closestTile) return null
  if (closestTile.isText)
    return closestTile.posAtCoordsInner(view.state, Math.max(closest!.left, Math.min(closest!.right, x)),
                                        Math.max(closest!.top, Math.min(closest!.bottom, y)),
                                        Orientation.Row, view.state.textDirection(elt.nodeTag!))
  let pos = closestTile.posBefore
  // FIXME use text direction
  if (x < (closest!.left + closest!.right) / 2) return {pos, assoc: 1}
  return {pos: pos + 1, assoc: -1}
}
