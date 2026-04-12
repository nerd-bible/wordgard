import {GardSelection, GardState, Transaction, Facet} from "wordgard/state"
import {ChangeSet, Mark} from "wordgard/doc"
import {Command, undo, redo, insertLineBreak, enter, insertText,
        deleteWord, deleteUnit, deleteToLineEnd, deleteLine, toggleMarkByLabel,
        transposeChars, deleteSelection} from "wordgard/command"
import {Wordgard, PluginInstance} from "./editorview"
import browser from "./browser"
import {getSelection, scrollableParents, DOMNode, textNodeBefore, textNodeAfter} from "./dom"
import {readClipboard, writeClipboard} from "./clipboard"
import {eqArray, logException} from "./util"
import {Tile, CoordPos} from "./tile"

export class InputState {
  shiftKey = false
  lastKeyCode: number = 0
  lastKeyTime: number = 0
  lastTouchTime = 0
  lastScrollTop = 0
  lastScrollLeft = 0

  /// When enabled (>-1), tab presses are not given to key handlers,
  /// leaving the browser's default behavior. If >0, the mode expires
  /// at that timestamp, and any other keypress clears it.
  /// Esc enables temporary tab focus mode for two seconds when not
  /// otherwise handled.
  tabFocusMode: number = -1

  lastSelectionOrigin: string | null = null
  lastSelectionTime: number = 0
  lastContextMenu: number = 0
  scrollHandlers: ((event: Event) => boolean | void)[] = []

  handlers: {[event: string]: {
    observers: readonly HandlerFunction[],
    handlers: readonly HandlerFunction[]
  }} = Object.create(null)

  // Track the current composition. Count changes to determine whether
  // a given change is the first one, and track the text node that
  // composition is happening in.
  composing: null | {changes: number, target: Text | null} = null
  // End time of the previous composition
  compositionEndedAt = 0
  // Used in a kludge to detect when an Enter keypress should be
  // considered part of the composition on Safari, which fires events
  // in the wrong order
  compositionPendingKey = false
  // Used to smuggle information from beforeinput to input
  currentComposition: {from: number, to: number, text: string} | null = null
  wrappingComposition: readonly Mark<any>[] | null = null

  mouseSelection: MouseSelection | null = null
  // When a drag from the editor is active, this points at the range
  // being dragged.
  draggedContent: GardSelection | null = null

  notifiedFocused: boolean

  setSelectionOrigin(origin: string) {
    this.lastSelectionOrigin = origin
    this.lastSelectionTime = Date.now()
  }

  constructor(readonly view: Wordgard) {
    this.handleEvent = this.handleEvent.bind(this)
    this.notifiedFocused = view.hasFocus
    // On Safari adding an input event handler somehow prevents an
    // issue where the composition vanishes when you press enter.
    if (browser.safari) view.contentDOM.addEventListener("input", () => null)
  }

  handleEvent(event: Event) {
    if (!eventBelongsToEditor(this.view, event) || this.ignoreDuringComposition(event)) return
    if (event.type == "keydown" && this.keydown(event as KeyboardEvent)) return
    if (event.type == "keyup" && (event as KeyboardEvent).keyCode == 16) this.shiftKey = false
    this.runHandlers(event.type, event)
  }

  runHandlers(type: string, event: Event) {
    let handlers = this.handlers[type]
    if (handlers) {
      for (let observer of handlers.observers) observer(this.view, event)
      for (let handler of handlers.handlers) {
        if (event.defaultPrevented) break
        if (handler(this.view, event)) { event.preventDefault(); break }
      }
    }
  }

  ensureHandlers(plugins: readonly PluginInstance[]) {
    let handlers = computeHandlers(plugins), prev = this.handlers, dom = this.view.contentDOM
    for (let type in handlers) if (type != "scroll") {
      let passive = !handlers[type].handlers.length
      let exists: (typeof prev)["type"] | null = prev[type]
      if (exists && passive != !exists.handlers.length) {
        dom.removeEventListener(type, this.handleEvent)
        exists = null
      }
      if (!exists) dom.addEventListener(type, this.handleEvent, {passive})
    }
    for (let type in prev) if (type != "scroll" && !handlers[type])
      dom.removeEventListener(type, this.handleEvent)
    this.handlers = handlers
  }

