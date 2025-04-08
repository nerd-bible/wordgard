import {Rect, textRange, caretFromPoint, maxOffset, clientRectsFor} from "./dom"
import browser from "./browser"
import {EditorView} from "./editorview"
import {EltNode, NodeElt} from "./content"

// FIXME make this aware of node orientation, review
function findOffsetInNode(node: HTMLElement, coords: {x: number, y: number}): {node: Node, offset: number} {
  let closest, dxClosest = 2e8, coordsClosest: {x: number, y: number} | undefined, offset = 0
  let rowBot = coords.y, rowTop = coords.y
  let firstBelow: Node | undefined, coordsBelow: {x: number, y: number} | undefined
  for (let child = node.firstChild, childIndex = 0; child; child = child.nextSibling, childIndex++) {
    let rects
    if (child.nodeType == 1) rects = (child as HTMLElement).getClientRects()
    else if (child.nodeType == 3) rects = textRange(child as Text, 0, child.nodeValue!.length).getClientRects()
    else continue

    for (let i = 0; i < rects.length; i++) {
      let rect = rects[i]
      if (rect.top <= rowBot && rect.bottom >= rowTop) {
        rowBot = Math.max(rect.bottom, rowBot)
        rowTop = Math.min(rect.top, rowTop)
        let dx = rect.left > coords.x ? rect.left - coords.x
            : rect.right < coords.x ? coords.x - rect.right : 0
        if (dx < dxClosest) {
          closest = child
          dxClosest = dx
          coordsClosest = dx && closest.nodeType == 3 ? {
            x: rect.right < coords.x ? rect.right : rect.left,
            y: coords.y
          } : coords
          if (child.nodeType == 1 && dx)
            offset = childIndex + (coords.x >= (rect.left + rect.right) / 2 ? 1 : 0)
          continue
        }
      } else if (rect.top > coords.y && !firstBelow && rect.left <= coords.x && rect.right >= coords.x) {
        firstBelow = child
        coordsBelow = {x: Math.max(rect.left, Math.min(rect.right, coords.x)), y: rect.top}
      }
      if (!closest && (coords.x >= rect.right && coords.y >= rect.top ||
                       coords.x >= rect.left && coords.y >= rect.bottom))
        offset = childIndex + 1
    }
  }
  if (!closest && firstBelow) { closest = firstBelow; coordsClosest = coordsBelow; dxClosest = 0 }
  if (closest && closest.nodeType == 3) return findOffsetInText(closest as Text, coordsClosest!)
  if (!closest || (dxClosest && closest.nodeType == 1)) return {node, offset}
  return findOffsetInNode(closest as HTMLElement, coordsClosest!)
}

function findOffsetInText(node: Text, coords: {x: number, y: number}) {
  let len = node.nodeValue!.length
  let range = document.createRange()
  for (let i = 0; i < len; i++) {
    range.setEnd(node, i + 1)
    range.setStart(node, i)
    let rect = singleRect(range, 1)
    if (rect.top == rect.bottom) continue
    if (inRect(coords, rect))
      return {node, offset: i + (coords.x >= (rect.left + rect.right) / 2 ? 1 : 0)}
  }
  return {node, offset: 0}
}

function inRect(coords: {x: number, y: number}, rect: Rect) {
  return coords.x >= rect.left - 1 && coords.x <= rect.right + 1 &&
    coords.y >= rect.top - 1 && coords.y <= rect.bottom + 1
}

function targetKludge(dom: HTMLElement, coords: {x: number, y: number}) {
  let parent = dom.parentNode
  if (parent && /^li$/i.test(parent.nodeName) && coords.x < dom.getBoundingClientRect().left)
    return parent as HTMLElement
  return dom
}

function posFromElement(view: EditorView, elt: HTMLElement, coords: {x: number, y: number}) {
  let {node, offset} = findOffsetInNode(elt, coords), bias: -1 | 1 = -1
  if (node.nodeType == 1 && !node.firstChild) {
    let rect = (node as HTMLElement).getBoundingClientRect()
    bias = rect.left != rect.right && coords.x > (rect.left + rect.right) / 2 ? 1 : -1
  }
  return view.docElt.posFromDOM(node, offset, bias)
}

