import {EditorState, Transaction, TransactionSpec, Extension, Prec,
        EditorSelection, SelectionRange, StateEffect, Facet, EditorStateSpec} from "@willows/state"
import {StyleModule, StyleSpec} from "style-mod"

import {DocView} from "./contentview"
import {posAtCoords, coordsAtPos} from "./coords"
import {ViewUpdate, styleModule, contentAttributes, editorAttributes, AttrSource,
        clickAddsSelectionRange, dragMovesSelection, mouseSelectionStyle,
        exceptionSink, updateListener, logException,
        viewPlugin, ViewPlugin, PluginValue, PluginInstance,
        scrollMargins, MeasureRequest, editable, inputHandler, scrollIntoView,
        ScrollTarget, scrollHandler} from "./extension"
import {theme, darkTheme, buildTheme, baseThemeID, baseLightID, baseDarkID, lightDarkIDs, baseTheme} from "./theme"
import {DOMObserver} from "./domobserver"
import {Attrs, updateAttrs, combineAttrs} from "./attributes"
import {InputState} from "./input"
import {ViewState, Direction} from "./viewstate"
import browser from "./browser"
import {Rect, DOMNode, getRoot, ScrollStrategy} from "./dom"

/// The type of object given to the [`EditorView`](#view.EditorView)
/// constructor.
export interface EditorViewSpec extends Partial<EditorStateSpec> {
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
  /// Override the way transactions are
  /// [dispatched](#view.EditorView.dispatch) for this editor view.
  /// Your implementation, if provided, should probably call the
  /// view's [`update` method](#view.EditorView.update).
  dispatchTransactions?: (trs: readonly Transaction[], view: EditorView) => void
}

/// An editor view represents the editor's user interface. It holds
/// the editable DOM surface, and possibly other elements such as
/// panels. It handles events and dispatches state transactions for
/// editing actions.
export class EditorView extends HTMLElement {// FIXME make custom element a member, not the class itself?
  /// The current editor state.
  get state() { return this.viewState.state }

  /// Indicates whether the user is currently composing text via
  /// [IME](https://en.wikipedia.org/wiki/Input_method), and at least
  /// one change has been made in the current composition.
  get composing() { return this.inputState.composing > 0 }

  /// Indicates whether the user is currently in composing state. Note
  /// that on some platforms, like Android, this will be the case a
  /// lot, since just putting the cursor on a word starts a
  /// composition there.
  get compositionStarted() { return this.inputState.composing >= 0 }
  
  private dispatchTransactions: (trs: readonly Transaction[], view: EditorView) => void

  /// The document or shadow root that the view lives in.
  root: DocumentOrShadowRoot = document

  /// @internal
  get win() { return this.ownerDocument.defaultView || window }

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

  /// @internal
  inputState!: InputState
  /// @internal
  viewState: ViewState
  /// @internal
  docView: DocView

  /// @internal
  plugins: PluginInstance[] = []
  private pluginMap: Map<ViewPlugin<any>, PluginInstance | null> = new Map
  private editorAttrs: Attrs = {}
  private contentAttrs: Attrs = {}
  private styleModules!: readonly StyleModule[]
  private connected = false
  private flushing = false

  /// @internal
  observer: DOMObserver

  /// @internal
  flushScheduled: number = -1
  /// @internal
  measureRequests: MeasureRequest<any>[] = []