  keydown(event: KeyboardEvent) {
    // Must always run, even if a custom handler handled the event
    this.lastKeyCode = event.keyCode
    this.lastKeyTime = Date.now()
    this.shiftKey = event.keyCode == 16 || event.shiftKey

    if (event.keyCode == 9 && this.tabFocusMode > -1 && (!this.tabFocusMode || Date.now() <= this.tabFocusMode))
      return true
    if (this.tabFocusMode > 0 && event.keyCode != 27 && modifierCodes.indexOf(event.keyCode) < 0)
      this.tabFocusMode = -1
    return false
  }

  ignoreDuringComposition(event: Event): boolean {
    if (!/^key/.test(event.type)) return false
    if (this.composing && this.composing.changes) return true
    // See https://www.stum.de/2016/06/24/handling-ime-events-in-javascript/.
    // On some input method editors (IMEs), the Enter key is used to
    // confirm character selection. On Safari, when Enter is pressed,
    // compositionend and keydown events are sometimes emitted in the
    // wrong order. The key event should still be ignored, even when
    // it happens after the compositionend event.
    if (browser.safari && !browser.ios && this.compositionPendingKey && Date.now() - this.compositionEndedAt < 100) {
      this.compositionPendingKey = false
      return true
    }
    return false
  }

  startMouseSelection(mouseSelection: MouseSelection) {
    if (this.mouseSelection) this.mouseSelection.disconnect()
    this.mouseSelection = mouseSelection
  }

  update(update: Wordgard.Update) {
    if (this.mouseSelection) this.mouseSelection.update(update)
    if (this.draggedContent && update.docChanged) this.draggedContent = this.draggedContent.map(update.changes)
    if (update.transactions.length) this.lastKeyCode = this.lastSelectionTime = 0
  }

  compositionTarget() {
    if (!this.composing) return null
    return this.composing.target = findCompositionTarget(this.view, this.composing.target)
  }

  connect() {
    this.ensureHandlers(this.view.plugins)
  }

  disconnect() {
    if (this.mouseSelection) this.mouseSelection.disconnect()
  }
}

type HandlerFunction = (view: Wordgard, event: Event) => boolean | void

function bindHandler(
  plugin: Wordgard.Plugin.Value,
  handler: (this: Wordgard.Plugin.Value, event: Event, view: Wordgard) => boolean | void
): HandlerFunction {
  return (view, event) => {
    try {
      return handler.call(plugin, event, view)
    } catch (e) {
      logException(view.state, e)
    }
  }
}

function computeHandlers(plugins: readonly PluginInstance[]) {
  let result: {[event: string]: {
    observers: HandlerFunction[],
    handlers: HandlerFunction[]
  }} = Object.create(null)
  function record(type: string) {
    return result[type] || (result[type] = {observers: [], handlers: []})
  }
  for (let plugin of plugins) if (!plugin.deactivated) {
    let spec = plugin.spec
    if (spec.domEventHandlers) for (let type in spec.domEventHandlers) {
      let f = spec.domEventHandlers[type]
      if (f) record(type).handlers.push(bindHandler(plugin.value!, f))
    }
    if (spec.domEventObservers) for (let type in spec.domEventObservers) {
      let f = spec.domEventObservers[type]
      if (f) record(type).observers.push(bindHandler(plugin.value!, f))
    }
  }
  for (let type in handlers) record(type).handlers.push(handlers[type])
  for (let type in observers) record(type).observers.push(observers[type])
  return result
}

// Key codes for modifier keys
export const modifierCodes = [16, 17, 18, 20, 91, 92, 224, 225]

const dragScrollMargin = 6

export const mouseSelectionStyle = Facet.define<MakeSelectionStyle>()

