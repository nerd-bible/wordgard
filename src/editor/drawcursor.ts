import {Mark} from "wordgard/doc"
import {GardState} from "wordgard/state"
import type {Wordgard} from "./editor"
import {TextTile} from "./tile"
import {coordsAtPos} from "./coords"
import {singleRect} from "./dom"
// FIXME this is a bit sloppy
import {renderMarks} from "./decoration"

export const cursorBlinkRate = GardState.Facet.define<number, number>({
  combine: inputs => inputs.length ? Math.min(...inputs) : 1200
})

type CursorInfo = {left: number, top: number, size: number, horiz: boolean, style: CursorStyle | null} | null

class CursorStyle {
  constructor(
    readonly height: number,
    readonly align: string,
    readonly color: string,
    readonly bold: boolean,
    readonly italic: boolean
  ) {}

  static read(node: Element | Text, height: number) {
    let win = node.ownerDocument.defaultView || window
    let style = win.getComputedStyle((node.nodeType == 1 ? node : node.parentNode) as Element)
    return new CursorStyle(height, style.verticalAlign, style.color, +style.fontWeight > 400, style.fontStyle == "italic")
  }

  eq(other: CursorStyle | null) {
    return other && this.height == other.height && this.align == other.align &&
      this.color == other.color && this.bold == other.bold && this.italic == other.italic
  }
}

export class CursorLayer {
  readonly layer: HTMLElement
  info: CursorInfo = null
  cachedStyle: CursorStyle | null = null
  cachedFor: Mark.Set | null = null

  constructor(wg: Wordgard) {
    this.layer = wg.scrollDOM.appendChild(document.createElement("wg-cursor-layer"))
    this.positionCursor = this.positionCursor.bind(this)
    wg.scheduleDOMRead(this.positionCursor)
    setBlinkRate(wg.state, this.layer)
  }

  update(update: Wordgard.Update) {
    if (update.transactions.some(tr => tr.selection))
      this.layer.style.animationName = this.layer.style.animationName == "wg-blink" ? "wg-blink2" : "wg-blink"
    if (update.state.facet(cursorBlinkRate) != update.startState.facet(cursorBlinkRate))
      setBlinkRate(update.state, this.layer)
    if ((update.docChanged || update.selectionSet || update.geometryChanged) &&
        (update.startState.selection.isCursor || update.state.selection.isCursor))
      update.editor.scheduleDOMRead(this.positionCursor)
  }

  docUpdate(wg: Wordgard) {
    wg.scheduleDOMRead(this.positionCursor)
  }    

  remove() {
    this.layer.remove()
  }

  positionCursor(wg: Wordgard) {
    getCursorInfo(wg, this, info => {
      let cur = this.info
      if (!info ? cur : !cur || cur.left != info.left || cur.top != info.top || cur.size != info.size ||
          (cur.style ? !cur.style.eq(info.style) : info.style)) {
        this.info = info
        wg.scheduleDOMWrite(() => {
          let cursor = this.layer.firstChild as HTMLElement | null
          if (!info) {
            if (cursor) cursor.remove()
          } else {
            if (!cursor)
              cursor = this.layer.appendChild(document.createElement("wg-cursor"))
            cursor.className = "wg-cursor-" + (info.horiz ? "h" : "v")
            cursor.style.top = info.top + "px"
            cursor.style.left = info.left + "px"
            cursor.style.width = info.horiz ? info.size + "px" : ""
            cursor.style.height = info.horiz ? "" : info.size + "px"
            // FIXME ensure contrast
            cursor.style.borderLeftColor = info.style ? info.style.color : "currentColor"
            cursor.classList.toggle("wg-cursor-bold", info.style?.bold ?? false)
            cursor.classList.toggle("wg-cursor-italic", info.style?.italic ?? false)
          }
        })
      }
    })
  }
}

const VertWidth = 30, VertGap = 5

function getCursorInfo(wg: Wordgard, plugin: CursorLayer, cont: (info: CursorInfo) => void) {
  let {state} = wg
  if (!state.selection.isCursor) return null
  let {head, headSide} = state.selection, {sel} = wg.state
  let {ref, rect} = coordsAtPos(wg, head, headSide)
  let doc = wg.contentDOM.getBoundingClientRect()

  // Block context, horizontal cursor
  if (!sel.head.parent.node.inlineContent) {
    let width = Math.max(VertWidth, rect.width), top = rect.top
    let other = wg.coordsAtPos(head, headSide > 0 ? -1 : 1)
    if (other.top == other.bottom && other.top != top) {
      let move = Math.min(VertGap, Math.abs(other.top - top) / 2)
      top = top + move * (other.top < top ? -1 : 1)
    }
    return cont({
      left: (wg.state.textLTR ? rect.left : rect.right - width) - doc.left,
      top: top - doc.top,
      size: width,
      horiz: true, style: null
    })
  }

  let finish = (style: CursorStyle) => {
    plugin.cachedStyle = style
    plugin.cachedFor = marks
    // FIXME vertical alignment
    cont({
      left: rect.left - doc.left,
      top: rect.top - doc.top,
      size: style.height,
      horiz: false, style
    })
  }

  let marks = sel.activeMarks
  if (ref instanceof TextTile) {
    let node = ref.posBefore < head ? state.sel.head.nodeBefore : state.sel.head.nodeAfter
    // Ref is text with matching style, use directly
    if (node && node.isText && Mark.sameSet(node.marks, marks))
      return finish(CursorStyle.read(ref.dom, rect.height))
  }

  // Check cache
  if (plugin.cachedFor && Mark.sameSet(plugin.cachedFor, marks))
    return finish(plugin.cachedStyle!)

  // See if a sibling node has the same set of marks, read style from that
  let pos = sel.head.parent.start
  for (let sibling of sel.head.parent.node.content) {
    if (sibling.isText && Mark.sameSet(sibling.marks, marks)) {
      let tile = wg.docTile.resolve(pos, 1)
      if (tile instanceof TextTile)
        return finish(CursorStyle.read(tile.dom, singleRect(tile.dom, -1, true).height))
    }
    pos += sibling.length
  }

  // Create a temporary node to measure
  let target = sel.head.parent.node.isDoc ? wg.contentDOM : wg.nodeDOM(sel.head.parent.before)!
  wg.scheduleDOMWrite(() => {
    let temp = renderMarks(marks, "M")
    ;(temp as HTMLElement).style.position = "absolute"
    wg.observer.ignore(() => target.insertBefore(temp, target.firstChild))
    wg.scheduleDOMRead(() => {
      wg.scheduleDOMWrite(() => wg.observer.ignore(() => temp.remove()))
      let inner = temp as Element | Text
      while (inner.firstChild) inner = inner.firstChild as Element | Text
      finish(CursorStyle.read(inner, singleRect(inner, -1, true).height))
    })
  })
}

function setBlinkRate(state: GardState, dom: HTMLElement) {
  dom.style.animationDuration = state.facet(cursorBlinkRate) + "ms"
}