  /// Construct a new view. You'll want to either provide a `parent`
  /// option, or put `view.dom` into your document after creating a
  /// view, so that the user can see the editor.
  constructor(spec: EditorViewSpec) {
    if (!spec) throw new Error("EditorView cannot be created without providing a configuration")
    super()
    this.contentDOM = document.createElement("div")

    this.scrollDOM = document.createElement("div")
    this.scrollDOM.tabIndex = -1
    this.scrollDOM.className = "ws-scroller"
    this.scrollDOM.appendChild(this.contentDOM)

    this.announceDOM = document.createElement("div")
    this.announceDOM.className = "ws-announced"
    this.announceDOM.setAttribute("aria-live", "polite")

    this.appendChild(this.announceDOM)
    this.appendChild(this.scrollDOM)

    this.dispatchTransactions = spec.dispatchTransactions ||
      ((trs: readonly Transaction[]) => this.update(trs))
    this.dispatch = this.dispatch.bind(this)

    if (!spec.state && !(spec.doc && spec.extensions))
      throw new Error("When EditorViewSpec.state isn't given, the doc and extensions fields must be present")
    this.viewState = new ViewState(spec.state || EditorState.create(spec as EditorStateSpec))
    if (spec.scrollTo && spec.scrollTo.is(scrollIntoView))
      this.viewState.scrollTarget = spec.scrollTo.value.clip(this.viewState.state)
    this.plugins = this.state.facet(viewPlugin).map(spec => new PluginInstance(spec))
    for (let plugin of this.plugins) plugin.update(this)
    this.observer = new DOMObserver(this)
    this.inputState = new InputState(this)
    this.docView = DocView.build(this.state.doc, this.contentDOM)

    this.updateAttrs()

    if (spec.parent) spec.parent.appendChild(this)
  }

  connectedCallback() {
    this.connected = true
    this.root = getRoot(this.parentNode!) || document
    this.mountStyles()
    this.docView.connect()
    this.inputState.connect()
    for (let plugin of this.plugins) plugin.connect(this)
    this.observer.connect()
    this.scheduleFlush()
  }

  disconnectedCallback() {
    this.connected = false
    this.root = document
    this.observer.disconnect()
    for (let plugin of this.plugins) plugin.disconnect(this)
    this.inputState.disconnect()
    this.docView.disconnect()
    if (this.flushScheduled > -1) this.win.cancelAnimationFrame(this.flushScheduled)
  }

  /// All regular editor state updates should go through this. It
  /// takes a transaction, array of transactions, or transaction spec
  /// and updates the view to show the new state produced by that
  /// transaction. Its implementation can be overridden with an
  /// [option](#view.EditorView.constructor^config.dispatchTransactions).
  /// This function is bound to the view instance, so it does not have
  /// to be called as a method.
  ///
  /// Note that when multiple `TransactionSpec` arguments are
  /// provided, these define a single transaction (the specs will be
  /// merged), not a sequence of transactions.
  dispatch(tr: Transaction): void
  dispatch(trs: readonly Transaction[]): void
  dispatch(...specs: TransactionSpec[]): void
  dispatch(...input: (Transaction | readonly Transaction[] | TransactionSpec)[]) {
    let trs = input.length == 1 && input[0] instanceof Transaction ? input as readonly Transaction[]
      : input.length == 1 && Array.isArray(input[0]) ? input[0] as readonly Transaction[]
      : [this.state.update(...input as TransactionSpec[])]
    this.dispatchTransactions(trs, this)
  }

  /// Update the view for the given array of transactions. Updates
  /// will be immediately be reflected in the object's `state`
  /// property, but updating the DOM will be deferred to the next
  /// display update.
  ///
  /// You should usually call [`dispatch`](#view.EditorView.dispatch)
  /// instead, which uses this as a primitive.
  update(transactions: readonly Transaction[]) {
    if (this.flushing)
      throw new Error("Calls to EditorView.update are not allowed while an update is in progress")
    if (!transactions.length) return
    this.scheduleFlush()
    this.viewState.update(transactions)
  }

