import {ChangeDesc} from "@willows/doc"
import browser from "./browser"
import {EditorView} from "./editorview"
import {editable, ViewUpdate} from "./extension"
import {DOMNode, hasSelection, getSelection, DOMSelectionState, isEquivalentPosition, atElementStart} from "./dom"
import {ContentElt} from "./content"
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

  editContext: EditContextManager | null = null

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

    if (window.EditContext &&
        // Chrome <126 doesn't support inverted selections in edit context (#1392)
        !(browser.chrome && browser.chrome_version < 126)) {
      //this.editContext = new EditContextManager(view)
    }

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
    this.editContext?.connect(this.view)
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
    this.editContext?.disconnect(this.view)
    clearTimeout(this.resizeTimeout)
    if (this.win) {
      this.win.removeEventListener("scroll", this.onScroll)
      this.win.removeEventListener("resize", this.onResize)
      this.win.document.removeEventListener("selectionchange", this.onSelectionChange)
      this.win = null
    }
  }

  onScroll(e: Event) {
    if (this.editContext) this.view.requestMeasure(this.editContext.measureReq)
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
    let range = browser.safari && (view.root as any).nodeType == 11 &&
      view.root.activeElement == this.dom &&
      safariSelectionRangeHack(this.view, selection) || selection
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

  setSelectionRange(anchor: {node: DOMNode, offset: number}, head: {node: DOMNode, offset: number}) {
    this.selectionRange.set(anchor.node, anchor.offset, head.node, head.offset)
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
        let sections = range[0] ? [range[0], -1] : [], len = this.view.viewState.drawnState.doc.length
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
      view.docElt = view.docElt.update(this.view.state.doc, changed)
      setDOMSelection(this.view)
      this.clear()
    } else if (this.selectionChanged && view.hasFocus && hasSelection(view.contentDOM, this.selectionRange)) {
      let sel = readDOMSelection(view, this.selectionRange)
      if (!sel.main.eq(view.state.selection.main)) {
        for (let tr of view.viewState.pendingTransactions) sel = sel.map(tr.changes)
        view.dispatch({selection: sel})
      }
      this.selectionChanged = false
    }
  }

  update(update: ViewUpdate) {
    if (this.editContext) this.editContext.update(update)
  }
}

function findChild(elt: ContentElt, dom: Node | null, dir: number): ContentElt | null {
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
  let curAnchor = view.docElt.resolve(view.state.selection.main.anchor, -1)
  // Since such a range doesn't distinguish between anchor and head,
  // use a heuristic that flips it around if its end matches the
  // current anchor.
  if (isEquivalentPosition(curAnchor.node, curAnchor.offset, focusNode, focusOffset))
    [anchorNode, anchorOffset, focusNode, focusOffset] = [focusNode, focusOffset, anchorNode, anchorOffset]
  return {anchorNode, anchorOffset, focusNode, focusOffset}
}

// Used to work around a Safari Selection/shadow DOM bug (#414)
function safariSelectionRangeHack(view: EditorView, selection: Selection) {
  if ((selection as any).getComposedRanges) {
    let range = (selection as any).getComposedRanges(view.root)[0] as StaticRange
    if (range) return buildSelectionRangeFromRange(view, range)
  }

  let found = null as null | StaticRange
  // Because Safari (at least in 2018-2021) doesn't provide regular
  // access to the selection inside a shadowroot, we have to perform a
  // ridiculous hack to get at it—using `execCommand` to trigger a
  // `beforeInput` event so that we can read the target range from the
  // event.
  function read(event: InputEvent) {
    event.preventDefault()
    event.stopImmediatePropagation()
    found = (event as any).getTargetRanges()[0]
  }
  view.contentDOM.addEventListener("beforeinput", read, true)
  view.ownerDocument.execCommand("indent")
  view.contentDOM.removeEventListener("beforeinput", read, true)
  return found ? buildSelectionRangeFromRange(view, found) : null
}

