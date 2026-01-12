import {EditorState, Transaction, Extension, Prec,
        EditorSelection, StateEffect, Facet} from "wordgard/state"
import {ChangeSet} from "wordgard/doc"
import {StyleModule, StyleSpec} from "style-mod"

import {DocTile} from "./tile"
import {coordsAtPos} from "./coords"
import {ViewUpdate, styleModule, contentAttributes, editorAttributes, AttrSource,
        clickAddsSelectionRange, dragMovesSelection, mouseSelectionStyle,
        exceptionSink, beforeUpdate, afterUpdate, logException,
        viewPlugin, ViewPlugin, PluginValue, PluginInstance,
        scrollMargins, editable, inputHandler, scrollIntoView,
        ScrollTarget, scrollHandler, getScrollMargins} from "./extension"
import {clipboardOutputFilter, clipboardOutputHTMLFilter, clipboardOutputTextFilter,
        clipboardInputFilter, clipboardInputHTMLFilter, clipboardInputTextFilter,
        clipboardTextParser, clipboardTextSerializer} from "./clipboard"
import {theme, darkTheme, buildTheme, baseThemeID, baseLightID, baseDarkID, lightDarkIDs, baseTheme} from "./theme"
import {DOMObserver} from "./domobserver"
import {Attrs, updateAttrs, combineAttrs} from "./attributes"
import {InputState, getCompositionInfo, isFocusChange} from "./input"
import {ViewState, Direction} from "./viewstate"
import browser from "./browser"
import {DOMNode, getRoot, ScrollStrategy, clearScratchRange, scrollRectIntoView} from "./dom"
import {setDOMSelection, moveVertically, moveToLineBoundary} from "./selection"
import {cursorBlinkRate} from "./drawcursor"

// FIXME use custom elements rather than classes to target CSS?

/// The type of object given to the [`EditorView`](#view.EditorView)
/// constructor.
export interface EditorViewSpec extends Partial<EditorState.Spec> {
  /// The view's initial state. If not given, a new state is created
  /// by passing this configuration object to
  /// [`EditorState.create`](#state.EditorState^create), using its
  /// `doc`, `selection`, and `extensions` field (if provided).
  state?: EditorState,
  /// When given, the editor is immediately appended to the given
  /// element on creation. (Otherwise, you'll have to place the view
  /// element in the document yourself.)
  parent?: Element | DocumentFragment
  /// Pass an effect created with
  /// [`EditorView.scrollIntoView`](#view.EditorView^scrollIntoView) or
  /// [`EditorView.scrollSnapshot`](#view.EditorView.scrollSnapshot)
  /// here to set an initial scroll position.
  scrollTo?: StateEffect<any>,
}

// FIXME less generic name?

/// An editor view represents the editor's user interface. It holds
/// the editable DOM surface, and possibly other elements such as
/// panels. It handles events and dispatches state transactions for
/// editing actions.
export class EditorView {
  /// The current editor state.
  get state() { return this.viewState.state }

  /// @internal
  get flushedState() { return this.viewState.flushedState }

  /// Indicates whether the user is currently composing text via
  /// [IME](https://en.wikipedia.org/wiki/Input_method), and at least
  /// one change has been made in the current composition.
  get composing() { return !!this.inputState.composing }

  /// Indicates whether the user is currently in composing state. Note
  /// that on some platforms, like Android, this will be the case a
  /// lot, since just putting the cursor on a word starts a
  /// composition there.
  get compositionStarted() { return this.inputState.composing && this.inputState.composing.changes > 0 }
  
  /// The document or shadow root that the view lives in.
  root: DocumentOrShadowRoot = document

  /// @internal
  get win() { return this.dom.ownerDocument.defaultView || window }

  /// The outer DOM element that represents the editor.
  readonly dom: HTMLElement

  /// The DOM element that can be styled to scroll. (Note that it may
  /// not have been, so you can't assume this is scrollable.)
  readonly scrollDOM: HTMLElement

  /// The editable DOM element holding the editor content. You should
  /// not, usually, interact with this content directly though the
  /// DOM, since the editor will immediately undo most of the changes
  /// you make. Instead, [dispatch](#view.EditorView.dispatch)
  /// [transactions](#state.Transaction) to modify content, and
  /// [decorations](#view.Decoration) to style it.
  readonly contentDOM: HTMLElement