/// Interface that objects registered with
/// [`Wordgard.mouseSelectionStyle`](#view.Wordgard^mouseSelectionStyle)
/// must conform to.
export interface MouseSelectionStyle {
  /// Return a new selection for the mouse gesture that starts with
  /// the event that was originally given to the constructor, and ends
  /// with the event passed here. In case of a plain click, those may
  /// both be the `mousedown` event, in case of a drag gesture, the
  /// latest `mousemove` event will be passed.
  ///
  /// When `extend` is true, that means the new selection should, if
  /// possible, extend the start selection.
  get: (curEvent: MouseEvent, extend: boolean) => GardSelection
  /// Called when the view is updated while the gesture is in
  /// progress. When the document changes, it may be necessary to map
  /// some data (like the original selection or start position)
  /// through the changes.
  ///
  /// This may return `true` to indicate that the `get` method should
  /// get queried again after the update, because something in the
  /// update could change its result. Be wary of infinite loops when
  /// using this (where `get` returns a new selection, which will
  /// trigger `update`, which schedules another `get` in response).
  update: (update: Wordgard.Update) => boolean | void
}

export type MakeSelectionStyle = (view: Wordgard, event: MouseEvent) => MouseSelectionStyle | null

function dragScrollSpeed(dist: number) {
  return Math.max(0, dist) * 0.7 + 8
}

function dist(a: MouseEvent, b: MouseEvent) {
  return Math.max(Math.abs(a.clientX - b.clientX), Math.abs(a.clientY - b.clientY))
}

class MouseSelection {
  dragging: null | boolean
  extend: boolean
  lastEvent: MouseEvent
  scrollParents: {x?: HTMLElement, y?: HTMLElement}
  scrollSpeed = {x: 0, y: 0}
  scrolling = -1

  constructor(private view: Wordgard,
              private startEvent: MouseEvent,
              private style: MouseSelectionStyle,
              private mustSelect: boolean) {
    this.lastEvent = startEvent
    this.scrollParents = scrollableParents(view.contentDOM)
    let doc = view.contentDOM.ownerDocument!
    doc.addEventListener("mousemove", this.move = this.move.bind(this))
    doc.addEventListener("mouseup", this.up = this.up.bind(this))

    this.extend = startEvent.shiftKey
    this.dragging = isInPrimarySelection(view, startEvent) && startEvent.detail == 1 ? null : false
  }

  start(event: MouseEvent) {
    // When clicking outside of the selection, immediately apply the
    // effect of starting the selection
    if (this.dragging === false) this.select(event)
  }

  move(event: MouseEvent) {
    if (event.buttons == 0) return this.disconnect()
    if (this.dragging || this.dragging == null && dist(this.startEvent, event) < 10) return
    this.select(this.lastEvent = event)

    let sx = 0, sy = 0
    let left = 0, top = 0, right = this.view.win.innerWidth, bottom = this.view.win.innerHeight
    if (this.scrollParents.x) ({left, right} = this.scrollParents.x.getBoundingClientRect())
    if (this.scrollParents.y) ({top, bottom} = this.scrollParents.y.getBoundingClientRect())
    let margins = this.view.getScrollMargins()

    if (event.clientX - margins.left <= left + dragScrollMargin)
      sx = -dragScrollSpeed(left - event.clientX)
    else if (event.clientX + margins.right >= right - dragScrollMargin)
      sx = dragScrollSpeed(event.clientX - right)
    if (event.clientY - margins.top <= top + dragScrollMargin)
      sy = -dragScrollSpeed(top - event.clientY)
    else if (event.clientY + margins.bottom >= bottom - dragScrollMargin)
      sy = dragScrollSpeed(event.clientY - bottom)
    this.setScrollSpeed(sx, sy)
  }

  up(event: MouseEvent) {
    if (this.dragging == null) this.select(this.lastEvent)
    if (!this.dragging) event.preventDefault()
    this.disconnect()
  }

  disconnect() {
    this.setScrollSpeed(0, 0)
    let doc = this.view.dom.ownerDocument
    doc.removeEventListener("mousemove", this.move)
    doc.removeEventListener("mouseup", this.up)
    this.view.inputState.mouseSelection = this.view.inputState.draggedContent = null
  }

  setScrollSpeed(sx: number, sy: number) {
    this.scrollSpeed = {x: sx, y: sy}
    if (sx || sy) {
      if (this.scrolling < 0) this.scrolling = setInterval(() => this.scroll(), 50)
    } else if (this.scrolling > -1) {
      clearInterval(this.scrolling)
      this.scrolling = -1
    }
  }

  scroll() {
    let {x, y} = this.scrollSpeed
    if (x && this.scrollParents.x) {
      this.scrollParents.x.scrollLeft += x
      x = 0
    }
    if (y && this.scrollParents.y) {
      this.scrollParents.y.scrollTop += y
      y = 0
    }
    if (x || y) this.view.win.scrollBy(x, y)
    if (this.dragging === false) this.select(this.lastEvent)
  }