function posFromCaret(view: EditorView, node: Node, offset: number, coords: {x: number, y: number}) {
  // Browser (in caretPosition/RangeFromPoint) will agressively
  // normalize towards nearby inline nodes. Since we are interested in
  // positions between block nodes too, we first walk up the hierarchy
  // of nodes to see if there are block nodes that the coordinates
  // fall outside of. If so, we take the position before/after that
  // block. If not, we call `posFromDOM` on the raw node/offset.
  let outsideBlock = -1
  for (let cur = node, sawBlock = false;;) {
    if (cur == view.contentDOM) break
    let cView = view.docElt.nearestNodeElt(cur)
    if (!cView) return null
    if (cView.dom.nodeType == 1 && (cView.tag.isBlock() && cView.parent || !cView.contentDOM)) {
      let rect = (cView.dom as HTMLElement).getBoundingClientRect()
      if (cView.tag.isBlock() && cView.parent) {
        // Only apply the horizontal test to the innermost block. Vertical for any parent.
        if (!sawBlock && rect.left > coords.x || rect.top > coords.y) outsideBlock = cView.posBefore
        else if (!sawBlock && rect.right < coords.x || rect.bottom < coords.y) outsideBlock = cView.posAfter
        sawBlock = true
      }
      if (!cView.contentDOM && outsideBlock < 0 && !cView.tag.isText()) {
        // If we are inside a leaf, return the side of the leaf closer to the coords
        let before = cView.tag.isBlock() ? coords.y < (rect.top + rect.bottom) / 2
          : coords.x < (rect.left + rect.right) / 2
        return before ? cView.posBefore : cView.posAfter
      }
    }
    cur = cView.dom.parentNode!
  }
  return outsideBlock > -1 ? outsideBlock : view.docElt.posFromDOM(node, offset, -1)
}

function elementFromPoint(element: HTMLElement, coords: {x: number, y: number}, box: Rect): HTMLElement {
  let len = element.childNodes.length
  if (len && box.top < box.bottom) {
    for (let startI = Math.max(0, Math.min(len - 1, Math.floor(len * (coords.y - box.top) / (box.bottom - box.top)) - 2)), i = startI;;) {
      let child = element.childNodes[i]
      if (child.nodeType == 1) {
        let rects = (child as HTMLElement).getClientRects()
        for (let j = 0; j < rects.length; j++) {
          let rect = rects[j]
          if (inRect(coords, rect)) return elementFromPoint(child as HTMLElement, coords, rect)
        }
      }
      if ((i = (i + 1) % len) == startI) break
    }
  }
  return element
}

