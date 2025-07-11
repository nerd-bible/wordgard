import {ChangeDesc} from "@wordgard/doc"
import browser from "./browser"
import {EditorView} from "./editorview"
import {editable} from "./extension"
import {DOMNode, hasSelection, getSelection, DOMSelectionState, SelectionRange,
        isEquivalentPosition, atElementStart} from "./dom"
import {Tile} from "./content"
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
  //  - Safari doesn't report the right selection in shadow DOM
  //  - Reading from the selection forces a DOM layout
  //  - This way, we can ignore selectionchange events if we have
  //    already seen the 'new' selection
  selectionRange: DOMSelectionState = new DOMSelectionState
  // Set when a selection change is detected, cleared on read
  selectionChanged = false

  resizeTimeout = -1
  queue: MutationRecord[] = []
  lastChange = 0

  scrollTargets: HTMLElement[] = []
  resizeScroll: ResizeObserver | null = null

  constructor(private view: EditorView) {
    this.dom = view.contentDOM
    this.observer = new MutationObserver(mutations => {
      for (let mut of mutations) this.queue.push(mut)
      this.read()
    })

    this.onSelectionChange = this.onSelectionChange.bind(this)
    this.onResize = this.onResize.bind(this)
    this.onScroll = this.onScroll.bind(this)

    if (typeof ResizeObserver == "function") {
      this.resizeScroll = new ResizeObserver(() => {
        // FIXME if (this.view.docView?.lastUpdate < Date.now() - 75) this.onResize()
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
    win.document.addEventListener("selectionchange", this.onSelectionChange)
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
      this.win.document.removeEventListener("selectionchange", this.onSelectionChange)
      this.win = null
    }
  }

  onScroll(e: Event) {
    this.view.inputState.runHandlers("scroll", e)
  }

  onResize() {
    if (this.resizeTimeout < 0) this.resizeTimeout = setTimeout(() => {
      this.resizeTimeout = -1
      this.view.requestMeasure()
    }, 50)
  }

  onSelectionChange(event: Event) {
    let wasChanged = this.selectionChanged
    if (!this.readSelectionRange()) return
    let {view} = this, sel = this.selectionRange
    if (view.state.facet(editable) ? view.root.activeElement != this.dom : !hasSelection(this.dom, sel))
      return

    let context = sel.anchorNode && view.docElt.nearest(sel.anchorNode)
    if (context && context.ignoreEvent(event)) {
      if (!wasChanged) this.selectionChanged = false
      return
    }

    this.read(false)
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
    if (local && !this.selectionChanged &&
        view.inputState.lastFocusTime > Date.now() - 200 &&
        view.inputState.lastTouchTime < Date.now() - 300 &&
        atElementStart(this.dom, range)) {
      this.view.inputState.lastFocusTime = 0
      // view.docView.updateSelection() // FIXME
      return false
    }
    this.selectionRange.setRange(range)
    if (local) this.selectionChanged = true
    return true
  }

  setSelectionRange(anchor: {dom: DOMNode, offset: number}, head: {dom: DOMNode, offset: number}) {
    this.selectionRange.set(anchor.dom, anchor.offset, head.dom, head.offset)
    this.selectionChanged = false
  }

  clearSelectionRange() {
    this.selectionRange.set(null, 0, null, 0)
  }

  ignore<T>(f: () => T): T { // FIXME just call clear directly?
    let result = f() // FIXME add mechanism to ensure no synchronous flush?
    this.clear()
    return result
  }

  // Throw away any pending changes
  clear() {
    this.takeRecords()
    this.queue.length = 0
    this.readSelectionRange()
    this.selectionChanged = false
  }

  takeRecords() {
    for (let mut of this.observer.takeRecords()) this.queue.push(mut)
    let records = this.queue
    if (records.length) this.queue = []
    return records
  }

  processRecords() {
    let change: ChangeDesc | undefined
    for (let record of this.takeRecords()) {
      let range = this.findMutation(record)
      if (range) {
        let sections = range[0] ? [range[0], -1] : [], len = this.view.state.doc.length
        sections.push(range[1] - range[0], -2)
        if (range[1] < len) sections.push(len - range[1], -1)
        let desc = new ChangeDesc(sections)
        change = change ? change.composeDesc(desc) : desc
      }
    }
    return change
  }

  findMutation(record: MutationRecord): [number, number] | null {
    let elt = this.view.docElt.nearest(record.target)
    if (!elt || elt.ignoreMutations) return null
    if (record.type == "attributes" || record.type == "characterData") {
      return [elt.posBefore, elt.posAfter]
    } else if (record.type == "childList") {
      let childBefore = findChild(elt, record.previousSibling || record.target.previousSibling, -1)
      let childAfter = findChild(elt, record.nextSibling || record.target.nextSibling, 1)
      return [childBefore ? elt.posBeforeChild(childBefore) + childBefore.length : elt.posAtStart,
              childAfter ? elt.posBeforeChild(childAfter) : elt.posAtEnd]
    } else {
      return null
    }
  }

  // Apply pending changes, if any
  read(readSelection = true) {
    if (readSelection) this.readSelectionRange()
    let changed = this.processRecords(), {view} = this
    if (changed) {
      // FIXME reuse path of regular updates, somehow
      view.docElt = view.docElt.update(this.view.state, changed)
      setDOMSelection(this.view)
      this.clear()
    } else if (this.selectionChanged && view.hasFocus && hasSelection(view.contentDOM, this.selectionRange)) {
      let sel = readDOMSelection(view, this.selectionRange)
      if (!sel.eqPos(view.state.selection))
        view.dispatch({selection: sel, userEvent: "select"})
      this.selectionChanged = false
    }
  }
}

function findChild(elt: Tile, dom: Node | null, dir: number): Tile | null {
  while (dom) {
    let cur = dom.wsElt
    if (cur && cur.parent == elt) return cur
    let parent = dom.parentNode
    dom = parent != elt.dom ? parent : dir > 0 ? dom.nextSibling : dom.previousSibling
  }
  return null
}

function buildSelectionRangeFromRange(view: EditorView, range: StaticRange) {
  let anchorNode = range.startContainer, anchorOffset = range.startOffset
  let focusNode = range.endContainer, focusOffset = range.endOffset
  let curAnchor = view.docElt.resolve(view.state.selection.anchor, -1)
  // Since such a range doesn't distinguish between anchor and head,
  // use a heuristic that flips it around if its end matches the
  // current anchor.
  if (isEquivalentPosition(curAnchor.dom, curAnchor.offset, focusNode, focusOffset))
    [anchorNode, anchorOffset, focusNode, focusOffset] = [focusNode, focusOffset, anchorNode, anchorOffset]
  return {anchorNode, anchorOffset, focusNode, focusOffset}
}