  select(event: MouseEvent) {
    let {view} = this, selection = this.style.get(event, this.extend)
    if (this.mustSelect || !selection.eqPos(view.state.selection))
      this.view.dispatch({
        selection,
        userEvent: "select.pointer"
      })
    this.mustSelect = false
  }

  update(update: Wordgard.Update) {
    if (update.transactions.some(tr => tr.isUserEvent("input.type")))
      this.disconnect()
    else if (this.style.update(update))
      setTimeout(() => this.select(this.lastEvent), 20)
  }
}

export const dragBehavior = Facet.define<(event: MouseEvent) => boolean>()

function dragMovesSelection(view: Wordgard, event: MouseEvent) {
  let facet = view.state.facet(dragBehavior)
  return facet.length ? facet[0](event) : browser.mac ? !event.altKey : !event.ctrlKey
}

function isInPrimarySelection(view: Wordgard, event: MouseEvent) {
  let {selection} = view.state
  if (selection.empty) return false
  // On boundary clicks, check whether the coordinates are inside the
  // selection's client rectangles
  let sel = getSelection(view.root)
  if (!sel || sel.rangeCount == 0) return true
  let rects = sel.getRangeAt(0).getClientRects()
  for (let i = 0; i < rects.length; i++) {
    let rect = rects[i]
    if (rect.left <= event.clientX && rect.right >= event.clientX &&
      rect.top <= event.clientY && rect.bottom >= event.clientY) return true
  }
  return false
}

function eventBelongsToEditor(view: Wordgard, event: Event): boolean {
  if (!event.bubbles) return true
  if (event.defaultPrevented) return false
  for (let node = event.target as DOMNode | null, tile; node != view.contentDOM; node = node.parentNode)
    if (!node || node.nodeType == 11 || (tile = Tile.get(node)) && tile.handleEvent(event, view))
      return false
  return true
}

// FIXME use something less messy?
const handlers: {[key: string]: (view: Wordgard, event: any) => boolean} = Object.create(null)
const observers: {[key: string]: (view: Wordgard, event: any) => undefined} = Object.create(null)

observers.scroll = view => {
  view.inputState.lastScrollTop = view.scrollDOM.scrollTop
  view.inputState.lastScrollLeft = view.scrollDOM.scrollLeft
}

handlers.keydown = (view, event: KeyboardEvent) => {
  view.inputState.setSelectionOrigin("select")
  if (event.keyCode == 27 && view.inputState.tabFocusMode != 0) view.inputState.tabFocusMode = Date.now() + 2000
  return false
}

// FIXME proper strategy for touch handling

observers.touchstart = (view, e) => {
  view.inputState.lastTouchTime = Date.now()
  view.inputState.setSelectionOrigin("select.pointer")
}

observers.touchmove = view => {
  view.inputState.setSelectionOrigin("select.pointer")
}

handlers.mousedown = (view, event: MouseEvent) => {
  view.inputState.shiftKey = event.shiftKey
  if (view.inputState.lastTouchTime > Date.now() - 2000) return false // Ignore touch interaction
  let style: MouseSelectionStyle | null = null
  for (let makeStyle of view.state.facet(mouseSelectionStyle)) {
    style = makeStyle(view, event)
    if (style) break
  }
  if (!style && event.button == 0) style = basicMouseSelection(view, event)
  if (style) {
    let mustFocus = !view.hasFocus
    view.inputState.startMouseSelection(new MouseSelection(view, event, style, mustFocus))
    if (mustFocus) view.observer.ignore(() => {
      view.contentDOM.focus({preventScroll: true})
      let active = view.root.activeElement
      if (active && !active.contains(view.contentDOM)) (active as HTMLElement).blur()
    })
    let mouseSel = view.inputState.mouseSelection
    if (mouseSel) {
      mouseSel.start(event)
      return mouseSel.dragging === false
    }
  }
  return false
}

function queryPos(view: Wordgard, event: MouseEvent) {
  return view.posAtCoords({x: event.clientX, y: event.clientY}) as CoordPos
}