// Given an x,y position on the editor, get the position in the document.
export function posAtCoords(view: EditorView, coords: {x: number, y: number}) {
  let doc = view.dom.ownerDocument, node: Node | undefined, offset = 0
  let caret = caretFromPoint(doc, coords.x, coords.y)
  if (caret) ({node, offset} = caret)

  let elt = ((view.root as any).elementFromPoint ? view.root : doc)
              .elementFromPoint(coords.x, coords.y) as HTMLElement
  let pos
  if (!elt || !view.contentDOM.contains(elt.nodeType != 1 ? elt.parentNode : elt)) {
    let box = view.contentDOM.getBoundingClientRect()
    elt = elementFromPoint(view.contentDOM, coords, box)
  }
  // Safari's caretRangeFromPoint returns nonsense when on a draggable element
  if (browser.safari) {
    for (let p: Node | null = elt; node && p; p = p.parentNode)
      if ((p as HTMLElement).draggable) node = undefined
  }
  elt = targetKludge(elt, coords)
  if (node) {
    if (browser.gecko && node.nodeType == 1 && offset < node.childNodes.length) {
      // Firefox will move the returned position before image nodes,
      // even if those are behind it.
      let next = node.childNodes[offset], box
      if (next.nodeName == "IMG" && (box = (next as HTMLElement).getBoundingClientRect()).right <= coords.x &&
          box.bottom > coords.y)
        offset++
    }
    let prev
    // When clicking above the right side of an uneditable node, Chrome will report a cursor position after that node.
    if (browser.webkit && offset && node.nodeType == 1 && (prev = node.childNodes[offset - 1]).nodeType == 1 &&
        (prev as HTMLElement).contentEditable == "false" && (prev as HTMLElement).getBoundingClientRect().top >= coords.y)
      offset--
    // Suspiciously specific kludge to work around caret*FromPoint
    // never returning a position at the end of the document
    if (node == view.contentDOM && offset == node.childNodes.length - 1 && node.lastChild!.nodeType == 1 &&
        coords.y > (node.lastChild as HTMLElement).getBoundingClientRect().bottom)
      pos = view.state.doc.length
    // Ignore positions directly after a BR, since caret*FromPoint
    // 'round up' positions that would be more accurately placed
    // before the BR node.
    else if (offset == 0 || node.nodeType != 1 || node.childNodes[offset - 1].nodeName != "BR")
      pos = posFromCaret(view, node, offset, coords)
  }
  return pos ?? posFromElement(view, elt, coords)
}

function nonZero(rect: DOMRect) {
  return rect.top < rect.bottom || rect.left < rect.right
}

function singleRect(target: HTMLElement | Range, bias: number): DOMRect {
  let rects = target.getClientRects()
  if (rects.length) {
    let first = rects[bias < 0 ? 0 : rects.length - 1]
    if (nonZero(first)) return first
  }
  return Array.prototype.find.call(rects, nonZero) || target.getBoundingClientRect()
}

const BIDI = /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac]/

// Given a position in the document model, get a bounding box of the
// character at that position, relative to the window.
export function coordsAtPos(view: EditorView, pos: number, assoc: number): Rect {
  let cView = view.docElt.resolve(pos, assoc < 0 ? -1 : 1)
  let node = cView.elt.contentDOM || cView.elt.dom, {offset} = cView

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

  // FIXME find block/inline status from cView?
  let cx = view.state.doc.resolve(cView.elt.posAtStart)
  // Return a horizontal line in block context
  if (!cx.parent.node.inlineContent()) {
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
    // FIXME ignore widgets?
    let target = !after ? null : after.nodeType == 3 ? textRange(after as Text, 0, 0)
        : after.nodeType == 1 ? after : null
    if (target) return flattenV(singleRect(target as Range | HTMLElement, -1), true)
  }
  // All else failed, just try to get a rectangle for the target node
  return flattenV(singleRect(node.nodeType == 3 ? textRange(node as Text, 0, node.nodeValue!.length) : node as HTMLElement, -assoc), assoc >= 0)
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

export function findVerticalInTextblock(
  elt: EltNode, forward: boolean, x: number, y: number
): {pos: number, assoc: number} | null {
  let closest: Rect | null = null, closestX = -1, closestElt = null as NodeElt | null
  let scan = (elt: EltNode) => {
    if (elt instanceof NodeElt && elt.tag.isLeaf()) {
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
          closestElt = elt
        }
      }
    } else {
      for (let ch of elt.children) scan(ch)
    }
  }
  scan(elt)
  if (!closestElt) return null
  let {dom} = closestElt, pos = closestElt.posBefore
  if (closestElt.tag.isText()) {
    let {offset} = findOffsetInText((dom.nodeType == 3 ? dom : dom.firstChild) as Text, {
      x: Math.max(closest!.left, Math.min(closest!.right, x)),
      y: Math.max(closest!.top, Math.min(closest!.bottom, y))
    })
    return {pos: pos + offset, assoc: 1} // FIXME properly determine assoc
  }
  // FIXME use text direction
  if (x < (closest!.left + closest!.right) / 2) return {pos, assoc: 1}
  return {pos: pos + 1, assoc: -1}
}
