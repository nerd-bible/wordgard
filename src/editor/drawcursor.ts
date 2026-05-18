import {GardState} from "wordgard/state"
import {Wordgard, basePlugins} from "./editor"

type CursorPos = {left: number, top: number, size: number, horiz: boolean} | null

export const cursorLayer = Wordgard.Plugin.fromClass(class {
  readonly layer: HTMLElement
  pos: CursorPos = null

  constructor(wg: Wordgard) {
    this.layer = wg.scrollDOM.appendChild(document.createElement("wg-cursor-layer"))
    this.positionCursor = this.positionCursor.bind(this)
    wg.scheduleDOMRead(this.positionCursor)
    setBlinkRate(wg.state, this.layer)
  }

  update(update: Wordgard.Update) {
    if (update.transactions.some(tr => tr.selection))
      this.layer.style.animationName = this.layer.style.animationName == "wg-blink" ? "wg-blink2" : "wg-blink"
    if (update.state.facet(Wordgard.cursorBlinkRate) != update.startState.facet(Wordgard.cursorBlinkRate))
      setBlinkRate(update.state, this.layer)
    if ((update.docChanged || update.selectionSet || update.geometryChanged) &&
        (update.startState.selection.isCursor || update.state.selection.isCursor))
      update.editor.scheduleDOMRead(this.positionCursor)
  }

  docUpdate(wg: Wordgard) {
    wg.scheduleDOMRead(this.positionCursor)
  }    

  destroy() {
    this.layer.remove()
  }

  positionCursor(wg: Wordgard) {
    let pos = cursorPos(wg), cur = this.pos
    if (!pos ? cur : !cur || cur.left != pos.left || cur.top != pos.top || cur.size != pos.size) {
      this.pos = pos
      wg.scheduleDOMWrite(() => {
        let cursor = this.layer.firstChild as HTMLElement | null
        if (!pos) {
          if (cursor) cursor.remove()
        } else {
          if (!cursor)
            cursor = this.layer.appendChild(document.createElement("wg-cursor"))
          cursor.className = "wg-cursor-" + (pos.horiz ? "h" : "v")
          cursor.style.top = pos.top + "px"
          cursor.style.left = pos.left + "px"
          cursor.style.width = pos.horiz ? pos.size + "px" : ""
          cursor.style.height = pos.horiz ? "" : pos.size + "px"
        }
      })
    }
  }
})

// FIXME awkward
basePlugins[basePlugins.length] = cursorLayer

const VertWidth = 30, VertGap = 5

export function cursorPos(wg: Wordgard): CursorPos {
  let {state} = wg
  if (!state.selection.isCursor) return null
  let {head, headSide} = state.selection
  let {left, right, top, bottom} = wg.coordsAtPos(head, headSide)
  let horiz = top == bottom, size = horiz ? right - left : bottom - top
  if (horiz && size > VertWidth) {
    size = VertWidth
    if (!wg.state.textLTR) left = right - size
    let other = wg.coordsAtPos(head, headSide > 0 ? -1 : 1)
    if (other.top == other.bottom && other.top != top) {
      let move = Math.min(VertGap, Math.abs(other.top - top) / 2)
      top = bottom = top + move * (other.top < top ? -1 : 1)
    }
  }
  let doc = wg.contentDOM.getBoundingClientRect()
  return {left: left - doc.left, top: top - doc.top, size, horiz}
}

function setBlinkRate(state: GardState, dom: HTMLElement) {
  dom.style.animationDuration = state.facet(Wordgard.cursorBlinkRate) + "ms"
}