function rangeForClick(view: Wordgard, pos: CoordPos, type: number): GardSelection {
  if (type < 3 && pos.target != null) {
    let target = view.state.doc.nodeAt(pos.target)
    if (target && target.isLeaf && target.type.isSelectable) return GardSelection.range(pos.target, pos.target + target.length)
  }
  if (type == 1) { // Single click
    return GardSelection.near(view.state, pos.pos, pos.assoc || -1)
  } else if (type == 2) { // Double click
    return view.state.wordAt(pos.pos, pos.assoc || 1)
  } else { // Triple click
    let cx = view.state.doc.resolve(pos.pos), block = cx.textblockParent
    if (block) return GardSelection.range(block.start, block.end)
    else return GardSelection.near(view.state, pos.pos, pos.assoc || -1)
  }
}

function basicMouseSelection(view: Wordgard, event: MouseEvent) {
  let start = queryPos(view, event), type = event.detail
  let startSel = view.state.selection
  return {
    update(update) {
      if (update.docChanged) {
        start = start.map(update.changes)
        startSel = startSel.map(update.changes)
      }
    },
    get(event, extend) {
      let cur = queryPos(view, event), {from, to} = rangeForClick(view, cur, type)
      if (extend) {
        if (from < startSel.anchor)
          return GardSelection.range(startSel.anchor, from, from < to ? 1 : cur.assoc)
        else
          return GardSelection.range(startSel.anchor, to, from < to ? -1 : cur.assoc)
      }
      if (start.pos != cur.pos) {
        let startRange = rangeForClick(view, start, type)
        from = Math.min(startRange.from, from)
        to = Math.max(startRange.to, to)
      }
      return GardSelection.range(from, to, cur.assoc)
    }
  } as MouseSelectionStyle
}

handlers.dragstart = (view, event: DragEvent) => {
  let {selection} = view.state
  let {inputState} = view
  if (inputState.mouseSelection) inputState.mouseSelection.dragging = true
  inputState.draggedContent = selection

  if (event.dataTransfer) {
    let {slice, context} = selectionSlice(view.state)
    writeClipboard(view.state, slice, context, event.dataTransfer)
    event.dataTransfer.effectAllowed = "copyMove"
  }
  return false
}

handlers.dragend = view => {
  view.inputState.draggedContent = null
  return false
}

handlers.drop = (view, event: DragEvent) => {
  if (!event.dataTransfer || view.state.readOnly) return true
  let content = readClipboard(view.state, event.dataTransfer, view.state.sel.head, false)
  if (content) {
    let dropPos = view.posAtCoords({x: event.clientX, y: event.clientY}).pos
    let {draggedContent} = view.inputState
    let del = draggedContent && dragMovesSelection(view, event)
      ? {from: draggedContent.from, to: draggedContent.to} : null
    let ins = {from: dropPos, insert: content.slice, fit: content.context}
    let changes = ChangeSet.create(view.state.doc, del ? [del, ins] : ins)
    view.focus()
    view.dispatch({
      changes,
      selection: GardSelection.range(changes.mapPos(dropPos, -1), changes.mapPos(dropPos, 1)),
      userEvent: del ? "move.drop" : "input.drop"
    })
    view.inputState.draggedContent = null
  }
  return false
}

handlers.paste = (view: Wordgard, event: ClipboardEvent) => {
  if (view.state.readOnly || !event.clipboardData) return true
  let {state} = view
  let content = readClipboard(state, event.clipboardData, state.sel.head, view.inputState.shiftKey)
  if (content) { // FIXME proper multi-selection pasting
    let changes = ChangeSet.create(view.state.doc, {
      from: state.selection.from,
      to: state.selection.to,
      insert: content.slice,
      fit: content.context
    })
    view.dispatch({
      changes,
      selection: GardSelection.cursor(changes.mapPos(state.selection.from, 1), -1),
      normalizeSelection: true,
      userEvent: "input.paste",
      scrollIntoView: true
    })
  }
  return true
}

function selectionSlice(state: GardState) { // FIXME smarter primitive?
  return {
    slice: state.doc.slice(state.selection.from, state.selection.to),
    context: state.doc.contextAt(state.selection.from)
  }
}

