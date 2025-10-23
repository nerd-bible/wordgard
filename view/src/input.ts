import {EditorSelection, EditorState} from "@wordgard/state"
import {Slice, Node, ChangeSet, Prop} from "@wordgard/doc"
import {EditorView} from "./editorview"
import {ViewUpdate, PluginValue, clickAddsSelectionRange, dragMovesSelection as dragBehavior,
        logException, mouseSelectionStyle, PluginInstance, getScrollMargins, inputEventHandler} from "./extension"
import browser from "./browser"
import {getSelection, scrollableParents, DOMNode, textNodeBefore, textNodeAfter} from "./dom"
import {readClipboard, writeClipboard} from "./clipboard"
import {eqArray} from "./util"
import {Tile} from "./tile"

export class InputState {
  shiftKey = false
  lastKeyCode: number = 0
  lastKeyTime: number = 0
  lastTouchTime = 0
  lastFocusTime = 0
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
  // FIXME add a timeout to guard against this leaking?
  currentComposition: {from: number, to: number, text: string} | null = null
  wrappingComposition: readonly Prop<any>[] | null = null

  mouseSelection: MouseSelection | null = null
  // When a drag from the editor is active, this points at the range
  // being dragged.
  draggedContent: EditorSelection | null = null

  notifiedFocused: boolean

  setSelectionOrigin(origin: string) {
    this.lastSelectionOrigin = origin
    this.lastSelectionTime = Date.now()
  }