  private announceDOM: HTMLElement

  private id = "wg-editor-" + Math.floor(Math.random() * 0xffffff).toString(16)

  /// @internal
  inputState!: InputState
  /// @internal
  viewState: ViewState
  /// @internal
  docTile!: DocTile

  /// @internal
  plugins: PluginInstance[] = []
  private pluginMap: Map<ViewPlugin<any>, PluginInstance | null> = new Map
  private editorAttrs: Attrs = {}
  private contentAttrs: Attrs = {}
  private styleModules!: readonly StyleModule[]

  /// @internal
  connected = false
  private flushing = false
  private willFlush = false
  /// @internal
  lastFlush = Date.now()
  private defaultDarkTheme = false

  /// @internal
  observer: DOMObserver

  /// @internal
  readRequests: ((view: EditorView) => void)[] = []
  /// @internal
  writeRequests: ((view: EditorView) => void)[] = []

  /// Construct a new view. You'll want to either provide a `parent`
  /// option, or put `view.dom` into your document after creating a
  /// view, so that the user can see the editor.
  constructor(spec: EditorViewSpec) {
    this.flush = this.flush.bind(this)
    this.dispatch = this.dispatch.bind(this)

    this.dom = createWrapElement(this)

    this.contentDOM = document.createElement("div")

    this.scrollDOM = document.createElement("div")
    this.scrollDOM.tabIndex = -1
    this.scrollDOM.className = "wg-scroller"
    this.scrollDOM.appendChild(this.contentDOM)

    this.announceDOM = document.createElement("div")
    this.announceDOM.className = "wg-announced"
    this.announceDOM.setAttribute("aria-live", "polite")

    this.dom.appendChild(this.announceDOM)
    this.dom.appendChild(this.scrollDOM)

    if (!spec.state && !spec.doc)
      throw new Error("When EditorViewSpec.state isn't given, the doc field must be present")
    this.viewState = new ViewState(spec.state || EditorState.create(spec as EditorState.Spec))
    if (spec.scrollTo && spec.scrollTo.is(scrollIntoView))
      this.viewState.scrollTarget = spec.scrollTo.value.clip(this.viewState.state)
    this.plugins = this.state.facet(viewPlugin).map(spec => new PluginInstance(spec))
    for (let plugin of this.plugins) plugin.update(this)
    this.observer = new DOMObserver(this)
    this.inputState = new InputState(this)
    this.observer.ignore(() => {
      this.docTile = DocTile.create(this.state, this.contentDOM)
      this.updateAttrs()
    })

    if (spec.parent) spec.parent.appendChild(this.dom)
  }

  setConnected(value: boolean) {
    if (value == this.connected) return
    this.connected = value
    if (value) {
      this.root = getRoot(this.dom.parentNode!) || document
      this.mountStyles()
      this.inputState.connect()
      if (!this.viewState.initialized) this.viewState.initialMeasure(this)
      for (let plugin of this.plugins) plugin.connect(this)
      this.observer.connect()
      if (this.viewState.pending.length || this.readRequests.length || this.writeRequests.length)
        this.scheduleFlush()
    } else {
      this.root = document
      this.observer.disconnect()
      for (let plugin of this.plugins) plugin.disconnect(this)
      this.inputState.disconnect()
      this.docTile.destroyDropped(new Map)
      clearScratchRange()
    }
  }

  /// All editor state updates go through this. It takes a transaction
  /// or transaction spec and updates the view to show the new state
  /// produced by that transaction. This function is bound to the view
  /// instance, so it does not have to be called as a method.
  ///
  /// Note that when multiple `TransactionSpec` values are provided,
  /// these define a single transaction (the specs will be merged),
  /// not a sequence of transactions.
  dispatch(tr: Transaction): void
  dispatch(...specs: Transaction.Spec[]): void
  dispatch(...input: (Transaction | Transaction.Spec)[]) {
    if (input.length == 1 && input[0] instanceof Transaction) this.update(input[0])
    else this.update(this.state.update(...input as Transaction.Spec[]))
  }

