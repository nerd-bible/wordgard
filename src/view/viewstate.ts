import {ChangeSet} from "wordgard/doc"
import {GardState, GardSelection, Transaction} from "wordgard/state"
import {getScale, ScrollStrategy} from "./dom"
import {UpdateFlag} from "./editorview"
import {Wordgard} from "./editorview"

export const scrollIntoView = Transaction.Effect.define<ScrollTarget>({map: (t, ch) => t.map(ch)})

export class ScrollTarget {
  constructor(
    readonly range: GardSelection,
    readonly y: ScrollStrategy = "nearest",
    readonly x: ScrollStrategy = "nearest",
    readonly yMargin: number = 5,
    readonly xMargin: number = 5,
  ) {}

  map(changes: ChangeSet) {
    return changes.empty ? this :
      new ScrollTarget(this.range.map(changes), this.y, this.x, this.yMargin, this.xMargin)
  }

  clip(state: GardState) {
    return this.range.to <= state.doc.length ? this :
      new ScrollTarget(GardSelection.cursor(state.doc.length), this.y, this.x, this.yMargin, this.xMargin)
  }
}

export enum Direction { LTR, RTL }

export class ViewState {
  initialized = false
  contentDOMWidth = 0 // contentDOM.getBoundingClientRect().width
  contentDOMHeight = 0 // contentDOM.getBoundingClientRect().height
  editorHeight = 0 // scrollDOM.clientHeight
  editorWidth = 0 // scrollDOM.clientWidth
  scrollTop = 0 // Last seen scrollDOM.scrollTop
  // The CSS-transformation scale of the editor (transformed size /
  // concrete size)
  scaleX = 1
  scaleY = 1
  // A scroll target that hasn't been scrolled to yet
  scrollTarget: ScrollTarget | null = null

  // FIXME propagate this to state somehow
  defaultTextDirection: Direction = Direction.LTR

  flushedState: GardState
  pending: Transaction[] = []

  constructor(public state: GardState) {
    this.flushedState = state
  }

  update(tr: Transaction) {
    if (this.scrollTarget) this.scrollTarget = this.scrollTarget.map(tr.changes)
    if (tr.scrollIntoView) {
      let {selection} = tr.state
      this.scrollTarget = new ScrollTarget(
        selection.empty ? selection : GardSelection.cursor(selection.head, selection.head > selection.anchor ? -1 : 1))
    }
    for (let e of tr.effects)
      if (e.is(scrollIntoView)) this.scrollTarget = e.value.clip(this.state)
    if (tr.startState != this.state) throw new Error("Mismatched transaction")
    this.pending = this.pending.concat(tr)
    this.state = tr.state
  }

  flush() {
    this.flushedState = this.state
    this.pending = []
  }

  measure(view: Wordgard) {
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

  initialMeasure(view: Wordgard) {
    this.initialized = true
    let domRect = view.contentDOM.getBoundingClientRect()
    this.contentDOMWidth = domRect.width
    this.contentDOMHeight = domRect.height
    this.editorHeight = view.scrollDOM.clientHeight
    this.editorWidth = view.scrollDOM.clientWidth
    this.scrollTop = view.scrollDOM.scrollTop
  }
}