// FIXME work in terms of textblocks instead of text documents
type EditContextManager = any
/*
class EditContextManager {
  editContext: EditContext
  measureReq: MeasureRequest<void>
  // The document window for which the text in the context is
  // maintained. For large documents, this may be smaller than the
  // editor document. This window always includes the selection head.
  from: number = 0
  to: number = 0
  // When applying a transaction, this is used to compare the change
  // made to the context content to the change in the transaction in
  // order to make the minimal changes to the context (since touching
  // that sometimes breaks series of multiple edits made for a single
  // user action on some Android keyboards)
  pendingContextChange: {from: number, to: number, insert: string} | null = null
  connected = false
  handlers: Record<string, (event: any) => void>

  constructor(readonly view: EditorView) {
    this.resetRange(view.state)

    this.editContext = new window.EditContext({
      text: view.state.doc.textContent(), // FIXME
      selectionStart: this.toContextPos(Math.max(this.from, Math.min(this.to, view.state.selection.main.anchor))),
      selectionEnd: this.toContextPos(view.state.selection.main.head)
    })
    this.handlers = {
      textupdate: this.onTextUpdate.bind(this, view),
      characterboundsupdate: this.onCharacterBoundsUpdate.bind(this, view),
      textformatupdate: this.onTextFormatUpdate.bind(this, view),
      compositionstart: this.onCompositionStart.bind(this, view),
      compositionend: this.onCompositionEnd.bind(this, view)
    }

    this.measureReq = {read: view => {
      this.editContext.updateControlBounds(view.contentDOM.getBoundingClientRect())
      let sel = getSelection(view.root)
      if (sel && sel.rangeCount)
        this.editContext.updateSelectionBounds(sel.getRangeAt(0).getBoundingClientRect())
    }}
  }

  connect(view: EditorView) {
    this.connected = true
    if (view.state.facet(editable)) view.contentDOM.editContext = this.editContext
    for (let event of Object.keys(this.handlers))
      this.editContext.addEventListener(event as any, this.handlers[event])
  }

  disconnect(view: EditorView) {
    this.connected = false
    view.contentDOM.editContext = null
    for (let event of Object.keys(this.handlers))
      this.editContext.removeEventListener(event as any, this.handlers[event])
  }

  onTextUpdate(view: EditorView, e: TextUpdateEvent) {
    let {anchor} = view.state.selection.main
    let change = {from: this.toEditorPos(e.updateRangeStart),
                  to: this.toEditorPos(e.updateRangeEnd),
                  insert: e.text}
    // If the window doesn't include the anchor, assume changes
    // adjacent to a side go up to the anchor.
    if (change.from == this.from && anchor < this.from) change.from = anchor
    else if (change.to == this.to && anchor > this.to) change.to = anchor

    // Edit contexts sometimes fire empty changes
    if (change.from == change.to && !change.insert.length) return

    this.pendingContextChange = change
    if (!view.state.readOnly)
      applyTextChange(view, change.from, change.to, new Slice([Node.text(change.insert)]))
    // If the transaction didn't flush our change, revert it so
    // that the context is in sync with the editor state again.
    if (this.pendingContextChange) {
      this.revertPending(view.state)
      this.setSelection(view.state)
    }
  }

  onCharacterBoundsUpdate(view: EditorView, e: CharacterBoundsUpdateEvent) {
    let rects: DOMRect[] = [], prev: DOMRect | null = null
    for (let i = this.toEditorPos(e.rangeStart), end = this.toEditorPos(e.rangeEnd); i < end; i++) {
      let rect = view.coordsForChar(i)
      prev = (rect && new DOMRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top))
        || prev || new DOMRect
      rects.push(prev)
    }
    this.editContext.updateCharacterBounds(e.rangeStart, rects)
  }

  onTextFormatUpdate(view: EditorView, e: TextFormatUpdateEvent) {
    for (let format of e.getTextFormats()) {
      let lineStyle = format.underlineStyle, thickness = format.underlineThickness
      if (lineStyle != "None" && thickness != "None") {
        let style = `text-decoration: underline ${
          lineStyle == "Dashed" ? "dashed " : lineStyle == "Squiggle" ? "wavy " : ""
        }${thickness == "Thin" ? 1 : 2}px`
        console.log("mark", {attributes: {style}}, "for",
                    this.toEditorPos(format.rangeStart), this.toEditorPos(format.rangeEnd))
      }
    }
    // FIXME actually add decorations
  }

  onCompositionStart(view: EditorView) {
    if (view.inputState.composing < 0) {
      view.inputState.composing = 0
      view.inputState.compositionFirstChange = true
    }
  }
  
  onCompositionEnd(view: EditorView) {
    view.inputState.composing = -1
    view.inputState.compositionFirstChange = null
  }

  applyEdits(update: ViewUpdate) {
    let off = 0, abort = false, pending = this.pendingContextChange
    update.changes.iterChanges((fromA, toA, _fromB, _toB, insert) => {
      if (abort) return

      let dLen = insert.length - (toA - fromA)
      if (pending && toA >= pending.to) {
        if (pending.from == fromA && pending.to == toA && pending.insert == insert) {
          pending = this.pendingContextChange = null // Match
          off += dLen
          this.to += dLen
          return
        } else { // Mismatch, revert
          pending = null
          this.revertPending(update.state)
        }
      }

      fromA += off; toA += off
      if (toA <= this.from) { // Before the window
        this.from += dLen; this.to += dLen
      } else if (fromA < this.to) { // Overlaps with window
        if (fromA < this.from || toA > this.to || (this.to - this.from) + insert.length > CxVp.MaxSize) {
          abort = true
          return
        } 
        this.editContext.updateText(this.toContextPos(fromA), this.toContextPos(toA), insert.toString())
        this.to += dLen
      }
      off += dLen
    })
    if (pending && !abort) this.revertPending(update.state)
    return !abort
  }

  update(update: ViewUpdate) {
    let reverted = this.pendingContextChange
    if (!this.applyEdits(update) || !this.rangeIsValid(update.state)) {
      this.pendingContextChange = null
      this.resetRange(update.state)
      this.editContext.updateText(0, this.editContext.text.length, update.state.doc.sliceString(this.from, this.to))
      this.setSelection(update.state)
    } else if (update.docChanged || update.selectionSet || reverted) {
      this.setSelection(update.state)
    }
    if (update.geometryChanged || update.docChanged || update.selectionSet)
      update.view.requestMeasure(this.measureReq)
    if (this.connected && update.startState.facet(editable) != update.state.facet(editable))
      update.view.contentDOM.editContext = update.state.facet(editable) ? this.editContext : null
  }

  resetRange(state: EditorState) {
    let {head} = state.selection.main
    this.from = Math.max(0, head - CxVp.Margin)
    this.to = Math.min(state.doc.length, head + CxVp.Margin)
  }

  revertPending(state: EditorState) {
    let pending = this.pendingContextChange!
    this.pendingContextChange = null
    this.editContext.updateText(this.toContextPos(pending.from),
                                this.toContextPos(pending.from + pending.insert.length),
                                state.doc.sliceString(pending.from, pending.to))
  }

  setSelection(state: EditorState) {
    let {main} = state.selection
    let start = this.toContextPos(Math.max(this.from, Math.min(this.to, main.anchor)))
    let end = this.toContextPos(main.head)
    if (this.editContext.selectionStart != start || this.editContext.selectionEnd != end)
      this.editContext.updateSelection(start, end)
  }

  rangeIsValid(state: EditorState) {
    let {head} = state.selection.main
    return !(this.from > 0 && head - this.from < CxVp.MinMargin ||
             this.to < state.doc.length && this.to - head < CxVp.MinMargin ||
             this.to - this.from > CxVp.Margin * 3)
  }

  toEditorPos(contextPos: number) { return contextPos + this.from }
  toContextPos(editorPos: number) { return editorPos - this.from }
}
*/