  /// Update the view for the given transaction. Updates
  /// will be immediately be reflected in the object's `state`
  /// property, but updating the DOM will be deferred to the next
  /// display update.
  ///
  /// You should usually call [`dispatch`](#view.EditorView.dispatch)
  /// instead, which uses this as a primitive.
  update(transaction: Transaction) {
    if (this.flushing) throw new Error("Cannot dispatch new updates during the editor flush phase")
    this.viewState.update(transaction)
    this.scheduleFlush()
  }

  scheduleFlush() {
    if (!this.willFlush && !this.flushing && this.connected) {
      this.win.queueMicrotask(this.flush)
      this.willFlush = true
    }
  }

  flush() {
    if (!this.connected || this.inputState.currentComposition) return
    this.observer.pollSelection()
    let {flushedState, state} = this.viewState
    let mainUpdate = ViewUpdate.create(this, flushedState, state, this.viewState.pending)
    for (let hook of state.facet(beforeUpdate)) {
      hook(mainUpdate)
      if (mainUpdate.transactions.length != this.viewState.pending.length)
        mainUpdate = ViewUpdate.create(this, flushedState, state = this.viewState.state, this.viewState.pending)
    }

    // FIXME avoid unnecessary work
    this.willFlush = false
    this.flushing = true
    this.lastFlush = Date.now()
    let domChanges = this.observer.takeDirty()
    this.viewState.flush()
    try {
      this.observer.ignore(() => this.runUpdate(mainUpdate, domChanges))
      domChanges = null
      for (let i = 0;; i++) {
        if (i > 5) {
          console.warn("Editor flush loop restarted more than 5 times")
          break
        }
        let write = this.writeRequests
        this.writeRequests = []
        for (let f of write) f(this)
        let flags = this.viewState.measure(this)
        let read = this.readRequests
        this.readRequests = []
        for (let f of read) f(this)
        if (!flags && !this.writeRequests.length) break
        mainUpdate.flags |= flags
        if (flags) this.runUpdate(ViewUpdate.create(this, state, state, [], flags), null)
      }
    } finally { this.flushing = false }
    if (this.viewState.scrollTarget) {
      this.scrollTo(this.viewState.scrollTarget)
      this.viewState.scrollTarget = null
    }
    if (!mainUpdate.empty) for (let listener of this.state.facet(afterUpdate)) {
      try { listener(mainUpdate) }
      catch (e) { logException(this.state, e, "update listener") }
    }
  }

  private scrollTo(target: ScrollTarget) {
    for (let handler of this.state.facet(scrollHandler)) {
      try { if (handler(this, target.range, target)) return true }
      catch(e) { logException(this.state, e, "scroll handler") }
    }

    let {range} = target
    let rect = this.coordsAtPos(range.head, range.empty ? range.assoc || -1 : range.head > range.anchor ? -1 : 1)
    if (!range.empty) {
      let other = this.coordsAtPos(range.anchor, range.anchor > range.head ? -1 : 1)
      let left = Math.min(rect.left, other.left), top = Math.min(rect.top, other.top)
      rect = new DOMRect(left, top, Math.max(rect.right, other.right) - left, Math.max(rect.bottom, other.bottom) - top)
    }

    let margins = getScrollMargins(this)
    let targetRect = new DOMRect(rect.left + margins.left, rect.top + margins.top,
                                 rect.width - margins.left - margins.right, rect.height - margins.top - margins.bottom)
    let {offsetWidth, offsetHeight} = this.scrollDOM
    scrollRectIntoView(this.scrollDOM, targetRect, range.head < range.anchor ? -1 : 1,
                       target.x, target.y,
                       Math.max(Math.min(target.xMargin, offsetWidth), -offsetWidth),
                       Math.max(Math.min(target.yMargin, offsetHeight), -offsetHeight),
                       this.state.textDirection() == Direction.LTR)
  }

  private runUpdate(update: ViewUpdate, domChanges: ChangeSet.Sections | null) {
    let composition = this.composing ? getCompositionInfo(this) : null
    let changes = domChanges ? ChangeSet.composeSections(domChanges, update.changes.sections) : update.changes.sections
    let prevDocTile = this.docTile
    this.docTile = prevDocTile.update(update.state, changes, composition)
    
    if ((composition?.wrapCursor || !composition &&
        (changes.length && !(changes.length == 2 && changes[1] == -1) || update.selectionSet)) && this.hasFocus)
      setDOMSelection(this)
    this.observer.clear()
    if (!update.empty) {
      this.updatePlugins(update)
      this.inputState.update(update)
      this.showAnnouncements(update.transactions)
      if (this.state.facet(styleModule) != this.styleModules) this.mountStyles()
      this.updateAttrs()
    }
    if (this.docTile != prevDocTile) for (let plugin of this.plugins) plugin.docViewUpdate(this)
  }

