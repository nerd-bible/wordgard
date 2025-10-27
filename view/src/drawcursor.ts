import {Facet, EditorState, Direction} from "@wordgard/state"
import {ViewPlugin, ViewUpdate, basePlugins} from "./extension"
import {type EditorView} from "./editorview"

export const cursorBlinkRate = Facet.define<number, number>({
  combine: inputs => inputs.length ? Math.min(...inputs) : 1200
})

type CursorPos = {left: number, top: number, size: number, horiz: boolean} | null

export const cursorLayer = ViewPlugin.fromClass(class {
  readonly layer: HTMLElement
  pos: CursorPos = null

  constructor(view: EditorView) {
    this.layer = view.scrollDOM.appendChild(document.createElement("div"))
    this.layer.className = "wg-cursorLayer"
    this.positionCursor = this.positionCursor.bind(this)
    view.requestDOMRead(this.positionCursor)
    setBlinkRate(view.state, this.layer)
  }

  update(update: ViewUpdate) {
    if (update.transactions.some(tr => tr.selection))
      this.layer.style.animationName = this.layer.style.animationName == "wg-blink" ? "wg-blink2" : "wg-blink"
    if (update.state.facet(cursorBlinkRate) != update.startState.facet(cursorBlinkRate))
      setBlinkRate(update.state, this.layer)
    if (update.docChanged || update.selectionSet) update.view.requestDOMRead(this.positionCursor)
  }

  docViewUpdate(view: EditorView) {
    view.requestDOMRead(this.positionCursor)
  }    

  destroy() {
    this.layer.remove()
  }

  positionCursor(view: EditorView) {
    let pos = cursorPos(view), cur = this.pos
    if (!pos ? cur : !cur || cur.left != pos.left || cur.top != pos.top || cur.size != pos.size) {
      this.pos = pos
      view.requestDOMWrite(() => {
        let cursor = this.layer.firstChild as HTMLElement | null
        if (!pos) {
          if (cursor) cursor.remove()
        } else {
          if (!cursor)
            cursor = this.layer.appendChild(document.createElement("div"))
          cursor.className = "wg-cursor wg-cursor-" + (pos.horiz ? "h" : "v")
          cursor.style.top = pos.top + "px"
          cursor.style.left = pos.left + "px"
          cursor.style.width = pos.horiz ? pos.size + "px" : ""
          cursor.style.height = pos.horiz ? "" : pos.size + "px"
        }
      })
    }
  }
})

basePlugins[basePlugins.length] = cursorLayer

const VertWidth = 30, VertGap = 5

export function cursorPos(view: EditorView): CursorPos {
  let {state} = view, {empty, head, assoc} = state.selection
  if (!empty) return null
  let {left, right, top, bottom} = view.coordsAtPos(head, assoc || -1)
  let horiz = top == bottom, size = horiz ? right - left : bottom - top
  if (horiz && size > VertWidth) {
    size = VertWidth
    if (view.state.textDirection() == Direction.RTL) left = right - size
    let other = view.coordsAtPos(head, assoc > 0 ? -1 : 1)
    if (other.top == other.bottom && other.top != top) {
      let move = Math.min(VertGap, Math.abs(other.top - top) / 2)
      top = bottom = top + move * (other.top < top ? -1 : 1)
    }
  }
  let doc = view.contentDOM.getBoundingClientRect()
  return {left: left - doc.left, top: top - doc.top, size, horiz}
}

function setBlinkRate(state: EditorState, dom: HTMLElement) {
  dom.style.animationDuration = state.facet(cursorBlinkRate) + "ms"
}
