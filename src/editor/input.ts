import {GardSelection, GardState, Transaction, Facet} from "wordgard/state"
import {Plot, ChangeSet, Mark, Slice} from "wordgard/doc"
import {Command, undo, redo, insertLineBreak, enter, insertText,
        deleteWord, deleteUnit, deleteToLineEnd, deleteLine, toggleMarkByLabel,
        transposeChars, deleteSelection} from "wordgard/command"
import {Wordgard, PluginInstance} from "./editor"
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
  pendingComposition: {from: number, to: number, text: string} | null = null
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

  constructor(readonly wg: Wordgard) {
    this.handleEvent = this.handleEvent.bind(this)
    this.notifiedFocused = wg.hasFocus
    // On Safari adding an input event handler somehow prevents an
    // issue where the composition vanishes when you press enter.
    if (browser.safari) wg.contentDOM.addEventListener("input", () => null)
  }

  handleEvent(event: Event) {
    if (!eventBelongsToEditor(this.wg, event) || this.ignoreDuringComposition(event)) return
    if (event.type == "keydown" && this.keydown(event as KeyboardEvent)) return
    if (event.type == "keyup" && (event as KeyboardEvent).keyCode == 16) this.shiftKey = false
    this.runHandlers(event.type, event)
  }

  runHandlers(type: string, event: Event) {
    let handlers = this.handlers[type]
    if (handlers) {
      for (let observer of handlers.observers) observer(this.wg, event)
      for (let handler of handlers.handlers) {
        if (event.defaultPrevented) break
        if (handler(this.wg, event)) { event.preventDefault(); break }
      }
    }
  }

  ensureHandlers(plugins: readonly PluginInstance[]) {
    let handlers = computeHandlers(plugins), prev = this.handlers, dom = this.wg.contentDOM
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
    if (this.draggedContent && update.docChanged) this.draggedContent = this.draggedContent.map(update.changes, update.state)
    if (update.transactions.length) this.lastKeyCode = this.lastSelectionTime = 0
  }

  compositionTarget() {
    if (!this.composing) return null
    return this.composing.target = findCompositionTarget(this.wg, this.composing.target)
  }

  connect() {
    this.ensureHandlers(this.wg.plugins)
  }

  disconnect() {
    if (this.mouseSelection) this.mouseSelection.disconnect()
  }
}

type HandlerFunction = (wg: Wordgard, event: Event) => boolean | void