  private updatePlugins(update: ViewUpdate) {
    let specs = update.state.facet(viewPlugin)
    let configChange = specs != update.startState.facet(viewPlugin)
    if (configChange) {
      let newPlugins = []
      for (let spec of specs) {
        let found = this.plugins.findIndex(p => p.spec == spec)
        if (found < 0) {
          let plugin = new PluginInstance(spec)
          newPlugins.push(plugin)
          if (this.connected) plugin.connect(this)
        } else {
          let plugin = this.plugins[found]
          plugin.mustUpdate = update
          newPlugins.push(plugin)
        }
      }
      for (let plugin of this.plugins) if (!newPlugins.includes(plugin)) plugin.destroy(this)
      this.plugins = newPlugins
      this.pluginMap.clear()
    } else {
      for (let p of this.plugins) p.mustUpdate = update
    }
    for (let i = 0; i < this.plugins.length; i++) this.plugins[i].update(this)
    if (configChange) this.inputState.ensureHandlers(this.plugins)
  }

  /// Get the CSS classes for the currently active editor themes.
  get themeClasses() {
    return baseThemeID + " " +
      (this.state.facet(darkTheme) ?? this.defaultDarkTheme ? baseDarkID : baseLightID) + " " +
      this.state.facet(theme)
  }

  private updateAttrs() {
    let editorAttrs = attrsFromFacet(this, editorAttributes, {
      class: "wg-editor" + (this.hasFocus ? " wg-focused " : " ") + this.themeClasses,
      id: this.id
    })
    let contentAttrs: Attrs = {
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      translate: "no",
      contenteditable: !this.state.facet(editable) ? "false" : "true",
      class: "wg-content",
      role: "textbox",
      "aria-multiline": "true"
    }
    if (this.state.readOnly) contentAttrs["aria-readonly"] = "true"
    attrsFromFacet(this, contentAttributes, contentAttrs)

    let changedContent = updateAttrs(this.contentDOM, this.contentAttrs, contentAttrs)
    let changedEditor = updateAttrs(this.dom, this.editorAttrs, editorAttrs)
    this.editorAttrs = editorAttrs
    this.contentAttrs = contentAttrs
    return changedContent || changedEditor
  }

  private showAnnouncements(trs: readonly Transaction[]) {
    let first = true
    for (let tr of trs) for (let effect of tr.effects) if (effect.is(EditorView.announce)) {
      if (first) this.announceDOM.textContent = ""
      first = false
      let div = this.announceDOM.appendChild(document.createElement("div"))
      div.textContent = effect.value
    }
  }

  private mountStyles() {
    this.styleModules = this.state.facet(styleModule)
    let nonce = this.state.facet(EditorView.cspNonce)
    StyleModule.mount(this.root, this.styleModules.concat(baseTheme).reverse(), nonce ? {nonce} : undefined)
  }

  /// Schedule a function that needs to read from the (flushed) DOM.
  requestDOMRead(read: (view: EditorView) => void) { // FIXME naming
    this.scheduleFlush()
    if (this.readRequests.indexOf(read) < 0) this.readRequests.push(read)
  }

  requestDOMWrite(write: (view: EditorView) => void) {
    this.scheduleFlush()
    if (this.writeRequests.indexOf(write) < 0) this.writeRequests.push(write)
  }

  /// Get the value of a specific plugin, if present. Note that
  /// plugins that crash can be dropped from a view, so even when you
  /// know you registered a given plugin, it is recommended to check
  /// the return value of this method.
  plugin<T extends PluginValue>(plugin: ViewPlugin<T>): T | null {
    let known = this.pluginMap.get(plugin)
    if (known === undefined || known && known.spec != plugin)
      this.pluginMap.set(plugin, known = this.plugins.find(p => p.spec == plugin && !p.deactivated) || null)
    return known && known.update(this).value as T
  }

  /// If the editor is transformed with CSS, this provides the scale
  /// along the X axis. Otherwise, it will just be 1. Note that
  /// transforms other than translation and scaling are not supported.
  get scaleX() { return this.viewState.scaleX }