  /// Reset the view to the given state. (This will cause the entire
  /// document to be redrawn and all view plugins to be reinitialized,
  /// so you should probably only use it when the new state isn't
  /// derived from the old state. Otherwise, use
  /// [`dispatch`](#view.EditorView.dispatch) instead.)
  setState(newState: EditorState) {
    let hadFocus = this.hasFocus
    if (this.connected) for (let plugin of this.plugins) plugin.disconnect(this)
    this.viewState = new ViewState(newState)
    this.plugins = newState.facet(viewPlugin).map(spec => new PluginInstance(spec))
    this.pluginMap.clear()
    if (this.connected) this.docView.disconnect()
    this.inputState.disconnect()
    this.docView = DocView.build(this.state.doc, this.contentDOM)
    if (this.connected) this.docView.connect()
    this.inputState = new InputState(this)
    for (let plugin of this.plugins) {
      plugin.update(this)
      if (this.connected) plugin.connect(this)
    }
    this.mountStyles()
    this.updateAttrs()
    if (hadFocus) this.focus()
    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.flushScheduled < 0)
      this.flushScheduled = this.win.requestAnimationFrame(() => this.flush())
  }

  flush() {
    if (!this.connected) return
    if (this.flushScheduled > -1) this.win.cancelAnimationFrame(this.flushScheduled)
    this.flushScheduled = -1

    // FIXME flush pending DOM selection change?
    // FIXME force full redraw on phrase facet change
    // FIXME avoid unnecessary work
    try {
      this.flushing = true
      if (this.viewState.pendingTransactions.length) {
        let startState = this.viewState.drawnState
        let transactions = this.viewState.takePendingTransactions()
        let update = ViewUpdate.create(this, startState, this.state, transactions)
        this.docView.update(update.state.doc, update.changes)
        // FIXME update selection here, or in docView.update?
        this.updatePlugins(update)
        this.inputState.update(update)
        this.showAnnouncements(update.transactions)
        if (this.state.facet(styleModule) != this.styleModules) this.mountStyles()
        this.updateAttrs()
        for (let listener of this.state.facet(updateListener)) {
          try { listener(update) }
          catch (e) { logException(this.state, e, "update listener") }
        }
      }
      this.measure()
    } finally { this.flushing = false }
  }

  private updatePlugins(update: ViewUpdate) {
    let prevSpecs = update.startState.facet(viewPlugin), specs = update.state.facet(viewPlugin)
    if (prevSpecs != specs) {
      let newPlugins = []
      for (let spec of specs) {
        let found = prevSpecs.indexOf(spec)
        if (found < 0) {
          newPlugins.push(new PluginInstance(spec))
        } else {
          let plugin = this.plugins[found]
          plugin.mustUpdate = update
          newPlugins.push(plugin)
        }
      }
      if (this.connected) {
        for (let plugin of this.plugins)
          if (plugin.mustUpdate != update) plugin.disconnect(this)
        for (let plugin of newPlugins) plugin.connect(this)
      }
      this.plugins = newPlugins
      this.pluginMap.clear()
    } else {
      for (let p of this.plugins) p.mustUpdate = update
    }
    for (let i = 0; i < this.plugins.length; i++) this.plugins[i].update(this)
    if (prevSpecs != specs) this.inputState.ensureHandlers(this.plugins)
  }

  /// @internal
  measure() {
    // FIXME figure out how, precisely, plugins participate in measurement. Do we still need a loop?
    let updated: ViewUpdate | null = null
    for (let i = 0;; i++) {
      let changed = this.viewState.measure(this)
      if (!changed && !this.measureRequests.length && this.viewState.scrollTarget == null) break
      if (i > 5) {
        console.warn(this.measureRequests.length, "Measure loop restarted more than 5 times")
        break
      }
      let measuring: MeasureRequest<any>[] = []
      ;[this.measureRequests, measuring] = [measuring, this.measureRequests]
      let measured = measuring.map(m => {
        try { return m.read(this) }
        catch(e) { logException(this.state, e); return BadMeasure }
      })
      let update = ViewUpdate.create(this, this.state, this.state, []), redrawn = false
      update.flags |= changed
      if (!updated) updated = update
      else updated.flags |= changed
      if (!update.empty) {
        this.updatePlugins(update)
        this.inputState.update(update)
        this.updateAttrs()
        // FIXME this cannot currently cause doc view changes
        // redrawn = this.docView.update(update)
      }
      for (let i = 0; i < measuring.length; i++) if (measured[i] != BadMeasure) {
        try {
          let m = measuring[i]
          if (m.write) m.write(measured[i], this)
        } catch(e) { logException(this.state, e) }
      }
      // FIXME if (redrawn) this.docView.updateSelection(true)
      if (!redrawn && this.measureRequests.length == 0) break
    }

    if (updated && !updated.empty)
      for (let listener of this.state.facet(updateListener)) listener(updated)
  }

  /// Get the CSS classes for the currently active editor themes.
  get themeClasses() {
    return baseThemeID + " " +
      (this.state.facet(darkTheme) ? baseDarkID : baseLightID) + " " +
      this.state.facet(theme)
  }

  private updateAttrs() {
    let editorAttrs = attrsFromFacet(this, editorAttributes, {
      class: "ws-editor" + (this.hasFocus ? " ws-focused " : " ") + this.themeClasses
    })
    let contentAttrs: Attrs = {
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      translate: "no",
      contenteditable: !this.state.facet(editable) ? "false" : "true",
      class: "ws-content",
      role: "textbox",
      "aria-multiline": "true"
    }
    if (this.state.readOnly) contentAttrs["aria-readonly"] = "true"
    attrsFromFacet(this, contentAttributes, contentAttrs)

    let changed = this.observer.ignore(() => {
      let changedContent = updateAttrs(this.contentDOM, this.contentAttrs, contentAttrs)
      let changedEditor = updateAttrs(this, this.editorAttrs, editorAttrs)
      return changedContent || changedEditor
    })
    this.editorAttrs = editorAttrs
    this.contentAttrs = contentAttrs
    return changed
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

  /// Schedule a layout measurement, optionally providing callbacks to
  /// do custom DOM measuring followed by a DOM write phase. Using
  /// this is preferable reading DOM layout directly from, for
  /// example, an event handler, because it'll make sure measuring and
  /// drawing done by other components is synchronized, avoiding
  /// unnecessary DOM layout computations.
  requestMeasure<T>(request?: MeasureRequest<T>) {
    if (this.flushScheduled < 0 && !this.flushing) this.scheduleFlush()
    if (request) {
      if (this.measureRequests.indexOf(request) > -1) return
      if (request.key != null) for (let i = 0; i < this.measureRequests.length; i++) {
        if (this.measureRequests[i].key === request.key) {
          this.measureRequests[i] = request
          return
        }
      }
      this.measureRequests.push(request)
    }
  }

  /// Get the value of a specific plugin, if present. Note that
  /// plugins that crash can be dropped from a view, so even when you
  /// know you registered a given plugin, it is recommended to check
  /// the return value of this method.
  plugin<T extends PluginValue>(plugin: ViewPlugin<T>): T | null {
    let known = this.pluginMap.get(plugin)
    if (known === undefined || known && known.spec != plugin)
      this.pluginMap.set(plugin, known = this.plugins.find(p => p.spec == plugin) || null)
    return known && known.update(this).value as T
  }

  /// If the editor is transformed with CSS, this provides the scale
  /// along the X axis. Otherwise, it will just be 1. Note that
  /// transforms other than translation and scaling are not supported.
  get scaleX() { return this.viewState.scaleX }

  /// Provide the CSS transformed scale along the Y axis.
  get scaleY() { return this.viewState.scaleY }

  /// Move a cursor position by one [grapheme
  /// cluster](#state.findClusterBreak) or structural cursor position.
  /// `forward` determines whether the motion is away from the line
  /// start, or towards it. In bidirectional text, a textblock is
  /// traversed in visual order, using the editor's [text
  /// direction](#view.EditorView.textDirection). If there is no
  /// cursor position beyond the given start position, the original
  /// position is returned.
  moveHorizontally(start: SelectionRange, forward: boolean) {
    //return moveByChar(this, start, forward)
  }

  /// Move a cursor position across the next word or, if there is no
  /// word ahead of it, move it by a single cursor position.
  moveByWord(start: SelectionRange, forward: boolean) {
    //return moveByChar(this, start, forward, initial => byGroup(this, start.head, initial))
  }

  /// Move to the next line boundary in the given direction. If
  /// `includeWrap` is true, line wrapping is on, and there is a
  /// further wrap point on the current line, the wrap point will be
  /// returned. Otherwise this function will return the start or end
  /// of the line.
  moveToLineBoundary(start: SelectionRange, forward: boolean, includeWrap = true) {
    //return moveToLineBoundary(this, start, forward, includeWrap)
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
  moveVertically(start: SelectionRange, forward: boolean, distance?: number) {
  //  return moveVertically(this, start, forward, distance)
  }

  /// Find the DOM parent node and offset (child offset if `node` is
  /// an element, character offset when it is a text node) at the
  /// given document position.
  domAtPos(pos: number, assoc: -1 | 1 = -1): {node: DOMNode, offset: number} {
    let viewPos = this.docView.resolve(pos, assoc)
    return {node: viewPos.node, offset: viewPos.offset}
  }

  /// Find the document position at the given DOM node. Can be useful
  /// for associating positions with DOM events. Will raise an error
  /// when `node` isn't part of the editor content.
  posAtDOM(node: DOMNode, offset: number = 0) {
    return this.docView.posFromDOM(node, offset, 1)
  }

  /// Get the document position at the given screen coordinates.
  posAtCoords(coords: {x: number, y: number}): number {
    return posAtCoords(this, coords)
  }

  /// Get the screen coordinates at the given document position.
  /// `side` determines whether the coordinates are based on the
  /// element before (-1) or after (1) the position (if no element is
  /// available on the given side, the method will transparently use
  /// another strategy to get reasonable coordinates).
  coordsAtPos(pos: number, assoc: -1 | 1 = -1): Rect {
    return coordsAtPos(this, pos, assoc)
  }

  /// Return the rectangle around a given character. If `pos` does not
  /// point in front of a character, this will return null. For space
  /// characters that are a line wrap point, this will return the
  /// position before the line break.
  coordsForChar(pos: number) {
    // return this.docView.coordsForChar(pos)
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
    return (this.ownerDocument.hasFocus() || browser.safari && this.inputState?.lastContextMenu > Date.now() - 3e4) &&
      this.root.activeElement == this.contentDOM
  }

  /// Put focus on the editor.
  focus() {
    this.observer.ignore(() => {
      this.contentDOM.focus({preventScroll: true})
      // FIXME sync selection
    })
  }

  /// Returns an effect that can be
  /// [added](#state.TransactionSpec.effects) to a transaction to
  /// cause it to scroll the given position or range into view.
  static scrollIntoView(pos: number | SelectionRange, options: {
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

  /// A facet that can be used to register a function to be called
  /// every time the view updates.
  static updateListener = updateListener

  /// Facet that controls whether the editor content DOM is editable.
  /// When its highest-precedence value is `false`, the element will
  /// not have its `contenteditable` attribute set. (Note that this
  /// doesn't affect API calls that change the editor content, even
  /// when those are bound to keys or buttons. See the
  /// [`readOnly`](#state.EditorState.readOnly) facet for that.)
  static editable = editable

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
  /// `&.ws-focused`.
  ///
  /// When `dark` is set to true, the theme will be marked as dark,
  /// which will cause the `&dark` rules from [base
  /// themes](#view.EditorView^baseTheme) to be used (as opposed to
  /// `&light` when a light theme is active).
  static theme(spec: {[selector: string]: StyleSpec}, options?: {dark?: boolean}): Extension {
    let prefix = StyleModule.newName()
    let result = [theme.of(prefix), styleModule.of(buildTheme(`.${prefix}`, spec))]
    if (options && options.dark) result.push(darkTheme.of(true)) // FIXME less implicit?
    return result
  }

  /// This facet records whether a dark theme is active. The extension
  /// returned by [`theme`](#view.EditorView^theme) automatically
  /// includes an instance of this when the `dark` option is set to
  /// true.
  static darkTheme = darkTheme

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

  static {
    // Need to register a name before browsers let you instantiate a
    // custom element. Try multiple names in case multiple versions of
    // the library are loaded.
    for (let i = 0;; i++) {
      let name = "willows-editor" + (i ? "-" + i : "")
      if (!customElements.get(name)) {
        customElements.define(name, EditorView)
        break
      }
    }
  }
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

const BadMeasure = {}

function attrsFromFacet(view: EditorView, facet: Facet<AttrSource>, base: Attrs) {
  for (let sources = view.state.facet(facet), i = sources.length - 1; i >= 0; i--) {
    let source = sources[i], value = typeof source == "function" ? source(view) : source
    if (value) combineAttrs(value, base)
  }
  return base
}