  constructor(readonly view: EditorView) {
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

  update(update: ViewUpdate) {
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

type HandlerFunction = (view: EditorView, event: Event) => boolean | void

function bindHandler(
  plugin: PluginValue,
  handler: (this: PluginValue, event: Event, view: EditorView) => boolean | void
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
  for (let plugin of plugins) {
    let spec = plugin.spec
    if (spec && spec.domEventHandlers) for (let type in spec.domEventHandlers) {
      let f = spec.domEventHandlers[type]
      if (f) record(type).handlers.push(bindHandler(plugin.value!, f))
    }
    if (spec && spec.domEventObservers) for (let type in spec.domEventObservers) {
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

/// Interface that objects registered with
/// [`EditorView.mouseSelectionStyle`](#view.EditorView^mouseSelectionStyle)
/// must conform to.
export interface MouseSelectionStyle {
  /// Return a new selection for the mouse gesture that starts with
  /// the event that was originally given to the constructor, and ends
  /// with the event passed here. In case of a plain click, those may
  /// both be the `mousedown` event, in case of a drag gesture, the
  /// latest `mousemove` event will be passed.
  ///
  /// When `extend` is true, that means the new selection should, if
  /// possible, extend the start selection. If `multiple` is true, the
  /// new selection should be added to the original selection.
  get: (curEvent: MouseEvent, extend: boolean, multiple: boolean) => EditorSelection
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
  update: (update: ViewUpdate) => boolean | void
}

export type MakeSelectionStyle = (view: EditorView, event: MouseEvent) => MouseSelectionStyle | null

function dragScrollSpeed(dist: number) {
  return Math.max(0, dist) * 0.7 + 8
}

function dist(a: MouseEvent, b: MouseEvent) {
  return Math.max(Math.abs(a.clientX - b.clientX), Math.abs(a.clientY - b.clientY))
}

class MouseSelection {
  dragging: null | boolean
  extend: boolean
  multiple: boolean
  lastEvent: MouseEvent
  scrollParents: {x?: HTMLElement, y?: HTMLElement}
  scrollSpeed = {x: 0, y: 0}
  scrolling = -1

  constructor(private view: EditorView,
              private startEvent: MouseEvent,
              private style: MouseSelectionStyle,
              private mustSelect: boolean) {
    this.lastEvent = startEvent
    this.scrollParents = scrollableParents(view.contentDOM)
    let doc = view.contentDOM.ownerDocument!
    doc.addEventListener("mousemove", this.move = this.move.bind(this))
    doc.addEventListener("mouseup", this.up = this.up.bind(this))

    this.extend = startEvent.shiftKey
    this.multiple = addsSelectionRange(view, startEvent)
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
    let margins = getScrollMargins(this.view)

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
    let {view} = this, selection = this.style.get(event, this.extend, this.multiple)
    if (this.mustSelect || !selection.eqPos(view.state.selection)) // FIXME preserve assoc somehow?
      this.view.dispatch({
        selection,
        userEvent: "select.pointer"
      })
    this.mustSelect = false
  }

  update(update: ViewUpdate) {
    if (update.transactions.some(tr => tr.isUserEvent("input.type")))
      this.disconnect()
    else if (this.style.update(update))
      setTimeout(() => this.select(this.lastEvent), 20)
  }
}

function addsSelectionRange(view: EditorView, event: MouseEvent) {
  let facet = view.state.facet(clickAddsSelectionRange)
  return facet.length ? facet[0](event) : browser.mac ? event.metaKey : event.ctrlKey
}

function dragMovesSelection(view: EditorView, event: MouseEvent) {
  let facet = view.state.facet(dragBehavior)
  return facet.length ? facet[0](event) : browser.mac ? !event.altKey : !event.ctrlKey
}

function isInPrimarySelection(view: EditorView, event: MouseEvent) {
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

function eventBelongsToEditor(view: EditorView, event: Event): boolean {
  if (!event.bubbles) return true
  if (event.defaultPrevented) return false
  for (let node = event.target as DOMNode | null, tile; node != view.contentDOM; node = node.parentNode)
    if (!node || node.nodeType == 11 || (tile = Tile.get(node)) && tile.handleEvent(event, view))
      return false
  return true
}

// FIXME use something less messy?
const handlers: {[key: string]: (view: EditorView, event: any) => boolean} = Object.create(null)
const observers: {[key: string]: (view: EditorView, event: any) => undefined} = Object.create(null)

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

function queryPos(view: EditorView, event: MouseEvent) {
  return view.posAtCoords({x: event.clientX, y: event.clientY})
}

function rangeForClick(view: EditorView, pos: {pos: number, assoc: -1 | 0 | 1}, type: number): EditorSelection {
  if (type == 1) { // Single click
    return EditorSelection.near(view.state, pos.pos, pos.assoc || -1)
  } else if (type == 2) { // Double click
    return view.state.wordAt(pos.pos, pos.assoc || 1)
  } else { // Triple click
    let cx = view.state.doc.resolve(pos.pos), block = cx.textblockParent
    if (block) return EditorSelection.range(block.start, block.end)
    else return EditorSelection.near(view.state, pos.pos, pos.assoc || -1)
  }
}

function basicMouseSelection(view: EditorView, event: MouseEvent) {
  let start = queryPos(view, event), type = event.detail
  let startSel = view.state.selection
  return {
    update(update) {
      if (update.docChanged) {
        start.pos = update.changes.mapPos(start.pos)
        startSel = startSel.map(update.changes)
      }
    },
    get(event, extend) {
      let cur = queryPos(view, event), {from, to} = rangeForClick(view, cur, type)
      if (start.pos != cur.pos && !extend) {
        let startRange = rangeForClick(view, start, type)
        from = Math.min(startRange.from, from)
        to = Math.max(startRange.to, to)
      }
      if (extend)
        return startSel.extend(from, to)
      else if (from == to)
        return EditorSelection.cursor(from, cur.assoc)
      else
        return EditorSelection.range(from, to)
    }
  } as MouseSelectionStyle
}

handlers.dragstart = (view, event: DragEvent) => {
  let {selection} = view.state
  let {inputState} = view
  if (inputState.mouseSelection) inputState.mouseSelection.dragging = true
  inputState.draggedContent = selection

  if (event.dataTransfer) {
    writeClipboard(view.state, selectionSlice(view.state), event.dataTransfer)
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
  // FIXME allow handling of file drops
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
      selection: EditorSelection.range(changes.mapPos(dropPos, -1), changes.mapPos(dropPos, 1)),
      userEvent: del ? "move.drop" : "input.drop"
    })
    view.inputState.draggedContent = null
  }
  return false
}

handlers.paste = (view: EditorView, event: ClipboardEvent) => {
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
      selection: EditorSelection.cursor(changes.mapPos(state.selection.from, 1), -1),
      normalizeSelection: true,
      userEvent: "input.paste",
      scrollIntoView: true
    })
  }
  return true
}

function selectionSlice(state: EditorState) { // FIXME smarter primitive?
  return state.doc.slice(state.selection.from, state.selection.to)
}

handlers.copy = handlers.cut = (view, event: ClipboardEvent) => {
  let {state} = view
  if (!state.selection.empty && event.clipboardData) { // FIXME block-wise copying
    writeClipboard(state, selectionSlice(state), event.clipboardData)
    if (event.type == "cut" && !state.readOnly)
      view.dispatch({
        changes: state.selection.ranges.map(r => ({from: r.from, to: r.to})),
        scrollIntoView: true,
        userEvent: "delete.cut"
      })
  }
  return true
}

observers.focus = view => {
  view.inputState.lastFocusTime = Date.now()
  // When focusing reset the scroll position, move it back to where it was
  if (!view.scrollDOM.scrollTop && (view.inputState.lastScrollTop || view.inputState.lastScrollLeft)) {
    view.scrollDOM.scrollTop = view.inputState.lastScrollTop
    view.scrollDOM.scrollLeft = view.inputState.lastScrollLeft
  }
  // FIXME make sure wg-focused class is added
}

observers.blur = view => {
  view.observer.clearSelectionRange()
}

observers.compositionstart = observers.compositionupdate = (view, event: CompositionEvent) => {
  if (!view.inputState.composing) {
    view.inputState.composing = {changes: 0, target: null}

    let wrap: readonly Prop<any>[] | null = null
    if (!view.inputState.composing.changes && !event.data) {
      let sel = view.state.sel, props = sel.props || sel.from.props()
      if (sel.empty && (sel.props || !sel.head.inText && sel.head.index) &&
          !eqArray(sel.head.nodeBefore?.tag.props, props))
        wrap = props
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

function findCompositionTarget(view: EditorView, prev: Text | null) {
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
  wrapCursor?: readonly Prop<any>[] | null
}

export function getCompositionInfo(view: EditorView): CompositionInfo | null {
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
  let value = target.nodeValue!
  let oldTile = view.docTile.nearest(target)
  let oldLen = oldTile && oldTile.dom == target ? oldTile.length : 0

  // FIXME use queued transaction mappings?
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

handlers.beforeinput = (view, event: InputEvent) => {
  for (let handler of view.state.facet(inputEventHandler)) // FIXME only do this for some types
    if (handler.event == event.type && handler.run(view)) return true

  if (event.inputType == "insertReplacementText" || event.inputType == "insertText") {
    // Safari will occasionally forget to fire compositionend at the end of a dead-key composition
    if (browser.safari && view.inputState.composing) observers.compositionend(view, event)

    let slice = event.inputType == "insertText"
      ? textSlice(event.data!, view.state.selection.props || view.state.sel.from.props())
      // FIXME why is this in a dataTransfer anyway? Spec says it shouldn't be...
      : readClipboard(view.state, event.dataTransfer!, view.state.sel.head, true)?.slice
    if (slice) {
      let {from, to} = inputEventRange(event, view)
      applyTextChange(view, from, to, slice)
      return true
    }
  } else if (event.inputType == "insertCompositionText") {
    if (!view.inputState.composing)
      view.inputState.composing = {changes: 0, target: null}
    view.inputState.currentComposition = {...inputEventRange(event, view), text: event.data!}
  }

  return false
}

handlers.input = (view, event: InputEvent) => {
  // FIXME do this somewhere else?
  if (event.inputType == "insertCompositionText" && view.inputState.currentComposition) {
    let {from, to, text} = view.inputState.currentComposition
    view.inputState.currentComposition = null
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
    let props = view.state.selection.props || view.state.doc.resolve(to).props()
    view.dispatch({
      changes: {from, to, insert: textSlice(text, props), fit: true},
      selection: anchor > -1 ? {anchor, head} : undefined,
      userEvent: "input.type.compose"
    })
  }
  return false
}

function textSlice(text: string, props: readonly Prop<any>[]) {
  return new Slice([Node.text(text.replace(/\r\n?|\n/g, " "), props)])
}

function inputEventRange(event: InputEvent, view: EditorView) {
  let range = event.getTargetRanges()[0]
  return {from: view.docTile.posFromDOM(range.startContainer, range.startOffset, -1),
          to: view.docTile.posFromDOM(range.endContainer, range.endOffset, 1)}
}

export function applyTextChange(view: EditorView, from: number, to: number, insert: Slice) {
  // FIXME define this more robustly
  view.dispatch({
    changes: {from, to, insert, fit: true},
    selection: {anchor: from + insert.length},
    userEvent: "input.type"
  })
}