  /// Provide the CSS transformed scale along the Y axis.
  get scaleY() { return this.viewState.scaleY }

  private checkFlushed() {
    if (!this.connected)
      throw new Error("Editor is not connected to the DOM")
    if (this.willFlush && (this.viewState.pending.some(tr => tr.docChanged) || this.observer.dirty))
      throw new Error("Trying to read from unflushed editor DOM")
  }

  /// Move to the end or start of the (wrapped) line. If the given
  /// position isn't in a textblock, this will return null.
  moveToLineBoundary(start: EditorSelection, forward: boolean) {
    this.checkFlushed()
    return moveToLineBoundary(this, start, forward)
  }

  /// Move a cursor position vertically. When `distance` isn't given,
  /// it defaults to moving to the vertical element below or above the
  /// start position. Otherwise, `distance` should provide a positive
  /// distance in pixels.
  ///
  /// When `start` has a
  /// [`goalColumn`](#state.SelectionRange.goalColumn), the vertical
  /// motion will use that as a target horizontal position. Otherwise,
  /// the cursor's own horizontal position is used. The returned
  /// cursor will have its goal column set to whichever column was
  /// used.
  moveVertically(start: EditorSelection, forward: boolean, distance?: number) {
    this.checkFlushed()
    return moveVertically(this, start, forward, distance)
  }

  /// Find the DOM parent node and offset (child offset if `node` is
  /// an element, character offset when it is a text node) at the
  /// given document position.
  domAtPos(pos: number, assoc: -1 | 1 = -1): {node: DOMNode, offset: number} {
    this.checkFlushed()
    let viewPos = this.docTile.resolve(pos, assoc)
    return {node: viewPos.tile.dom, offset: viewPos.offset}
  }

  /// Find the document position at the given DOM node. Can be useful
  /// for associating positions with DOM events. Will raise an error
  /// when `node` isn't part of the editor content.
  posAtDOM(node: DOMNode, offset: number = 0) {
    this.checkFlushed()
    return this.docTile.posFromDOM(node, offset, 1)
  }

  /// Get the document position at the given screen coordinates.
  posAtCoords(coords: {x: number, y: number}): {pos: number, assoc: -1 | 0 | 1} {
    this.checkFlushed()
    let elt = ((this.root as any).elementFromPoint ? this.root : this.dom.ownerDocument)
                .elementFromPoint(coords.x, coords.y) as HTMLElement
    let tile = (elt && this.docTile.nearest(elt)) || this.docTile
    return tile.posAtCoords(this.state, coords.x, coords.y)
  }

  /// Get the screen coordinates at the given document position.
  /// `side` determines whether the coordinates are based on the
  /// element before (-1) or after (1) the position (if no element is
  /// available on the given side, the method will transparently use
  /// another strategy to get reasonable coordinates).
  coordsAtPos(pos: number, assoc: -1 | 1 = -1): DOMRect {
    this.checkFlushed()
    return coordsAtPos(this, pos, assoc)
  }

  /// Return the rectangle around a given node or character. If there
  /// is no element directly after `pos`, this will return null. For
  /// space characters that are a line wrap point, this will return
  /// the position before the line break.
  coordsForElement(pos: number) {
    this.checkFlushed()
    return this.docTile.coordsForElement(pos)
  }

  /// The text direction
  /// ([`direction`](https://developer.mozilla.org/en-US/docs/Web/CSS/direction)
  /// CSS property) of the editor's content element.
  get textDirection(): Direction { return this.viewState.defaultTextDirection }

  /// Check whether the editor has focus.
  get hasFocus(): boolean {
    // Safari return false for hasFocus when the context menu is open
    // or closing, which leads us to ignore selection changes from the
    // context menu because it looks like the editor isn't focused.
    // This kludges around that.
    return (this.dom.ownerDocument.hasFocus() || browser.safari && this.inputState?.lastContextMenu > Date.now() - 3e4) &&
      this.root.activeElement == this.contentDOM
  }

  /// Put focus on the editor.
  focus() {
    this.observer.ignore(() => {
      this.contentDOM.focus({preventScroll: true})
      setDOMSelection(this)
    })
  }

