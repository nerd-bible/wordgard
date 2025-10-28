import {ChangeDesc} from "@wordgard/doc"
import browser from "./browser"
import {EditorView} from "./editorview"
import {DOMNode, hasSelection, getSelection, DOMSelectionState, SelectionRange,
        isEquivalentPosition, atElementStart} from "./dom"
import {Tile} from "./tile"
import {setDOMSelection, readDOMSelection} from "./selection"

const observeOptions = {
  childList: true,
  characterData: true,
  subtree: true,
  attributes: true,
  characterDataOldValue: true
}

export class DOMObserver {
  dom: HTMLElement
  win: Window | null = null

  observer: MutationObserver
  active: boolean = false

  // The known selection. Kept in our own object, as opposed to just
  // directly accessing the selection because:
  //  - Safari doesn't provide getSelection in shadow DOM
  //  - Reading from the selection forces a DOM layout
  //  - By tracking this, we can ignore selectionchange events if we
  //    have already seen the 'new' selection
  selectionRange: DOMSelectionState = new DOMSelectionState

  resizeTimeout = -1
  queue: MutationRecord[] = []

  // Ranges (refering to positions in the flushed document) that need
  // to be re-checked because their DOM changed, if any are known.
  dirty: ChangeDesc | null = null

  scrollTargets: HTMLElement[] = []
  resizeScroll: ResizeObserver | null = null

  constructor(private view: EditorView) {
    this.dom = view.contentDOM
    this.observer = new MutationObserver(mutations => {
      for (let mut of mutations) this.queue.push(mut)
      this.view.scheduleFlush()
    })

    this.pollSelection = this.pollSelection.bind(this)
    this.onResize = this.onResize.bind(this)
    this.onScroll = this.onScroll.bind(this)

    if (typeof ResizeObserver == "function") {
      this.resizeScroll = new ResizeObserver(() => {
        if (this.view.lastFlush < Date.now() - 75) this.onResize()
      })
    }
    this.readSelectionRange()
  }

  connect() {
    this.observer.observe(this.dom, observeOptions)
    this.resizeScroll?.observe(this.dom)
    for (let dom = this.dom as any; dom;) {
      if (dom.nodeType == 1) {
        this.scrollTargets.push(dom)
        dom.addEventListener("scroll", this.onScroll)
        dom = dom.assignedSlot || dom.parentNode
      } else if (dom.nodeType == 11) { // Shadow root
        dom = dom.host
      } else {
        break
      }
    }
    let win = this.win = this.view.win
    win.addEventListener("resize", this.onResize)
    win.addEventListener("scroll", this.onScroll)
    win.document.addEventListener("selectionchange", this.pollSelection)
  }

  disconnect() {
    this.observer.disconnect()
    this.resizeScroll?.disconnect()
    for (let dom of this.scrollTargets) dom.removeEventListener("scroll", this.onScroll)
    this.scrollTargets = []
    clearTimeout(this.resizeTimeout)
    if (this.win) {
      this.win.removeEventListener("scroll", this.onScroll)
      this.win.removeEventListener("resize", this.onResize)
      this.win.document.removeEventListener("selectionchange", this.pollSelection)
      this.win = null
    }
  }

  onScroll(e: Event) {
    this.view.inputState.runHandlers("scroll", e)
  }

  onResize() {
    if (this.resizeTimeout < 0) this.resizeTimeout = setTimeout(() => {
      this.resizeTimeout = -1
      this.view.scheduleFlush()
    }, 50)
  }

  pollSelection() {
    if (!this.view.inputState.currentComposition && this.readSelectionRange() &&
        this.view.hasFocus && hasSelection(this.view.contentDOM, this.selectionRange)) {
      let sel = readDOMSelection(this.view, this.selectionRange)
      if (!sel.eqPos(this.view.state.selection))
        this.view.dispatch({selection: sel, userEvent: "select"})
    }
  }

