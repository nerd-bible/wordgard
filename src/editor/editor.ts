import {GardState, Transaction, GardSelection} from "wordgard/state"
import {ChangeSet, Node} from "wordgard/doc"
import {StyleModule, StyleSpec} from "style-mod"

import {DocTile} from "./tile"
import {coordsAtPos} from "./coords"
import {clipboardOutputFilter, clipboardOutputHTMLFilter, clipboardOutputTextFilter,
        clipboardInputFilter, clipboardInputHTMLFilter, clipboardInputTextFilter,
        clipboardTextParser, clipboardTextSerializer} from "./clipboard"
import {theme, darkTheme, buildTheme, baseThemeID, baseLightID, baseDarkID, lightDarkIDs, baseTheme} from "./theme"
import {DOMObserver} from "./domobserver"
import {Attrs, updateAttrs, combineAttrs} from "./attributes"
import {InputState, getCompositionInfo, isFocusChange, mouseSelectionStyle, dragBehavior, pasteHandler} from "./input"
import {ViewState, scrollIntoView, ScrollTarget} from "./viewstate"
import browser from "./browser"
import {DOMNode, getRoot, ScrollStrategy, clearScratchRange, scrollRectIntoView} from "./dom"
import {setDOMSelection, moveVertically, moveToLineBoundary} from "./selection"
import {exceptionSink, logException} from "./util"

const dirCompartment = new GardState.Compartment

/// This class implements the editor's user interface. It holds
/// the editable DOM surface, and possibly other elements such as
/// panels. It handles events and dispatches state transactions for
/// editing actions.
export class Wordgard {
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

  /// The document or shadow root that the editor lives in.
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
  /// you make. Instead, [dispatch](#editor.Wordgard.dispatch)
  /// [transactions](#state.Transaction) to modify content, and
  /// [decorations](#editor.Decoration) to style it.
  readonly contentDOM: HTMLElement

  private announceDOM: HTMLElement

  private id = "wordgard-" + Math.floor(Math.random() * 0xffffff).toString(16)

  /// @internal
  inputState!: InputState
  /// @internal
  viewState: ViewState
  /// @internal
  docTile!: DocTile

  /// @internal
  plugins: PluginInstance[] = []
  private pluginMap: Map<Wordgard.Plugin<any>, PluginInstance | null> = new Map
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
  domReaders: ((wg: Wordgard) => void)[] = []
  /// @internal
  domWriters: ((wg: Wordgard) => void)[] = []