function bindHandler(
  plugin: Wordgard.Plugin.Value,
  handler: (this: Wordgard.Plugin.Value, event: Event, wg: Wordgard) => boolean | void
): HandlerFunction {
  return (wg, event) => {
    try {
      return handler.call(plugin, event, wg)
    } catch (e) {
      logException(wg.state, e)
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
/// [`Wordgard.mouseSelectionStyle`](#editor.Wordgard^mouseSelectionStyle)
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
  /// Called when the editor is updated while the gesture is in
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

export type MakeSelectionStyle = (wg: Wordgard, event: MouseEvent) => MouseSelectionStyle | null

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

  constructor(private wg: Wordgard,
              private startEvent: MouseEvent,
              private style: MouseSelectionStyle,
              private mustSelect: boolean) {
    this.lastEvent = startEvent
    this.scrollParents = scrollableParents(wg.contentDOM)
    let doc = wg.contentDOM.ownerDocument!
    doc.addEventListener("mousemove", this.move = this.move.bind(this))
    doc.addEventListener("mouseup", this.up = this.up.bind(this))

    this.extend = startEvent.shiftKey
    this.dragging = isInPrimarySelection(wg, startEvent) && startEvent.detail == 1 ? null : false
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
    let left = 0, top = 0, right = this.wg.win.innerWidth, bottom = this.wg.win.innerHeight
    if (this.scrollParents.x) ({left, right} = this.scrollParents.x.getBoundingClientRect())
    if (this.scrollParents.y) ({top, bottom} = this.scrollParents.y.getBoundingClientRect())
    let margins = this.wg.getScrollMargins()

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
    let doc = this.wg.dom.ownerDocument
    doc.removeEventListener("mousemove", this.move)
    doc.removeEventListener("mouseup", this.up)
    this.wg.inputState.mouseSelection = this.wg.inputState.draggedContent = null
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
    if (x || y) this.wg.win.scrollBy(x, y)
    if (this.dragging === false) this.select(this.lastEvent)
  }

  select(event: MouseEvent) {
    let {wg} = this, selection = this.style.get(event, this.extend)
    if (this.mustSelect || !selection.eqPos(wg.state.selection))
      this.wg.dispatch({
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

function dragMovesSelection(wg: Wordgard, event: MouseEvent) {
  let facet = wg.state.facet(dragBehavior)
  return facet.length ? facet[0](event) : browser.mac ? !event.altKey : !event.ctrlKey
}

function isInPrimarySelection(wg: Wordgard, event: MouseEvent) {
  let {selection} = wg.state
  if (selection.empty) return false
  // On boundary clicks, check whether the coordinates are inside the
  // selection's client rectangles
  let sel = getSelection(wg.root)
  if (!sel || sel.rangeCount == 0) return true
  let rects = sel.getRangeAt(0).getClientRects()
  for (let i = 0; i < rects.length; i++) {
    let rect = rects[i]
    if (rect.left <= event.clientX && rect.right >= event.clientX &&
      rect.top <= event.clientY && rect.bottom >= event.clientY) return true
  }
  return false
}

function eventBelongsToEditor(wg: Wordgard, event: Event): boolean {
  if (!event.bubbles) return true
  if (event.defaultPrevented) return false
  for (let node = event.target as DOMNode | null, tile; node != wg.contentDOM; node = node.parentNode)
    if (!node || node.nodeType == 11 || (tile = Tile.get(node)) && tile.handleEvent(event, wg))
      return false
  return true
}

// FIXME use something less messy?
const handlers: {[key: string]: (wg: Wordgard, event: any) => boolean} = Object.create(null)
const observers: {[key: string]: (wg: Wordgard, event: any) => undefined} = Object.create(null)

observers.scroll = wg => {
  wg.inputState.lastScrollTop = wg.scrollDOM.scrollTop
  wg.inputState.lastScrollLeft = wg.scrollDOM.scrollLeft
}

handlers.keydown = (wg, event: KeyboardEvent) => {
  wg.inputState.setSelectionOrigin("select")
  if (event.keyCode == 27 && wg.inputState.tabFocusMode != 0) wg.inputState.tabFocusMode = Date.now() + 2000
  return false
}

// FIXME proper strategy for touch handling

observers.touchstart = (wg, e) => {
  wg.inputState.lastTouchTime = Date.now()
  wg.inputState.setSelectionOrigin("select.pointer")
}

observers.touchmove = wg => {
  wg.inputState.setSelectionOrigin("select.pointer")
}

handlers.mousedown = (wg, event: MouseEvent) => {
  wg.inputState.shiftKey = event.shiftKey
  if (wg.inputState.lastTouchTime > Date.now() - 2000) return false // Ignore touch interaction
  let style: MouseSelectionStyle | null = null
  for (let makeStyle of wg.state.facet(mouseSelectionStyle)) {
    style = makeStyle(wg, event)
    if (style) break
  }
  if (!style && event.button == 0) style = basicMouseSelection(wg, event)
  if (style) {
    let mustFocus = !wg.hasFocus
    wg.inputState.startMouseSelection(new MouseSelection(wg, event, style, mustFocus))
    if (mustFocus) wg.observer.ignore(() => {
      // FIXME on Firefox this somehow focuses the cell selection
      wg.contentDOM.focus({preventScroll: true})
      let active = wg.root.activeElement
      if (active && !active.contains(wg.contentDOM)) (active as HTMLElement).blur()
    })
    let mouseSel = wg.inputState.mouseSelection
    if (mouseSel) {
      mouseSel.start(event)
      return mouseSel.dragging === false
    }
  }
  return false
}

function queryPos(wg: Wordgard, event: MouseEvent) {
  return wg.posAtCoords({x: event.clientX, y: event.clientY}) as CoordPos
}

function rangeForClick(wg: Wordgard, pos: CoordPos, type: number): GardSelection {
  if (type < 3 && pos.target != null) {
    let target = wg.state.doc.nodeAt(pos.target)
    if (target && target.isLeaf && target.type.isSelectable) return GardSelection.node(pos.target, target)
  }
  if (type == 1) { // Single click
    return GardSelection.near(wg.state, pos.pos, pos.side || -1)
  } else if (type == 2) { // Double click
    return wg.state.wordAt(pos.pos, pos.side || 1)
  } else { // Triple click
    let cx = wg.state.doc.resolve(pos.pos), block = cx.textblockParent
    if (block) return GardSelection.range(block.start, block.end)
    else return GardSelection.near(wg.state, pos.pos, pos.side || -1)
  }
}

function basicMouseSelection(wg: Wordgard, event: MouseEvent) {
  let start = queryPos(wg, event), type = event.detail
  let startSel = wg.state.selection
  return {
    update(update) {
      if (update.docChanged) {
        start = start.map(update.changes)
        startSel = startSel.map(update.changes, update.state)
      }
    },
    get(event, extend) {
      let cur = queryPos(wg, event), range = rangeForClick(wg, cur, type), {from, to} = range
      if (extend) {
        if (from < startSel.anchor)
          return GardSelection.range(startSel.anchor, from, from < to ? 1 : cur.side)
        else
          return GardSelection.range(startSel.anchor, to, from < to ? -1 : cur.side)
      }
      if (start.pos != cur.pos) {
        let startRange = rangeForClick(wg, start, type)
        from = Math.min(startRange.from, from)
        to = Math.max(startRange.to, to)
      }
      return from == range.from && to == range.to ? range : GardSelection.range(from, to, cur.side)
    }
  } as MouseSelectionStyle
}

handlers.dragstart = (wg, event: DragEvent) => {
  let {selection} = wg.state
  let {inputState} = wg
  if (inputState.mouseSelection) inputState.mouseSelection.dragging = true
  inputState.draggedContent = selection

  if (event.dataTransfer) {
    let {slice, context} = selectionSlice(wg.state)
    writeClipboard(wg.state, slice, context, event.dataTransfer)
    event.dataTransfer.effectAllowed = "copyMove"
  }
  return false
}

handlers.dragend = wg => {
  wg.inputState.draggedContent = null
  return false
}

handlers.drop = (wg, event: DragEvent) => {
  if (!event.dataTransfer || wg.state.readOnly) return true
  let content = readClipboard(wg.state, event.dataTransfer, wg.state.sel.head, false)
  if (content) {
    let dropPos = wg.posAtCoords({x: event.clientX, y: event.clientY}).pos
    let {draggedContent} = wg.inputState
    let del = draggedContent && dragMovesSelection(wg, event)
      ? {from: draggedContent.from, to: draggedContent.to} : null
    let ins = {from: dropPos, insert: content.slice, fit: content.context}
    let changes = ChangeSet.create(wg.state.doc, del ? [del, ins] : ins)
    wg.focus()
    wg.dispatch({
      changes,
      selection: GardSelection.range(changes.mapPos(dropPos, -1), changes.mapPos(dropPos, 1)),
      userEvent: del ? "move.drop" : "input.drop"
    })
    wg.inputState.draggedContent = null
  }
  return false
}

export const pasteHandler = Facet.define<(
  wg: Wordgard,
  event: ClipboardEvent,
  slice: Slice,
  context: readonly Plot.Tag.Any[]
) => boolean>()

handlers.paste = (wg: Wordgard, event: ClipboardEvent) => {
  if (wg.state.readOnly || !event.clipboardData) return true
  let {state} = wg
  let content = readClipboard(state, event.clipboardData, state.sel.head, wg.inputState.shiftKey)
  if (wg.state.facet(pasteHandler).some(h => h(wg, event, content ? content.slice : Slice.empty,
                                                 content ? content.context : [])))
    return true
  if (content) { // FIXME proper multi-selection pasting
    let changes = ChangeSet.create(wg.state.doc, {
      from: state.selection.from,
      to: state.selection.to,
      insert: content.slice,
      fit: content.context
    })
    wg.dispatch({
      changes,
      selection: cx => GardSelection.near(cx, changes.mapPos(state.selection.to, 1), -1),
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

handlers.copy = handlers.cut = (wg, event: ClipboardEvent) => {
  let {state} = wg
  if (!state.selection.empty && event.clipboardData) { // FIXME block-wise copying
    let {slice, context} = selectionSlice(state)
    writeClipboard(state, slice, context, event.clipboardData)
    if (event.type == "cut" && !state.readOnly)
      wg.dispatch({
        changes: state.selection.ranges.map(r => ({from: r.from, to: r.to})),
        scrollIntoView: true,
        userEvent: "delete.cut"
      })
  }
  return true
}

export const isFocusChange = Transaction.Annotation.define<boolean>()

function updateForFocusChange(wg: Wordgard) {
  setTimeout(() => {
    let focus = wg.hasFocus
    if (focus != wg.inputState.notifiedFocused) {
      wg.inputState.notifiedFocused = focus
      wg.dispatch({annotations: isFocusChange.of(focus)})
    }
  }, 10)
}

observers.focus = wg => {
  // When focusing reset the scroll position, move it back to where it was
  if (!wg.scrollDOM.scrollTop && (wg.inputState.lastScrollTop || wg.inputState.lastScrollLeft)) {
    wg.scrollDOM.scrollTop = wg.inputState.lastScrollTop
    wg.scrollDOM.scrollLeft = wg.inputState.lastScrollLeft
  }
  updateForFocusChange(wg)
}

observers.blur = wg => {
  wg.observer.clearSelectionRange()
  updateForFocusChange(wg)
}

observers.compositionstart = observers.compositionupdate = (wg, event: CompositionEvent) => {
  if (!wg.inputState.composing) {
    wg.inputState.composing = {changes: 0, target: null}

    let wrap: readonly Mark<any>[] | null = null
    if (!wg.inputState.composing.changes && !event.data) {
      let sel = wg.state.selection, rSel = wg.state.sel
      if (sel.empty && (sel instanceof GardSelection.Text && sel.marks || !rSel.head.inText && rSel.head.index) &&
          !eqArray(rSel.head.nodeBefore?.tag.marks, rSel.activeMarks))
        wrap = rSel.activeMarks
    }

    if (wrap) try {
      wg.inputState.wrappingComposition = wrap
      wg.flush()
    } finally { wg.inputState.wrappingComposition = null }
  }
}

observers.compositionend = wg => {
  let target = wg.inputState.composing?.target
  wg.inputState.composing = null
  wg.inputState.compositionEndedAt = Date.now()
  if (target) {
    let pos = wg.docTile.posBeforeDOM(target)
    if (pos != null) wg.observer.addDirtyRange(pos, pos + target.nodeValue!.length)
    wg.flush()
  }
}

function findCompositionTarget(wg: Wordgard, prev: Text | null) {
  let {focusNode, focusOffset} = wg.observer.selectionRange
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

export function getCompositionInfo(wg: Wordgard): CompositionInfo | null {
  let target = wg.inputState.compositionTarget()

  let wrap = wg.inputState.wrappingComposition
  if (wrap) {
    let sel = wg.state.selection.head
    return {
      fromA: sel, toA: sel,
      text: "",
      target: null,
      wrapCursor: wrap
    }
  }

  if (!target) return null
  let from = wg.docTile.posBeforeDOM(target)
  if (from == null) return null
  for (let tr of wg.viewState.pending) from = tr.changes.mapPos(from, -1)
  let value = target.nodeValue!
  let oldTile = wg.docTile.nearest(target)
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

observers.contextmenu = wg => {
  wg.inputState.lastContextMenu = Date.now()
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
  deleteContent: wg => {
    let tr = deleteSelection(wg.state)
    if (tr) wg.dispatch(tr)
    return !!tr
  },
  insertTranspose: transposeChars,
  deleteEntireSoftLine: deleteLine,
  formatBold: Command.bind(toggleMarkByLabel, Mark.Role.Strong),
  formatItalic: Command.bind(toggleMarkByLabel, Mark.Role.Emphasis),
  formatUnderline: Command.bind(toggleMarkByLabel, Mark.Role.Underline),
}

handlers.beforeinput = (wg, event: InputEvent) => {
  let type = event.inputType

  let command = inputTypeCommands[type]
  if (command) {
    Command.dispatch(wg, command)
    return true
  }

  if (type == "insertText") {
    // Safari will occasionally forget to fire compositionend at the end of a dead-key composition
    if (browser.safari && wg.inputState.composing) observers.compositionend(wg, event)
    let insert = event.data!.replace(/\r\n?|\n/g, " ")
    let {from, to} = inputEventRange(event, wg)
    Command.dispatch(wg, insertText, {from, to, insert, userEvent: "input.type"})
    return true
  } else if (type == "insertReplacementText" || type == "insertFromYank") {
    let slice = readClipboard(wg.state, event.dataTransfer!, wg.state.sel.head, true)?.slice
    if (slice) {
      let {from, to} = inputEventRange(event, wg)
      wg.dispatch({changes: {from, to, insert: slice, fit: true}})
      return true
    }
  } else if (type == "insertCompositionText") {
    if (!wg.inputState.composing)
      wg.inputState.composing = {changes: 0, target: null}
    wg.inputState.pendingComposition = {...inputEventRange(event, wg), text: event.data!}
  }

  return false
}

handlers.input = (wg, event: InputEvent) => {
  if (event.inputType == "insertCompositionText" && wg.inputState.pendingComposition) {
    let {from, to, text} = wg.inputState.pendingComposition
    wg.inputState.pendingComposition = null
    let start = !wg.inputState.composing!.changes
    wg.inputState.composing!.changes++
    wg.observer.readSelectionRange()
    let sel = wg.observer.selectionRange
    if (!sel.focusNode) return false
    let anchor = -1, head = -1
    let target = wg.inputState.compositionTarget(), targetPos = target && wg.docTile.posBeforeDOM(target)
    if (targetPos != null && sel.focusNode) {
      anchor = findCompositionSelection(sel.anchorNode!, sel.anchorOffset, target!, targetPos)
      head = sel.empty ? anchor : findCompositionSelection(sel.focusNode, sel.focusOffset, target!, targetPos)
    }
    if (head < 0) anchor = -1
    for (let tr of wg.viewState.pending) {
      from = tr.changes.mapPos(from); to = tr.changes.mapPos(to)
      if (anchor > -1) { anchor = tr.changes.mapPos(anchor); head = tr.changes.mapPos(head) }
    }
    Command.dispatch(wg, insertText, {from, to, insert: text, userEvent: "input.type.compose" + (start ? ".start" : "")})
  }
  return false
}

function inputEventRange(event: InputEvent, wg: Wordgard) {
  let range = event.getTargetRanges()[0]
  return {from: wg.docTile.posFromDOM(range.startContainer, range.startOffset, -1),
          to: wg.docTile.posFromDOM(range.endContainer, range.endOffset, 1)}
}