  readSelectionRange() {
    let {view} = this
    // The Selection object is broken in shadow roots in Safari. See
    // https://github.com/codemirror/dev/issues/414
    let selection = getSelection(view.root)
    if (!selection) return false
    let range: SelectionRange = selection
    if (browser.safari && (view.root as any).nodeType == 11 && view.root.activeElement == this.dom) {
      // Used to work around a Safari Selection/shadow DOM bug (#414)
      let selRange = (selection as any).getComposedRanges(view.root)[0] as StaticRange
      if (selRange) range = buildSelectionRangeFromRange(view, selRange)
    }
    if (!range || this.selectionRange.eq(range)) return false
    let local = hasSelection(this.dom, range)
    // Detect the situation where the browser has, on focus, moved the
    // selection to the start of the content element. Reset it to the
    // position from the editor state.
    if (local &&
        view.inputState.lastFocusTime > Date.now() - 200 &&
        view.inputState.lastTouchTime < Date.now() - 300 &&
        atElementStart(this.dom, range)) {
      this.view.inputState.lastFocusTime = 0
      setDOMSelection(view)
      return false
    }
    this.selectionRange.setRange(range)
    return true
  }

  setSelectionRange(anchor: {dom: DOMNode, offset: number}, head: {dom: DOMNode, offset: number}) {
    this.selectionRange.set(anchor.dom, anchor.offset, head.dom, head.offset)
  }

  clearSelectionRange() {
    this.selectionRange.set(null, 0, null, 0)
  }

  ignore<T>(f: () => T): T {
    let result = f()
    this.clear()
    return result
  }

  // Throw away any pending changes
  clear() {
    this.takeRecords()
    this.readSelectionRange()
  }

  takeRecords() {
    for (let mut of this.observer.takeRecords()) this.queue.push(mut)
    let records = this.queue
    if (records.length) this.queue = []
    return records
  }

  addDirtyRange(from: number, to: number) {
    let sections = from ? [from, -1] : [], len = this.view.flushedState.doc.length
    sections.push(to - from, -2)
    if (to < len) sections.push(len - to, -1)
    let desc = new ChangeDesc(sections)
    this.dirty = this.dirty ? this.dirty.composeDesc(desc) : desc
  }

  processRecords(records: readonly MutationRecord[]) {
    for (let record of records) {
      let range = this.findMutation(record)
      if (range) this.addDirtyRange(range[0], range[1])
    }
  }

  findMutation(record: MutationRecord): [number, number] | null {
    let tile = this.view.docTile.nearest(record.target)
    if (!tile || tile.ignoreMutations) return null
    if (record.type == "attributes" || record.type == "characterData") {
      if (tile.dom == record.target) {
        return [tile.posBefore, tile.posAfter]
      } else {
        return childRange(tile, record)
      }
    } else if (record.type == "childList") {
      return childRange(tile, record)
    } else {
      return null
    }
  }

  takeDirty() {
    this.processRecords(this.takeRecords())
    let {dirty} = this
    this.dirty = null
    return dirty
  }
}

function childRange(tile: Tile, record: MutationRecord): [number, number] {
  let childBefore = findChild(tile, record.previousSibling || record.target.previousSibling, -1)
  let childAfter = findChild(tile, record.nextSibling || record.target.nextSibling, 1)
  return [childBefore ? tile.posBeforeChild(childBefore) + childBefore.length : tile.posAtStart,
          childAfter ? tile.posBeforeChild(childAfter) : tile.posAtEnd]
}


function findChild(elt: Tile, dom: Node | null, dir: number): Tile | null {
  while (dom) {
    let cur = Tile.get(dom)
    if (cur && cur.parent == elt) return cur
    let parent = dom.parentNode
    dom = parent != elt.dom ? parent : dir > 0 ? dom.nextSibling : dom.previousSibling
  }
  return null
}

function buildSelectionRangeFromRange(view: EditorView, range: StaticRange) {
  let anchorNode = range.startContainer, anchorOffset = range.startOffset
  let focusNode = range.endContainer, focusOffset = range.endOffset
  let curAnchor = view.docTile.resolve(view.state.selection.anchor, -1)
  // Since such a range doesn't distinguish between anchor and head,
  // use a heuristic that flips it around if its end matches the
  // current anchor.
  if (isEquivalentPosition(curAnchor.dom, curAnchor.offset, focusNode, focusOffset))
    [anchorNode, anchorOffset, focusNode, focusOffset] = [focusNode, focusOffset, anchorNode, anchorOffset]
  return {anchorNode, anchorOffset, focusNode, focusOffset}
}