handlers.copy = handlers.cut = (view, event: ClipboardEvent) => {
  let {state} = view
  if (!state.selection.empty && event.clipboardData) { // FIXME block-wise copying
    let {slice, context} = selectionSlice(state)
    writeClipboard(state, slice, context, event.clipboardData)
    if (event.type == "cut" && !state.readOnly)
      view.dispatch({
        changes: state.selection.ranges.map(r => ({from: r.from, to: r.to})),
        scrollIntoView: true,
        userEvent: "delete.cut"
      })
  }
  return true
}

export const isFocusChange = Transaction.Annotation.define<boolean>()

function updateForFocusChange(view: Wordgard) {
  setTimeout(() => {
    let focus = view.hasFocus
    if (focus != view.inputState.notifiedFocused) {
      view.inputState.notifiedFocused = focus
      view.dispatch({annotations: isFocusChange.of(focus)})
    }
  }, 10)
}

observers.focus = view => {
  // When focusing reset the scroll position, move it back to where it was
  if (!view.scrollDOM.scrollTop && (view.inputState.lastScrollTop || view.inputState.lastScrollLeft)) {
    view.scrollDOM.scrollTop = view.inputState.lastScrollTop
    view.scrollDOM.scrollLeft = view.inputState.lastScrollLeft
  }
  updateForFocusChange(view)
}

observers.blur = view => {
  view.observer.clearSelectionRange()
  updateForFocusChange(view)
}

observers.compositionstart = observers.compositionupdate = (view, event: CompositionEvent) => {
  if (!view.inputState.composing) {
    view.inputState.composing = {changes: 0, target: null}

    let wrap: readonly Mark<any>[] | null = null
    if (!view.inputState.composing.changes && !event.data) {
      let sel = view.state.sel, mark = sel.marks || sel.from.marks()
      if (sel.empty && (sel.marks || !sel.head.inText && sel.head.index) &&
          !eqArray(sel.head.nodeBefore?.tag.marks, mark))
        wrap = mark
    }

    if (wrap) try {
      view.inputState.wrappingComposition = wrap
      view.flush()
    } finally { view.inputState.wrappingComposition = null }
  }
}

observers.compositionend = view => {
  let target = view.inputState.composing?.target
  view.inputState.composing = null
  view.inputState.compositionEndedAt = Date.now()
  if (target) {
    let pos = view.docTile.posBeforeDOM(target)
    if (pos != null) view.observer.addDirtyRange(pos, pos + target.nodeValue!.length)
    view.flush()
  }
}

function findCompositionTarget(view: Wordgard, prev: Text | null) {
  let {focusNode, focusOffset} = view.observer.selectionRange
  if (!focusNode) return null
  let before = textNodeBefore(focusNode, focusOffset), after = textNodeAfter(focusNode, focusOffset)
  if (!before || !after || before == after) return before || after
  let tileBefore = Tile.get(before), tileAfter = Tile.get(after)
  if (!tileBefore || (tileBefore as any).text != before.nodeValue) return before
  if (!tileAfter || (tileAfter as any).text != after.nodeValue) return after
  return prev == after ? after : before
}

export type CompositionInfo = {
  fromA: number, toA: number,
  text: string,
  target: Text | null,
  wrapCursor?: readonly Mark<any>[] | null
}

export function getCompositionInfo(view: Wordgard): CompositionInfo | null {
  let target = view.inputState.compositionTarget()

  let wrap = view.inputState.wrappingComposition
  if (wrap) {
    let sel = view.state.selection.head
    return {
      fromA: sel, toA: sel,
      text: "",
      target: null,
      wrapCursor: wrap
    }
  }

  if (!target) return null
  let from = view.docTile.posBeforeDOM(target)
  if (from == null) return null
  for (let tr of view.viewState.pending) from = tr.changes.mapPos(from, -1)
  let value = target.nodeValue!
  let oldTile = view.docTile.nearest(target)
  let oldLen = oldTile && oldTile.dom == target ? oldTile.length : 0

  return {
    fromA: from, toA: from + oldLen,
    text: value,
    target
  }
}

function findCompositionSelection(node: DOMNode, offset: number, target: Text, targetPos: number) {
  if (node == target) return targetPos + offset
  if (node.compareDocumentPosition(target) & 2 /* preceding */) return targetPos + target.nodeValue!.length
  return targetPos
}

