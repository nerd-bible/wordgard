import {EditorSelection, EditorState, SelectionRange} from "@willows/state"
import {Slice, Node, ChangeSet} from "@willows/doc"
import {EditorView} from "./editorview"
import {ViewUpdate, PluginValue, clickAddsSelectionRange, dragMovesSelection as dragBehavior,
        logException, mouseSelectionStyle, PluginInstance, getScrollMargins, inputEventHandler} from "./extension"
import browser from "./browser"
import {getSelection, dispatchKey, scrollableParents, DOMNode} from "./dom"
import {readClipboard, writeClipboard} from "./clipboard"

export class InputState {
  shiftKey = false
  lastKeyCode: number = 0
  lastKeyTime: number = 0
  lastTouchTime = 0
  lastFocusTime = 0
  lastScrollTop = 0
  lastScrollLeft = 0

  // On iOS, some keys need to have their default behavior happen
  // (after which we retroactively handle them and reset the DOM) to
  // avoid messing up the virtual keyboard state.
  pendingIOSKey: undefined | {key: string, keyCode: number} | KeyboardEvent = undefined

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

  // -1 means not in a composition. Otherwise, this counts the number
  // of changes made during the composition. The count is used to
  // avoid treating the start state of the composition, before any
  // changes have been made, as part of the composition.
  composing = -1
  // Tracks whether the next change should be marked as starting the
  // composition (null means no composition, true means next is the
  // first, false means first has already been marked for this
  // composition)
  compositionFirstChange: boolean | null = null
  // End time of the previous composition
  compositionEndedAt = 0
  // Used in a kludge to detect when an Enter keypress should be
  // considered part of the composition on Safari, which fires events
  // in the wrong order
  compositionPendingKey = false

  mouseSelection: MouseSelection | null = null
  // When a drag from the editor is active, this points at the range
  // being dragged.
  draggedContent: SelectionRange | null = null

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

    // Preventing the default behavior of Enter on iOS makes the
    // virtual keyboard get stuck in the wrong (lowercase)
    // state. So we let it go through, and then, in
    // applyDOMChange, notify key handlers of it and reset to
    // the state they produce.
    let pending
    if (browser.ios && !(event as any).synthetic && !event.altKey && !event.metaKey &&
        ((pending = PendingKeys.find(key => key.keyCode == event.keyCode)) && !event.ctrlKey ||
         EmacsyPendingKeys.indexOf(event.key) > -1 && event.ctrlKey && !event.shiftKey)) {
      this.pendingIOSKey = pending || event
      setTimeout(() => this.flushIOSKey(), 250)
      return true
    }
    if (event.keyCode != 229) this.view.observer.read()
    return false
  }

  flushIOSKey(change?: {from: number, to: number, insert: Text}) {
    let key = this.pendingIOSKey
    if (!key) return false
    // This looks like an autocorrection before Enter
    if (key.key == "Enter" && change && change.from < change.to && /^\S+$/.test(change.insert.toString())) return false
    this.pendingIOSKey = undefined
    return dispatchKey(this.view.contentDOM, key.key, key.keyCode, key instanceof KeyboardEvent ? key : undefined)
  }

  ignoreDuringComposition(event: Event): boolean {
    if (!/^key/.test(event.type)) return false
    if (this.composing > 0) return true
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
    this.view.observer.update(update)
    if (this.mouseSelection) this.mouseSelection.update(update)
    if (this.draggedContent && update.docChanged) this.draggedContent = this.draggedContent.map(update.changes)
    if (update.transactions.length) this.lastKeyCode = this.lastSelectionTime = 0
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

const PendingKeys = [
  {key: "Backspace", keyCode: 8, inputType: "deleteContentBackward"},
  {key: "Enter", keyCode: 13, inputType: "insertParagraph"},
  {key: "Enter", keyCode: 13, inputType: "insertLineBreak"},
  {key: "Delete", keyCode: 46, inputType: "deleteContentForward"}
]

const EmacsyPendingKeys = "dthko"

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
    if (this.mustSelect || !selection.eq(view.state.selection, this.dragging === false))
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
  let {main} = view.state.selection
  if (main.empty) return false
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
  for (let node = event.target as DOMNode | null, cView; node != view.contentDOM; node = node.parentNode)
    if (!node || node.nodeType == 11 || (cView = node.wsElt) && cView.ignoreEvent(event))
      return false
  return true
}

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

observers.touchstart = (view, e) => {
  view.inputState.lastTouchTime = Date.now()
  view.inputState.setSelectionOrigin("select.pointer")
}

observers.touchmove = view => {
  view.inputState.setSelectionOrigin("select.pointer")
}