  /// Returns an effect that can be
  /// [added](#state.TransactionSpec.effects) to a transaction to
  /// cause it to scroll the given position or range into view.
  static scrollIntoView(pos: number | EditorSelection, options: {
    /// By default (`"nearest"`) the position will be vertically
    /// scrolled only the minimal amount required to move the given
    /// position into view. You can set this to `"start"` to move it
    /// to the top of the view, `"end"` to move it to the bottom, or
    /// `"center"` to move it to the center.
    y?: ScrollStrategy,
    /// Effect similar to
    /// [`y`](#view.EditorView^scrollIntoView^options.y), but for the
    /// horizontal scroll position.
    x?: ScrollStrategy,
    /// Extra vertical distance to add when moving something into
    /// view. Not used with the `"center"` strategy. Defaults to 5.
    /// Must be less than the height of the editor.
    yMargin?: number,
    /// Extra horizontal distance to add. Not used with the `"center"`
    /// strategy. Defaults to 5. Must be less than the width of the
    /// editor.
    xMargin?: number,
  } = {}): StateEffect<unknown> {
    return scrollIntoView.of(new ScrollTarget(typeof pos == "number" ? EditorSelection.cursor(pos) : pos,
                                              options.y, options.x, options.yMargin, options.xMargin))
  }

  /// Filter functions provided through this facet will be run on a
  /// slice before it is serialized to the clipboard.
  static clipboardOutputFilter = clipboardOutputFilter

  /// Filter functions provided through this facet will be run on an
  /// HTML string before it put onto the clipboard.
  static clipboardOutputHTMLFilter = clipboardOutputHTMLFilter

  /// This can be used to provide a function that converts a document
  /// slice to a string that is put onto the plain-text clipboard.
  /// Serializers are tried in order of precedence until one returns
  /// a string.
  static clipboardTextSerializer = clipboardTextSerializer

  /// Filter to run on the plain text representation of content put
  /// onto the clipboard.
  static clipboardOutputTextFilter = clipboardOutputTextFilter

  /// Filter functions provided through this facet will be run on a
  /// slice after it is read from the clipboard.
  static clipboardInputFilter = clipboardInputFilter

  /// Filter functions to run on HTML text that is read from the
  /// clipboard.
  static clipboardInputHTMLFilter = clipboardInputHTMLFilter

  /// When the editor reads plain text from the clipboard, this facet
  /// can be used to provide a custom parser. Each provided function
  /// is tried in order of precedence, until one returns a slice.
  static clipboardTextParser = clipboardTextParser

  /// Filter to run on plain text read from the clipboard.
  static clipboardInputTextFilter = clipboardInputTextFilter

  /// This annotation is added to transactions created because the
  /// editor's focused status changed. It holds `true` when the editor
  /// gained focus, `false` when it lost focus.
  static isFocusChange = isFocusChange

  /// Enable or disable tab-focus mode, which disables key bindings
  /// for Tab and Shift-Tab, letting the browser's default
  /// focus-changing behavior go through instead. This is useful to
  /// prevent trapping keyboard users in your editor.
  ///
  /// Without argument, this toggles the mode. With a boolean, it
  /// enables (true) or disables it (false). Given a number, it
  /// temporarily enables the mode until that number of milliseconds
  /// have passed or another non-Tab key is pressed.
  setTabFocusMode(to?: boolean | number) {
    if (to == null)
      this.inputState.tabFocusMode = this.inputState.tabFocusMode < 0 ? 0 : -1
    else if (typeof to == "boolean")
      this.inputState.tabFocusMode = to ? 0 : -1
    else if (this.inputState.tabFocusMode != 0)
      this.inputState.tabFocusMode = Date.now() + to
  }

  /// Facet to add a [style
  /// module](https://github.com/marijnh/style-mod#documentation) to
  /// an editor view. The view will ensure that the module is
  /// mounted in its [document
  /// root](#view.EditorView.constructor^config.root).
  static styleModule = styleModule

  /// Returns an extension that can be used to add DOM event handlers.
  /// The value should be an object mapping event names to handler
  /// functions. For any given event, such functions are ordered by
  /// extension precedence, and the first handler to return true will
  /// be assumed to have handled that event, and no other handlers or
  /// built-in behavior will be activated for it. These are registered
  /// on the [content element](#view.EditorView.contentDOM), except
  /// for `scroll` handlers, which will be called any time the
  /// editor's [scroll element](#view.EditorView.scrollDOM) or one of
  /// its parent nodes is scrolled.
  static domEventHandlers(handlers: DOMEventHandlers<any>): Extension {
    return ViewPlugin.define(() => ({}), {eventHandlers: handlers})
  }