observers.contextmenu = view => {
  view.inputState.lastContextMenu = Date.now()
}

// FIXME formatSetBlockTextDirection, formatSetInlineTextDirection
const inputTypeCommands: {[inputType: string]: Command.Bound | Command} = {
  historyUndo: undo,
  historyRedo: redo,
  insertLineBreak: insertLineBreak,
  insertParagraph: enter,
  deleteContentBackward: Command.bind(deleteUnit, "backward"),
  deleteContentForward: Command.bind(deleteUnit, "forward"),
  deleteWordBackward: Command.bind(deleteWord, "backward"),
  deleteWordForward: Command.bind(deleteWord, "forward"),
  deleteSoftLineBackward: Command.bind(deleteToLineEnd, "backward"),
  deleteSoftLineForward: Command.bind(deleteToLineEnd, "forward"),
  deleteHardLineBackward: Command.bind(deleteToLineEnd, "backward"),
  deleteHardLineForward: Command.bind(deleteToLineEnd, "forward"),
  deleteContent: view => {
    let tr = deleteSelection(view.state)
    if (tr) view.dispatch(tr)
    return !!tr
  },
  insertTranspose: transposeChars,
  deleteEntireSoftLine: deleteLine,
  formatBold: Command.bind(toggleMarkByLabel, Mark.Role.Strong),
  formatItalic: Command.bind(toggleMarkByLabel, Mark.Role.Emphasis),
  formatUnderline: Command.bind(toggleMarkByLabel, Mark.Role.Underline),
}

handlers.beforeinput = (view, event: InputEvent) => {
  let type = event.inputType

  let command = inputTypeCommands[type]
  if (command) {
    Command.dispatch(view, command)
    return true
  }

  if (type == "insertText") {
    // Safari will occasionally forget to fire compositionend at the end of a dead-key composition
    if (browser.safari && view.inputState.composing) observers.compositionend(view, event)
    let insert = event.data!.replace(/\r\n?|\n/g, " ")
    let {from, to} = inputEventRange(event, view)
    Command.dispatch(view, insertText, {from, to, insert, userEvent: "input.type"})
    return true
  } else if (type == "insertReplacementText" || type == "insertFromYank") {
    let slice = readClipboard(view.state, event.dataTransfer!, view.state.sel.head, true)?.slice
    if (slice) {
      let {from, to} = inputEventRange(event, view)
      view.dispatch({changes: {from, to, insert: slice, fit: true}})
      return true
    }
  } else if (type == "insertCompositionText") {
    if (!view.inputState.composing)
      view.inputState.composing = {changes: 0, target: null}
    view.inputState.currentComposition = {...inputEventRange(event, view), text: event.data!}
  }

  return false
}

handlers.input = (view, event: InputEvent) => {
  if (event.inputType == "insertCompositionText" && view.inputState.currentComposition) {
    let {from, to, text} = view.inputState.currentComposition
    view.inputState.currentComposition = null
    let start = !view.inputState.composing!.changes
    view.inputState.composing!.changes++
    view.observer.readSelectionRange()
    let sel = view.observer.selectionRange
    if (!sel.focusNode) return false
    let anchor = -1, head = -1
    let target = view.inputState.compositionTarget(), targetPos = target && view.docTile.posBeforeDOM(target)
    if (targetPos != null && sel.focusNode) {
      anchor = findCompositionSelection(sel.anchorNode!, sel.anchorOffset, target!, targetPos)
      head = sel.empty ? anchor : findCompositionSelection(sel.focusNode, sel.focusOffset, target!, targetPos)
    }
    if (head < 0) anchor = -1
    for (let tr of view.viewState.pending) {
      from = tr.changes.mapPos(from); to = tr.changes.mapPos(to)
      if (anchor > -1) { anchor = tr.changes.mapPos(anchor); head = tr.changes.mapPos(head) }
    }
    Command.dispatch(view, insertText, {from, to, insert: text, userEvent: "input.type.compose" + (start ? ".start" : "")})
  }
  return false
}

function inputEventRange(event: InputEvent, view: Wordgard) {
  let range = event.getTargetRanges()[0]
  return {from: view.docTile.posFromDOM(range.startContainer, range.startOffset, -1),
          to: view.docTile.posFromDOM(range.endContainer, range.endOffset, 1)}
}