handlers.mousedown = (view, event: MouseEvent) => {
  view.inputState.shiftKey = event.shiftKey
  view.observer.read()
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

function rangeForClick(view: EditorView, pos: number, bias: -1 | 1, type: number): SelectionRange {
  // FIXME differentiate click types, be smarter
  return EditorSelection.cursor(pos, bias)
}

// Try to determine, for the given coordinates, associated with the
// given position, whether they are related to the element before or
// the element after the position.
function findPositionSide(view: EditorView, pos: number, x: number, y: number): -1 | 1 {
  return -1 // FIXME
}

function queryPos(view: EditorView, event: MouseEvent): {pos: number, bias: 1 | -1} {
  let pos = view.posAtCoords({x: event.clientX, y: event.clientY})
  return {pos, bias: findPositionSide(view, pos, event.clientX, event.clientY)}
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
    get(event, extend, multiple) {
      let cur = queryPos(view, event), removed
      let range = rangeForClick(view, cur.pos, cur.bias, type)
      if (start.pos != cur.pos && !extend) {
        let startRange = rangeForClick(view, start.pos, start.bias, type)
        let from = Math.min(startRange.from, range.from), to = Math.max(startRange.to, range.to)
        range = from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
      }
      if (extend)
        return startSel.replaceRange(startSel.main.extend(range.from, range.to))
      else if (multiple && type == 1 && startSel.ranges.length > 1 && (removed = removeRangeAround(startSel, cur.pos)))
        return removed
      else if (multiple)
        return startSel.addRange(range)
      else
        return EditorSelection.create([range])
    }
  } as MouseSelectionStyle
}

function removeRangeAround(sel: EditorSelection, pos: number) {
  for (let i = 0; i < sel.ranges.length; i++) {
    let {from, to} = sel.ranges[i]
    if (from <= pos && to >= pos)
      return EditorSelection.create(sel.ranges.slice(0, i).concat(sel.ranges.slice(i + 1)),
                                    sel.mainIndex == i ? 0 : sel.mainIndex - (sel.mainIndex > i ? 1 : 0))
  }
  return null
}

handlers.dragstart = (view, event: DragEvent) => {
  let {selection: {main: range}} = view.state
  let {inputState} = view
  if (inputState.mouseSelection) inputState.mouseSelection.dragging = true
  inputState.draggedContent = range

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
  let content = readClipboard(view.state, event.dataTransfer,
                              view.state.doc.resolve(view.state.selection.head), false)
  if (content) {
    let dropPos = view.posAtCoords({x: event.clientX, y: event.clientY})
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
  view.observer.read()
  let {state} = view
  let content = readClipboard(state, event.clipboardData,
                              state.doc.resolve(state.selection.head), view.inputState.shiftKey)
  if (content) { // FIXME proper multi-selection pasting
    view.dispatch({
      changes: {from: state.selection.from, to: state.selection.to, insert: content.slice, fit: content.context},
      userEvent: "input.paste",
      scrollIntoView: true
    })
  }
  return true
}

function selectionSlice(state: EditorState) { // FIXME smarter primitive?
  let {main} = state.selection
  return state.doc.slice(main.from, main.to)
}

handlers.copy = handlers.cut = (view, event: ClipboardEvent) => {
  let {state} = view
  if (!state.selection.main.empty && event.clipboardData) { // FIXME block-wise copying
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
  // FIXME make sure ws-focused class is added
}

observers.blur = view => {
  view.observer.clearSelectionRange()
}

observers.compositionstart = observers.compositionupdate = view => {
  if (view.observer.editContext) return // Composition handled by edit context
  if (view.inputState.compositionFirstChange == null)
    view.inputState.compositionFirstChange = true
  if (view.inputState.composing < 0)
    view.inputState.composing = 0
  // FIXME move the cursor into a hidden node
}

observers.compositionend = view => {
  if (view.observer.editContext) return // Composition handled by edit context
  view.inputState.composing = -1
  view.inputState.compositionEndedAt = Date.now()
  view.inputState.compositionFirstChange = null
  // FIXME put cursor back in the regular content
}

observers.contextmenu = view => {
  view.inputState.lastContextMenu = Date.now()
}

function cursorContext(state: EditorState) {
  return state.doc.resolve(state.selection.head)
}

handlers.beforeinput = (view, event: InputEvent) => {
  for (let handler of view.state.facet(inputEventHandler))
    if (handler.event == event.type && handler.run(view)) return true

  if (event.inputType == "insertReplacementText" || event.inputType == "insertText") {
    // Safari will occasionally forget to fire compositionend at the end of a dead-key composition
    if (browser.safari && view.inputState.composing >= 0)
      setTimeout(() => observers.compositionend(view, event), 20)

    let slice = event.inputType == "insertText"
      ? new Slice([Node.text(event.data!.replace(/\r\n?|\n/g, " "),
                             view.state.doc.resolve(view.state.selection.from).props())])
      // FIXME why is this in a dataTransfer anyway?
      : readClipboard(view.state, event.dataTransfer!, cursorContext(view.state), true)?.slice
    let ranges = event.getTargetRanges()
    if (slice && ranges.length) {
      let r = ranges[0]
      let from = view.posAtDOM(r.startContainer, r.startOffset), to = view.posAtDOM(r.endContainer, r.endOffset)
      applyTextChange(view, from, to, slice)
      return true
    }
  }

  return false
}

export function applyTextChange(view: EditorView, from: number, to: number, insert: Slice) {
  let {main} = view.state.selection
  if (from == main.from && to == main.to)
    view.dispatch(view.state.replaceSelection(insert)) // FIXME pass raw text
  else
    view.dispatch({changes: {from, to, insert}})
}