  /// Create an extension that registers DOM event observers. Contrary
  /// to event [handlers](#view.EditorView^domEventHandlers),
  /// observers can't be prevented from running by a higher-precedence
  /// handler returning true. They also don't prevent other handlers
  /// and observers from running when they return true, and should not
  /// call `preventDefault`.
  static domEventObservers(observers: DOMEventHandlers<any>): Extension {
    return ViewPlugin.define(() => ({}), {eventObservers: observers})
  }

  /// An input handler can override the way changes to the editable
  /// DOM content are handled. Handlers are passed the document
  /// positions between which the change was found, and the new
  /// content. When one returns true, no further input handlers are
  /// called and the default behavior is prevented.
  ///
  /// The `insert` argument can be used to get the default transaction
  /// that would be applied for this input. This can be useful when
  /// dispatching the custom behavior as a separate transaction.
  static inputHandler = inputHandler

  /// Scroll handlers can override how things are scrolled into view.
  /// If they return `true`, no further handling happens for the
  /// scrolling. If they return false, the default scroll behavior is
  /// applied. Scroll handlers should never initiate editor updates.
  static scrollHandler = scrollHandler

  /// Allows you to provide a function that should be called when the
  /// library catches an exception from an extension (mostly from view
  /// plugins, but may be used by other extensions to route exceptions
  /// from user-code-provided callbacks). This is mostly useful for
  /// debugging and logging. See [`logException`](#view.logException).
  static exceptionSink = exceptionSink

  // FIXME better names for these (distinguish from .update, use nouns
  // for facet names)

  /// A facet that can be used to register a function to be called
  /// right before the view updates. Any transactions dispatched by
  /// such functions will be included in the update.
  static beforeUpdate = beforeUpdate

  /// A facet that can be used to register a function to be called
  /// after the view updates. Dispatching transactions from such a
  /// function is allowed, but will cause another, separate update to
  /// happen.
  static afterUpdate = afterUpdate

  /// Facet that controls whether the editor content DOM is editable.
  /// When its highest-precedence value is `false`, the element will
  /// not have its `contenteditable` attribute set. (Note that this
  /// doesn't affect API calls that change the editor content, even
  /// when those are bound to keys or buttons. See the
  /// [`readOnly`](#state.EditorState.readOnly) facet for that.)
  static editable = editable

  /// Controls the length of a full cursor blink cycle, in milliseconds.
  /// Defaults to 1200. Can be set to 0 to disable blinking.
  static cursorBlinkRate = cursorBlinkRate

  /// Allows you to influence the way mouse selection happens. The
  /// functions in this facet will be called for a `mousedown` event
  /// on the editor, and can return an object that overrides the way a
  /// selection is computed from that mouse click or drag.
  static mouseSelectionStyle = mouseSelectionStyle

  /// Facet used to configure whether a given selection drag event
  /// should move or copy the selection. The given predicate will be
  /// called with the `mousedown` event, and can return `true` when
  /// the drag should move the content.
  static dragMovesSelection = dragMovesSelection

  /// Facet used to configure whether a given selecting click adds a
  /// new range to the existing selection or replaces it entirely. The
  /// default behavior is to check `event.metaKey` on macOS, and
  /// `event.ctrlKey` elsewhere.
  static clickAddsSelectionRange = clickAddsSelectionRange

  /// Facet that allows extensions to provide additional scroll
  /// margins (space around the sides of the scrolling element that
  /// should be considered invisible). This can be useful when the
  /// plugin introduces elements that cover part of that element (for
  /// example a horizontally fixed gutter).
  static scrollMargins = scrollMargins