  /// Construct a new editor. You'll want to either provide a `parent`
  /// option, or put the editor's {@link Wordgard.dom | DOM element}
  /// into your document after creating an editor, so that the user
  /// can see it.
  constructor(spec: Wordgard.Spec) {
    this.flush = this.flush.bind(this)
    this.dispatch = this.dispatch.bind(this)

    this.dom = createWrapElement(this)

    this.contentDOM = document.createElement("wg-content")

    this.scrollDOM = document.createElement("wg-scroller")
    this.scrollDOM.tabIndex = -1
    this.scrollDOM.appendChild(this.contentDOM)

    this.announceDOM = document.createElement("wg-announced")
    this.announceDOM.setAttribute("aria-live", "polite")

    this.dom.appendChild(this.announceDOM)
    this.dom.appendChild(this.scrollDOM)

    if (!spec.state && !spec.doc)
      throw new Error("When Wordgard.Spec.state isn't given, the doc field must be present")
    this.viewState = new ViewState(spec.state || GardState.create(spec as GardState.Spec))
    if (spec.scrollTo && spec.scrollTo.is(scrollIntoView))
      this.viewState.scrollTarget = spec.scrollTo.value.clip(this.viewState.state)
    this.plugins = this.state.facet(editorPlugin).map(spec => new PluginInstance(spec))
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
      if (this.viewState.pending.length || this.domReaders.length || this.domWriters.length)
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
  /// or transaction spec and updates the editor to show the new state
  /// produced by that transaction. This function is bound to the editor
  /// instance, so it does not have to be called as a method.
  dispatch(tr: Transaction | Transaction.Spec): void {
    this.update(tr instanceof Transaction ? tr : this.state.update(tr))
  }

  /// Update the editor for the given transaction. Updates
  /// will be immediately be reflected in the object's `state`
  /// property, but updating the DOM will be deferred to the next
  /// display update.
  ///
  /// You should usually call [`dispatch`](#editor.Wordgard.dispatch)
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

  flush(force = false) {
    if ((!this.connected && !force) || this.inputState.pendingComposition) return
    this.observer.pollSelection()
    let {flushedState, state} = this.viewState
    let mainUpdate = Wordgard.Update.create(this, flushedState, state, this.viewState.pending)
    for (let hook of state.facet(Wordgard.beforeUpdate)) {
      hook(mainUpdate)
      if (mainUpdate.transactions.length != this.viewState.pending.length)
        mainUpdate = Wordgard.Update.create(this, flushedState, state = this.viewState.state, this.viewState.pending)
    }

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
        let write = this.domWriters
        this.domWriters = []
        for (let f of write) f(this)
        let flags = this.viewState.measure(this)
        let read = this.domReaders
        this.domReaders = []
        for (let f of read) f(this)
        if (!flags && !this.domWriters.length) break
        mainUpdate.flags |= flags
        if (flags) this.runUpdate(Wordgard.Update.create(this, state, state, [], flags), null)
      }
    } finally { this.flushing = false }
    if (this.viewState.scrollTarget) {
      this.scrollTo(this.viewState.scrollTarget)
      this.viewState.scrollTarget = null
    }
    if (!mainUpdate.empty) for (let listener of this.state.facet(Wordgard.afterUpdate)) {
      try { listener(mainUpdate) }
      catch (e) { logException(this.state, e, "update listener") }
    }
    this.checkDir()
  }

  private scrollTo(target: ScrollTarget) {
    for (let handler of this.state.facet(Wordgard.scrollHandler)) {
      try { if (handler(this, target)) return true }
      catch(e) { logException(this.state, e, "scroll handler") }
    }

    let {from, to, assoc} = target
    let rect = this.coordsAtPos(from, from == to ? assoc : 1)
    if (from != to) {
      let other = this.coordsAtPos(to, -1)
      let left = Math.min(rect.left, other.left), top = Math.min(rect.top, other.top)
      rect = new DOMRect(left, top, Math.max(rect.right, other.right) - left, Math.max(rect.bottom, other.bottom) - top)
    }

    let margins = this.getScrollMargins()
    let targetRect = new DOMRect(rect.left + margins.left, rect.top + margins.top,
                                 rect.width - margins.left - margins.right, rect.height - margins.top - margins.bottom)
    let {offsetWidth, offsetHeight} = this.scrollDOM
    scrollRectIntoView(this.scrollDOM, targetRect, assoc, target.x, target.y,
                       Math.max(Math.min(target.xMargin, offsetWidth), -offsetWidth),
                       Math.max(Math.min(target.yMargin, offsetHeight), -offsetHeight),
                       this.state.textLTR)
  }

  private runUpdate(update: Wordgard.Update, domChanges: ChangeSet.Sections | null) {
    let composition = this.composing ? getCompositionInfo(this) : null
    let changes = domChanges ? ChangeSet.composeSections(domChanges, update.changes.sections) : update.changes.sections
    let prevDocTile = this.docTile
    if (!update.empty) {
      this.updatePlugins(update)
      this.inputState.update(update)
      this.showAnnouncements(update.transactions)
      if (this.state.facet(Wordgard.styleModule) != this.styleModules) this.mountStyles()
      this.updateAttrs()
    }
    this.docTile = prevDocTile.update(update.state, changes, composition)

    if ((composition?.wrapCursor || !composition && (prevDocTile != this.docTile || update.selectionSet)) && this.hasFocus)
      setDOMSelection(this)
    this.observer.clear()
    if (this.docTile != prevDocTile) for (let plugin of this.plugins) plugin.docUpdate(this)
  }

  private updatePlugins(update: Wordgard.Update) {
    let specs = update.state.facet(editorPlugin)
    let configChange = specs != update.startState.facet(editorPlugin)
    if (configChange) {
      let newPlugins: PluginInstance[] = []
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
    let editorAttrs = attrsFromFacet(this, Wordgard.editorAttributes, {
      class: this.themeClasses,
      id: this.id
    })
    let contentAttrs: Attrs = {
      translate: "no",
      contenteditable: !this.state.facet(Wordgard.editable) ? "false" : "true",
      role: "textbox",
      "aria-multiline": "true"
    }
    if (this.state.readOnly) contentAttrs["aria-readonly"] = "true"
    attrsFromFacet(this, Wordgard.contentAttributes, contentAttrs)

    let changedContent = updateAttrs(this.contentDOM, this.contentAttrs, contentAttrs)
    let changedEditor = updateAttrs(this.dom, this.editorAttrs, editorAttrs)
    this.editorAttrs = editorAttrs
    this.contentAttrs = contentAttrs
    return changedContent || changedEditor
  }

  private checkDir() {
    if (this.viewState.styleLTR != this.state.textLTR) {
      let value = GardState.textLTR.of(this.viewState.styleLTR)
      this.dispatch({
        effects: dirCompartment.get(this.state) == null
          ? GardState.appendConfig.of(GardState.prec.highest(dirCompartment.of(value)))
          : dirCompartment.reconfigure(value)
      })
    }
  }

  private showAnnouncements(trs: readonly Transaction[]) {
    let first = true
    for (let tr of trs) for (let effect of tr.effects) if (effect.is(Wordgard.announce)) {
      if (first) this.announceDOM.textContent = ""
      first = false
      let div = this.announceDOM.appendChild(document.createElement("div"))
      div.textContent = effect.value
    }
  }

  private mountStyles() {
    this.styleModules = this.state.facet(Wordgard.styleModule)
    let nonce = this.state.facet(Wordgard.cspNonce)
    StyleModule.mount(this.root, this.styleModules.concat(baseTheme).reverse(), nonce ? {nonce} : undefined)
  }

  /// Schedule a function that needs to read from the (flushed) DOM.
  /// During an editor update, when doing anything that needs to
  /// access the DOM layout, it is important to schedule it with this
  /// method, to avoid forcing unnecessary DOM layouts.
  scheduleDOMRead(read: (wg: Wordgard) => void) {
    this.scheduleFlush()
    if (this.domReaders.indexOf(read) < 0) this.domReaders.push(read)
  }

  /// Schedule a function that needs to modify the DOM. When doing any
  /// kind of DOM mutation that depends on a [DOM
  /// read](#editor.Wordgard.scheduleDOMRead), use this method, so that
  /// read and write phases remain separate.
  scheduleDOMWrite(write: (wg: Wordgard) => void) {
    this.scheduleFlush()
    if (this.domWriters.indexOf(write) < 0) this.domWriters.push(write)
  }

  /// Get the value of a specific plugin, if present. Note that
  /// plugins that crash can be dropped from an editor, so even when you
  /// know you registered a given plugin, it is recommended to check
  /// the return value of this method.
  plugin<T extends Wordgard.Plugin.Value>(plugin: Wordgard.Plugin<T>): T | null {
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
  moveToLineBoundary(start: GardSelection, forward: boolean) {
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
  /// used. If `allowNode` is true, this may return a node selection
  /// on a block node.
  moveVertically(start: GardSelection, forward: boolean, distance?: number, allowNode?: boolean) {
    this.checkFlushed()
    return moveVertically(this, start, forward, distance, allowNode)
  }

  /// Find the DOM parent node and offset (child offset if `node` is
  /// an element, character offset when it is a text node) at the
  /// given document position.
  domAtPos(pos: number, assoc: -1 | 1 = -1): {node: DOMNode, offset: number} {
    this.checkFlushed()
    let tilePos = this.docTile.resolve(pos, assoc)
    return {node: tilePos.tile.dom, offset: tilePos.offset}
  }

  nodeDOM(pos: number): Element | null {
    this.checkFlushed()
    let tile = this.docTile.nodeTile(pos)
    if (!tile || tile.dom.nodeType != 1) return null
    return tile.dom as Element
  }

  /// Find the document position at the given DOM node. Can be useful
  /// for associating positions with DOM events. Will raise an error
  /// when `node` isn't part of the editor content.
  posAtDOM(node: DOMNode, offset: number = 0) {
    this.checkFlushed()
    return this.docTile.posFromDOM(node, offset, 1)
  }

  /// Find the Wordgard node represented by the given DOM node, or one
  /// of its parent nodes, if any. Will not return the outer document node.
  nodeFromDOM(node: Element): {pos: number, node: Node} | null {
    let tile = this.docTile.nearest(node, true)
    return tile && tile != this.docTile ? {pos: tile.posBefore, node: tile.node!} : null
  }

  /// Get the document position at the given screen coordinates.
  posAtCoords(coords: {x: number, y: number}): {pos: number, side: -1 | 1, target: number | null} {
    this.checkFlushed()
    let elt = ((this.root as any).elementFromPoint ? this.root : this.dom.ownerDocument)
                .elementFromPoint(coords.x, coords.y)
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
  get textLTR(): boolean { return this.viewState.styleLTR }

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
  static scrollIntoView(pos: number | GardSelection, options: {
    /// By default (`"nearest"`) the position will be vertically
    /// scrolled only the minimal amount required to move the given
    /// position into view. You can set this to `"start"` to move it
    /// to the top of the editor, `"end"` to move it to the bottom, or
    /// `"center"` to move it to the center.
    y?: ScrollStrategy,
    /// Effect similar to
    /// [`y`](#editor.Wordgard^scrollIntoView^options.y), but for the
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
  } = {}): Transaction.Effect<unknown> {
    let [from, to, assoc]: [number, number, -1 | 1] = typeof pos == "number" ? [pos, pos, -1] :
      [pos.from, pos.to, pos.empty ? pos.headSide : pos.head < pos.anchor ? -1 : 1]
    return scrollIntoView.of(new ScrollTarget(from, to, assoc, options.y, options.x, options.yMargin, options.xMargin))
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

  /// Facet that allows you to register handlers to override paste
  /// behavior.
  static pasteHandler = pasteHandler

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
  /// an editor. The editor will ensure that the module is
  /// mounted in its [document
  /// root](#editor.Wordgard.constructor^config.root).
  static styleModule = GardState.Facet.define<StyleModule>()

  /// Returns an extension that can be used to add DOM event handlers.
  /// The value should be an object mapping event names to handler
  /// functions. For any given event, such functions are ordered by
  /// extension precedence, and the first handler to return true will
  /// be assumed to have handled that event, and no other handlers or
  /// built-in behavior will be activated for it. These are registered
  /// on the [content element](#editor.Wordgard.contentDOM), except
  /// for `scroll` handlers, which will be called any time the
  /// editor's [scroll element](#editor.Wordgard.scrollDOM) or one of
  /// its parent nodes is scrolled.
  static domEventHandlers(handlers: DOMEventHandlers<any>): GardState.Extension {
    return Wordgard.Plugin.define(() => ({}), {eventHandlers: handlers})
  }

  /// Create an extension that registers DOM event observers. Contrary
  /// to event [handlers](#editor.Wordgard^domEventHandlers),
  /// observers can't be prevented from running by a higher-precedence
  /// handler returning true. They also don't prevent other handlers
  /// and observers from running when they return true, and should not
  /// call `preventDefault`.
  static domEventObservers(observers: DOMEventHandlers<any>): GardState.Extension {
    return Wordgard.Plugin.define(() => ({}), {eventObservers: observers})
  }

  /// Scroll handlers can override how things are scrolled into view.
  /// If they return `true`, no further handling happens for the
  /// scrolling. If they return false, the default scroll behavior is
  /// applied. Scroll handlers should never initiate editor updates.
  static scrollHandler = GardState.Facet.define<(
    wg: Wordgard,
    target: {from: number, to: number, x: ScrollStrategy, y: ScrollStrategy, xMargin: number, yMargin: number}
  ) => boolean>()

  /// Allows you to provide a function that should be called when the
  /// library catches an exception from an extension (mostly from
  /// plugins, but may be used by other extensions to route exceptions
  /// from user-code-provided callbacks). This is mostly useful for
  /// debugging and logging. See [`logException`](#editor.logException).
  static exceptionSink = exceptionSink

  // FIXME better names for these (distinguish from .update, use nouns
  // for facet names)

  /// A facet that can be used to register a function to be called
  /// right before the editor updates. Any transactions dispatched by
  /// such functions will be included in the update.
  static beforeUpdate = GardState.Facet.define<(update: Wordgard.Update) => void>()

  /// A facet that can be used to register a function to be called
  /// after the editor updates. Dispatching transactions from such a
  /// function is allowed, but will cause another, separate update to
  /// happen.
  static afterUpdate = GardState.Facet.define<(update: Wordgard.Update) => void>()

  /// Facet that controls whether the editor content DOM is editable.
  /// When its highest-precedence value is `false`, the element will
  /// not have its `contenteditable` attribute set. (Note that this
  /// doesn't affect API calls that change the editor content, even
  /// when those are bound to keys or buttons. See the
  /// [`readOnly`](#state.GardState.readOnly) facet for that.)
  static editable = GardState.Facet.define<boolean, boolean>({combine: values => values.length ? values[0] : true })

  /// Controls the length of a full cursor blink cycle, in milliseconds.
  /// Defaults to 1200. Can be set to 0 to disable blinking.
  static cursorBlinkRate = GardState.Facet.define<number, number>({
    combine: inputs => inputs.length ? Math.min(...inputs) : 1200
  })

  /// Allows you to influence the way mouse selection happens. The
  /// functions in this facet will be called for a `mousedown` event
  /// on the editor, and can return an object that overrides the way a
  /// selection is computed from that mouse click or drag.
  static mouseSelectionStyle = mouseSelectionStyle

  /// Facet used to configure whether a given selection drag event
  /// should move or copy the selection. The given predicate will be
  /// called with the `mousedown` event, and can return `true` when
  /// the drag should move the content.
  static dragMovesSelection = dragBehavior

  /// Facet that allows extensions to provide additional scroll
  /// margins (space around the sides of the scrolling element that
  /// should be considered invisible). This can be useful when the
  /// plugin introduces elements that cover part of that element (for
  /// example a horizontally fixed gutter).
  static scrollMargins = GardState.Facet.define<(wg: Wordgard) => Partial<DOMRect> | null>()

  /// @internal
  getScrollMargins() {
    let left = 0, right = 0, top = 0, bottom = 0
    for (let source of this.state.facet(Wordgard.scrollMargins)) {
      let m = source(this)
      if (m) {
        if (m.left != null) left = Math.max(left, m.left)
        if (m.right != null) right = Math.max(right, m.right)
        if (m.top != null) top = Math.max(top, m.top)
        if (m.bottom != null) bottom = Math.max(bottom, m.bottom)
      }
    }
    return {left, right, top, bottom}
  }

  /// Create a theme extension. The first argument can be a
  /// [`style-mod`](https://github.com/marijnh/style-mod#documentation)
  /// style spec providing the styles for the theme. These will be
  /// prefixed with a generated class for the style.
  ///
  /// Because the selectors will be prefixed with a scope class, rule
  /// that directly match the editor's [wrapper
  /// element](#editor.Wordgard.dom)—to which the scope class will be
  /// added—need to be explicitly differentiated by adding an `&` to
  /// the selector for that element—for example
  /// `&:has(wg-content:focus)`.
  ///
  /// When `dark` is set to true, the theme will be marked as dark,
  /// which will cause the `&dark` rules from [base
  /// themes](#editor.Wordgard^baseTheme) to be used (as opposed to
  /// `&light` when a light theme is active).
  static theme(spec: {[selector: string]: StyleSpec}): GardState.Extension {
    let prefix = StyleModule.newName()
    return [theme.of(prefix), Wordgard.styleModule.of(buildTheme(`.${prefix}`, spec))]
  }

  /// This facet controls whether a dark theme is active, which
  /// determines whether base theme rules with a `&dark` or `&light`
  /// selector are applied. If not configured, the editor uses a CSS
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
  /// with [`theme`](#editor.Wordgard^theme), use `&` to indicate the
  /// place of the editor wrapper element when directly targeting
  /// that. You can also use `&dark` or `&light` instead to only
  /// target editors with a dark or light theme.
  static baseTheme(spec: {[selector: string]: StyleSpec}): GardState.Extension {
    return GardState.prec.lowest(Wordgard.styleModule.of(buildTheme("." + baseThemeID, spec, lightDarkIDs)))
  }

  /// Provides a Content Security Policy nonce to use when creating
  /// the style sheets for the editor. Holds the empty string when no
  /// nonce has been provided.
  static cspNonce = GardState.Facet.define<string, string>({combine: values => values.length ? values[0] : ""})

  /// Facet that provides additional DOM attributes for the editor's
  /// editable DOM element.
  static contentAttributes = GardState.Facet.define<AttrSource>()

  /// Facet that provides DOM attributes for the editor's outer
  /// element.
  static editorAttributes = GardState.Facet.define<AttrSource>()

  /// State effect used to include screen reader announcements in a
  /// transaction. These will be added to the DOM in a visually hidden
  /// element with `aria-live="polite"` set, and should be used to
  /// describe effects that are visually obvious but may not be
  /// noticed by screen reader users (such as moving to the next
  /// search match).
  static announce = Transaction.Effect.define<string>()

  /// @internal for testing
  static DocTile = DocTile
}

export namespace Wordgard {
  /// The type of object given to the [`Wordgard`](#editor.Wordgard)
  /// constructor.
  export interface Spec extends Partial<GardState.Spec> {
    /// The editor's initial state. If not given, a new state is created
    /// by passing this configuration object to
    /// [`GardState.create`](#state.GardState^create), using its
    /// `doc`, `selection`, and `extensions` field (if provided).
    state?: GardState,
    /// When given, the editor is immediately appended to the given
    /// element on creation. (Otherwise, you'll have to place the editor
    /// element in the document yourself.)
    parent?: Element | DocumentFragment
    /// Pass an effect created with
    /// [`Wordgard.scrollIntoView`](#editor.Wordgard^scrollIntoView) or
    /// [`Wordgard.scrollSnapshot`](#editor.Wordgard.scrollSnapshot)
    /// here to set an initial scroll position.
    scrollTo?: Transaction.Effect<any>,
  }
}

let _wrapElement: {new (wg: Wordgard): HTMLElement} | null = null

function wrapElementConstructor() {
  let ctor = class extends HTMLElement {
    constructor(readonly wg: Wordgard) { super() }
    connectedCallback() { this.wg.setConnected(true) }
    disconnectedCallback() { this.wg.setConnected(false) }
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

function createWrapElement(wg: Wordgard) {
  if (!_wrapElement) _wrapElement = wrapElementConstructor()
  return new _wrapElement(wg)
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
  [event in keyof DOMEventMap]?: (this: This, event: DOMEventMap[event], wg: Wordgard) => boolean | void
}

function attrsFromFacet(wg: Wordgard, facet: GardState.Facet<AttrSource>, base: Attrs) {
  for (let sources = wg.state.facet(facet), i = sources.length - 1; i >= 0; i--) {
    let source = sources[i], value = typeof source == "function" ? source(wg) : source
    if (value) combineAttrs(value, base)
  }
  return base
}

export const basePlugins: Wordgard.Plugin<any>[] = []

export const editorPlugin = GardState.Facet.define<Wordgard.Plugin<any>>({
  combine: plugins => basePlugins.concat(plugins)
})

export namespace Wordgard {
  /// Plugins associate stateful values with an editor. They can
  /// influence the way the content is drawn, and are notified of
  /// things that happen in the editor.
  export class Plugin<V extends Wordgard.Plugin.Value> {
    /// Instances of this class act as extensions.
    extension: GardState.Extension

    private constructor(
      /// @internal
      readonly create: (wg: Wordgard) => V,
      /// @internal
      readonly domEventHandlers: DOMEventHandlers<V> | undefined,
      /// @internal
      readonly domEventObservers: DOMEventHandlers<V> | undefined,
      buildExtensions: (plugin: Wordgard.Plugin<V>) => GardState.Extension
    ) {
      this.extension = buildExtensions(this)
    }

    /// Define a plugin from a constructor function that creates the
    /// plugin's value, given an editor.
    static define<V extends Wordgard.Plugin.Value>(create: (wg: Wordgard) => V, spec?: Wordgard.Plugin.Spec<V>) {
      const {eventHandlers, eventObservers, provide} = spec || {}
      return new Wordgard.Plugin<V>(create, eventHandlers, eventObservers, plugin => {
        let ext = [editorPlugin.of(plugin)]
        if (provide) ext.push(provide(plugin))
        return ext
      })
    }

    /// Create a plugin for a class whose constructor takes a single
    /// editor as argument.
    static fromClass<V extends Wordgard.Plugin.Value>(cls: {new (wg: Wordgard): V}, spec?: Wordgard.Plugin.Spec<V>) {
      return Wordgard.Plugin.define(wg => new cls(wg), spec)
    }
  }

  export namespace Plugin {
    /// Provides additional information when defining a
    /// [plugin](#editor.Wordgard.Plugin).
    export interface Spec<V extends Wordgard.Plugin.Value> {
      /// Register the given [event
      /// handlers](#editor.Wordgard^domEventHandlers) for the plugin.
      /// When called, these will have their `this` bound to the plugin
      /// value.
      eventHandlers?: DOMEventHandlers<V>,

      /// Registers [event observers](#editor.Wordgard^domEventObservers)
      /// for the plugin. Will, when called, have their `this` bound to
      /// the plugin value.
      eventObservers?: DOMEventHandlers<V>,

      /// Specify that the plugin provides additional extensions when
      /// added to an editor configuration.
      provide?: (plugin: Wordgard.Plugin<V>) => GardState.Extension // FIXME is this useful?
    }

    /// This is the interface plugin objects conform to.
    export interface Value {
      /// Notifies the plugin of an update that happened in the editor. This
      /// is called _before_ the editor updates its own DOM. It is
      /// responsible for updating the plugin's internal state (including
      /// any state that may be read by plugin fields) and _writing_ to
      /// the DOM for the changes in the update. To avoid unnecessary
      /// layout recomputations, it should _not_ read the DOM layout—use
      /// [`requestMeasure`](#editor.Wordgard.requestMeasure) to schedule
      /// your code in a DOM reading phase if you need to.
      update?(update: Wordgard.Update): void

      /// When present, this will be called when an update causes any
      /// changes in the DOM representation of the document.
      docUpdate?(wg: Wordgard): void

      /// Called when the plugin is removed from an editor. This should
      /// clean up any changes it made to the editor itself.
      destroy?(wg: Wordgard): void

      /// Called when the editor is attached to the DOM. If the plugin
      /// needs to allocate any resource that must be released, or modify
      /// something outside the editor, it should do it in this method,
      /// and make sure to release/undo it in its `disconnect` method.
      connect?(wg: Wordgard): void

      /// Called when the editor is removed from the DOM.
      disconnect?(wg: Wordgard): void
    }
  }

  /// Editor [plugins](#editor.Wordgard.Plugin) are given instances of
  /// this class, which describe what happened, whenever the editor is
  /// updated.
  export class Update {
    /// The changes made to the document by this update.
    readonly changes: ChangeSet

    private constructor(
      /// The editor that the update is associated with.
      readonly editor: Wordgard,
      /// The previous editor state.
      readonly startState: GardState,
      /// The new editor state.
      readonly state: GardState,
      /// The transactions involved in the update. May be empty.
      readonly transactions: readonly Transaction[],
      /// @internal
      public flags: number
    ) {
      if (transactions.length) {
        this.changes = transactions[0].changes
        for (let i = 1; i < transactions.length; i++) this.changes = this.changes.compose(transactions[i].changes)
      } else {
        this.changes = ChangeSet.empty(startState.doc.length)
      }
    }

    /// @internal
    static create(wg: Wordgard, startState: GardState, state: GardState,
                  transactions: readonly Transaction[], flags = 0) {
      return new Wordgard.Update(wg, startState, state, transactions, flags)
    }

    /// Returns true when the document was modified or the size of the
    /// editor, or elements within the editor, changed.
    get geometryChanged() {
      return this.docChanged || (this.flags & UpdateFlag.Geometry) > 0
    }

    /// True when this update indicates a focus change.
    get focusChanged() {
      return (this.flags & UpdateFlag.Focus) > 0
    }

    /// Whether the document changed in this update.
    get docChanged() {
      return !this.changes.empty
    }

    /// Whether the selection was explicitly set in this update.
    get selectionSet() {
      return this.transactions.some(tr => tr.selection)
    }

    /// @internal
    get empty() { return this.flags == 0 && this.transactions.length == 0 }
  }
}

export class PluginInstance {
  // When starting an update, all plugins have this field set to the
  // update object, indicating they need to be updated. When finished
  // updating, it is set to `null`. Retrieving a plugin that needs to
  // be updated with `editor.plugin` forces an eager update.
  mustUpdate: Wordgard.Update | null = null
  // This is null when the plugin is initially created, but
  // initialized on the first update.
  value: Wordgard.Plugin.Value | null = null
  // Set when the plugin has crashed, and will no longer run.
  deactivated = false

  constructor(public spec: Wordgard.Plugin<any>) {}

  update(wg: Wordgard) {
    if (!this.value) {
      if (!this.deactivated) {
        try { this.value = this.spec.create(wg) }
        catch (e) {
          logException(wg.state, e, "CodeMirror plugin crashed")
          this.deactivate(null)
        }
      }
    } else if (this.mustUpdate) {
      let update = this.mustUpdate
      this.mustUpdate = null
      if (this.value.update) {
        try {
          this.value.update(update)
        } catch (e) {
          logException(update.state, e, "CodeMirror plugin crashed")
          if (wg.connected && this.value.disconnect) try { this.value.disconnect(wg) } catch {}
          this.deactivate(wg)
        }
      }
    }
    return this
  }

  docUpdate(wg: Wordgard) {
    if (this.value?.docUpdate) {
      try { this.value.docUpdate(wg) }
      catch(e) { logException(wg.state, e, "doc update listener") }
    }
  }

  connect(wg: Wordgard) {
    if (this.value?.connect) {
      try {
        this.value.connect(wg)
      } catch (e) {
        logException(wg.state, e, "CodeMirror plugin crashed")
        this.deactivate(wg)
      }
    }
  }

  disconnect(wg: Wordgard) {
    if (!this.value?.disconnect) return
    try {
      this.value.disconnect(wg)
    } catch (e) {
      logException(wg.state, e, "CodeMirror plugin crashed")
      this.deactivate(wg)
    }
  }

  destroy(wg: Wordgard) {
    if (wg.connected) this.disconnect(wg)
    if (this.value?.destroy) try {
      this.value.destroy(wg)
    } catch(e) {
      logException(wg.state, e, "CodeMirror plugin crashed")
    }
  }

  deactivate(destroy: Wordgard | null) {
    if (destroy && this.value?.destroy) try { this.value.destroy(destroy) } catch {}
    this.deactivated = true
    this.value = null
  }
}

export type AttrSource = Attrs | ((wg: Wordgard) => Attrs | null)

export const enum UpdateFlag { Focus = 1, Geometry = 2 }
