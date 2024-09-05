import {EditorState, EditorSelection, Transaction} from "@willows/state"
import {getScale} from "./dom"
import {HeightMap, HeightOracle, BlockInfo, MeasuredHeights, QueryType, heightRelevantDecoChanges,
        clearHeightChangeFlag, heightChangeFlag} from "./heightmap"
import {UpdateFlag, ScrollTarget, scrollIntoView} from "./extension"
import {WidgetType, Decoration, DecorationSet} from "./decoration"
import {EditorView} from "./editorview"
import {Direction} from "./bidi"

export class ViewState {
  contentDOMWidth = 0 // contentDOM.getBoundingClientRect().width
  contentDOMHeight = 0 // contentDOM.getBoundingClientRect().height
  editorHeight = 0 // scrollDOM.clientHeight
  editorWidth = 0 // scrollDOM.clientWidth
  scrollTop = 0 // Last seen scrollDOM.scrollTop
  // The CSS-transformation scale of the editor (transformed size /
  // concrete size)
  scaleX = 1
  scaleY = 1

  // Tracks the last state has has been drawn
  drawnState: EditorState
  // Transactions for which the DOM has not been updated yet
  pendingTransactions: Transaction[] = []
  // A scroll target that hasn't been scrolled to yet
  scrollTarget: ScrollTarget | null = null

  defaultTextDirection: Direction = Direction.LTR

  constructor(public state: EditorState) {
    this.drawnState = state
  }

  takePendingTransactions() {
    let result = this.pendingTransactions
    this.pendingTransactions = []
    this.drawnState = this.state
    return result
  }

  update(transactions: readonly Transaction[]) {
    for (let tr of transactions) {
      if (this.scrollTarget) this.scrollTarget = this.scrollTarget.map(tr.changes)
      if (tr.scrollIntoView) {
        let {main} = tr.state.selection
        this.scrollTarget = new ScrollTarget(
          main.empty ? main : EditorSelection.cursor(main.head, main.head > main.anchor ? -1 : 1))
      }
      for (let e of tr.effects)
        if (e.is(scrollIntoView)) this.scrollTarget = e.value.clip(this.state)
      this.pendingTransactions.push(tr)
      if (tr.startState != this.state)
        throw new Error("Mismatched transaction")
      this.state = tr.state
    }
  }

  measure(view: EditorView) {
    let dom = view.contentDOM, style = window.getComputedStyle(dom)
    this.defaultTextDirection = style.direction == "rtl" ? Direction.RTL : Direction.LTR

    let domRect = dom.getBoundingClientRect()
    this.contentDOMHeight = domRect.height
    let result = 0

    if (domRect.width && domRect.height) {
      let {scaleX, scaleY} = getScale(dom, domRect)
      if (scaleX > .005 && Math.abs(this.scaleX - scaleX) > .005 ||
          scaleY > .005 && Math.abs(this.scaleY - scaleY) > .005) {
        this.scaleX = scaleX; this.scaleY = scaleY
        result |= UpdateFlag.Geometry
      }
    }

    // Vertical padding
    if (this.editorWidth != view.scrollDOM.clientWidth) {
      this.editorWidth = view.scrollDOM.clientWidth
      result |= UpdateFlag.Geometry
    }
    let scrollTop = view.scrollDOM.scrollTop * this.scaleY
    if (this.scrollTop != scrollTop) this.scrollTop = scrollTop

    let contentWidth = domRect.width
    if (this.contentDOMWidth != contentWidth || this.editorHeight != view.scrollDOM.clientHeight) {
      this.contentDOMWidth = domRect.width
      this.editorHeight = view.scrollDOM.clientHeight
      result |= UpdateFlag.Geometry
    }
    return result
  }
}