  /// Create a theme extension. The first argument can be a
  /// [`style-mod`](https://github.com/marijnh/style-mod#documentation)
  /// style spec providing the styles for the theme. These will be
  /// prefixed with a generated class for the style.
  ///
  /// Because the selectors will be prefixed with a scope class, rule
  /// that directly match the editor's [wrapper
  /// element](#view.EditorView.dom)—to which the scope class will be
  /// added—need to be explicitly differentiated by adding an `&` to
  /// the selector for that element—for example
  /// `&.wg-focused`.
  ///
  /// When `dark` is set to true, the theme will be marked as dark,
  /// which will cause the `&dark` rules from [base
  /// themes](#view.EditorView^baseTheme) to be used (as opposed to
  /// `&light` when a light theme is active).
  // FIXME work out whether we want a theme system at all, and make
  // dark/light integrate properly with client setting
  static theme(spec: {[selector: string]: StyleSpec}): Extension {
    let prefix = StyleModule.newName()
    return [theme.of(prefix), styleModule.of(buildTheme(`.${prefix}`, spec))]
  }

  /// This facet controls whether a dark theme is active, which
  /// determines whether base theme rules with a `&dark` or `&light`
  /// selector are applied. By default, the editor uses a CSS
  /// `prefers-color-scheme: dark` query to determine whether to
  /// enable light or dark mode.
  static darkTheme = darkTheme

  /// @internal
  configureDarkTheme(dark: boolean) {
    if (this.defaultDarkTheme == dark) return
    this.defaultDarkTheme = dark
    if (this.state.facet(darkTheme) == null)
      this.observer.ignore(() => this.updateAttrs())
  }

  /// Create an extension that adds styles to the base theme. Like
  /// with [`theme`](#view.EditorView^theme), use `&` to indicate the
  /// place of the editor wrapper element when directly targeting
  /// that. You can also use `&dark` or `&light` instead to only
  /// target editors with a dark or light theme.
  static baseTheme(spec: {[selector: string]: StyleSpec}): Extension {
    return Prec.lowest(styleModule.of(buildTheme("." + baseThemeID, spec, lightDarkIDs)))
  }

  /// Provides a Content Security Policy nonce to use when creating
  /// the style sheets for the editor. Holds the empty string when no
  /// nonce has been provided.
  static cspNonce = Facet.define<string, string>({combine: values => values.length ? values[0] : ""})

  /// Facet that provides additional DOM attributes for the editor's
  /// editable DOM element.
  static contentAttributes = contentAttributes

  /// Facet that provides DOM attributes for the editor's outer
  /// element.
  static editorAttributes = editorAttributes

  /// State effect used to include screen reader announcements in a
  /// transaction. These will be added to the DOM in a visually hidden
  /// element with `aria-live="polite"` set, and should be used to
  /// describe effects that are visually obvious but may not be
  /// noticed by screen reader users (such as moving to the next
  /// search match).
  static announce = StateEffect.define<string>()

  /// @internal for testing
  static DocTile = DocTile
}

let _wrapElement: {new (view: EditorView): HTMLElement} | null = null

function wrapElementConstructor() {
  let ctor = class extends HTMLElement {
    constructor(readonly view: EditorView) { super() }
    connectedCallback() { this.view.setConnected(true) }
    disconnectedCallback() { this.view.setConnected(false) }
  }
  // Need to register a name before browsers let you instantiate a
  // custom element. Try multiple names in case multiple versions of
  // the library are loaded.
  for (let i = 0;; i++) {
    let name = "wordgard-editor" + (i ? "-" + i : "")
    if (!customElements.get(name)) {
      customElements.define(name, ctor)
      break
    }
  }
  return ctor
}

function createWrapElement(view: EditorView) {
  if (!_wrapElement) _wrapElement = wrapElementConstructor()
  return new _wrapElement(view)
}

/// Helper type that maps event names to event object types, or the
/// `any` type for unknown events.
export interface DOMEventMap extends HTMLElementEventMap {
  [other: string]: any
}

/// Event handlers are specified with objects like this. For event
/// types known by TypeScript, this will infer the event argument type
/// to hold the appropriate event object type. For unknown events, it
/// is inferred to `any`, and should be explicitly set if you want type
/// checking.
export type DOMEventHandlers<This> = {
  [event in keyof DOMEventMap]?: (this: This, event: DOMEventMap[event], view: EditorView) => boolean | void
}

function attrsFromFacet(view: EditorView, facet: Facet<AttrSource>, base: Attrs) {
  for (let sources = view.state.facet(facet), i = sources.length - 1; i >= 0; i--) {
    let source = sources[i], value = typeof source == "function" ? source(view) : source
    if (value) combineAttrs(value, base)
  }
  return base
}
