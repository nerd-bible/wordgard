import {EditorState, Transaction, Facet, StateEffect, Extension, EditorSelection} from "@willows/state"
import {ChangeSet, ChangeDesc} from "@willows/doc"
import {StyleModule} from "style-mod"
import {EditorView, DOMEventHandlers} from "./editorview"
import {Attrs} from "./attributes"
import {Rect, ScrollStrategy} from "./dom"
import {MakeSelectionStyle} from "./input"
import {Command} from "./commands"
import {DecorationSet} from "./decoration"

export const clickAddsSelectionRange = Facet.define<(event: MouseEvent) => boolean>()

export const dragMovesSelection = Facet.define<(event: MouseEvent) => boolean>()

export const mouseSelectionStyle = Facet.define<MakeSelectionStyle>()

export const exceptionSink = Facet.define<(exception: any) => void>()

export const updateListener = Facet.define<(update: ViewUpdate) => void>()

export const inputHandler = Facet.define<(view: EditorView, from: number, to: number, text: string,
                                          insert: () => Transaction) => boolean>()

export const inputEventHandler = Facet.define<{event: string, run: Command}>()

export const focusChangeEffect = Facet.define<(state: EditorState, focusing: boolean) => StateEffect<any> | null>()

export const scrollHandler = Facet.define<(
  view: EditorView,
  range: {from: number, to: number},
  options: {x: ScrollStrategy, y: ScrollStrategy, xMargin: number, yMargin: number}
) => boolean>()

export class ScrollTarget {
  constructor(
    readonly range: {from: number, to: number},
    readonly y: ScrollStrategy = "nearest",
    readonly x: ScrollStrategy = "nearest",
    readonly yMargin: number = 5,
    readonly xMargin: number = 5,
    // This data structure is abused to also store precise scroll
    // snapshots, instead of a `scrollIntoView` request. When this
    // flag is `true`, `range` points at a position in the reference
    // line, `yMargin` holds the difference between the top of that
    // line and the top of the editor, and `xMargin` holds the
    // editor's `scrollLeft`.
    readonly isSnapshot = false
  ) {}

  map(changes: ChangeDesc) {
    return changes.empty ? this :
      new ScrollTarget(EditorSelection.mapRange(changes, this.range.from, this.range.to),
                       this.y, this.x, this.yMargin, this.xMargin, this.isSnapshot)
  }

  clip(state: EditorState) {
    return this.range.to <= state.doc.length ? this :
      new ScrollTarget(EditorSelection.cursor(state.doc.length), this.y, this.x, this.yMargin, this.xMargin, this.isSnapshot)
  }
}

export const scrollIntoView = StateEffect.define<ScrollTarget>({map: (t, ch) => t.map(ch)})

/// Log or report an unhandled exception in client code. Should
/// probably only be used by extension code that allows client code to
/// provide functions, and calls those functions in a context where an
/// exception can't be propagated to calling code in a reasonable way
/// (for example when in an event handler).
///
/// Either calls a handler registered with
/// [`EditorView.exceptionSink`](#view.EditorView^exceptionSink),
/// `window.onerror`, if defined, or `console.error` (in which case
/// it'll pass `context`, when given, as first argument).
export function logException(state: EditorState, exception: any, context?: string) {
  let handler = state.facet(exceptionSink)
  if (handler.length) handler[0](exception)
  else if (window.onerror) window.onerror(String(exception), context, undefined, undefined, exception)
  else if (context) console.error(context + ":", exception)
  else console.error(exception)
}

export const editable = Facet.define<boolean, boolean>({combine: values => values.length ? values[0] : true })

/// This is the interface plugin objects conform to.
export interface PluginValue {
  /// Notifies the plugin of an update that happened in the view. This
  /// is called _before_ the view updates its own DOM. It is
  /// responsible for updating the plugin's internal state (including
  /// any state that may be read by plugin fields) and _writing_ to
  /// the DOM for the changes in the update. To avoid unnecessary
  /// layout recomputations, it should _not_ read the DOM layout—use
  /// [`requestMeasure`](#view.EditorView.requestMeasure) to schedule
  /// your code in a DOM reading phase if you need to.
  update?(update: ViewUpdate): void

  /// Called when the editor is attached to the DOM. It is possible
  /// for an editor to be disconnected and then reconnected again, so
  /// if you implement either method, you probably need to implement
  /// both, and make them invert each other's effect.
  connect?(): void

  /// Called when the editor is removed from the DOM. If the plugin
  /// produced any effects (event handlers, DOM changes, global data)
  /// outside of the editor's DOM, it should undo those here, in order
  /// to avoid leaking data.
  disconnect?(): void
}

let nextPluginID = 0

export const viewPlugin = Facet.define<ViewPlugin<any>>()

/// Provides additional information when defining a [view
/// plugin](#view.ViewPlugin).
export interface PluginSpec<V extends PluginValue> {
  /// Register the given [event
  /// handlers](#view.EditorView^domEventHandlers) for the plugin.
  /// When called, these will have their `this` bound to the plugin
  /// value.
  eventHandlers?: DOMEventHandlers<V>,

  /// Registers [event observers](#view.EditorView^domEventObservers)
  /// for the plugin. Will, when called, have their `this` bound to
  /// the plugin value.
  eventObservers?: DOMEventHandlers<V>,

  /// Specify that the plugin provides additional extensions when
  /// added to an editor configuration.
  provide?: (plugin: ViewPlugin<V>) => Extension
}

/// View plugins associate stateful values with a view. They can
/// influence the way the content is drawn, and are notified of things
/// that happen in the view.
export class ViewPlugin<V extends PluginValue> {
  /// Instances of this class act as extensions.
  extension: Extension

  private constructor(
    /// @internal
    readonly id: number,
    /// @internal
    readonly create: (view: EditorView) => V,
    /// @internal
    readonly domEventHandlers: DOMEventHandlers<V> | undefined,
    /// @internal
    readonly domEventObservers: DOMEventHandlers<V> | undefined,
    buildExtensions: (plugin: ViewPlugin<V>) => Extension
  ) {
    this.extension = buildExtensions(this)
  }

  /// Define a plugin from a constructor function that creates the
  /// plugin's value, given an editor view.
  static define<V extends PluginValue>(create: (view: EditorView) => V, spec?: PluginSpec<V>) {
    const {eventHandlers, eventObservers, provide} = spec || {}
    return new ViewPlugin<V>(nextPluginID++, create, eventHandlers, eventObservers, plugin => {
      let ext = [viewPlugin.of(plugin)]
      if (provide) ext.push(provide(plugin))
      return ext
    })
  }

  /// Create a plugin for a class whose constructor takes a single
  /// editor view as argument.
  static fromClass<V extends PluginValue>(cls: {new (view: EditorView): V}, spec?: PluginSpec<V>) {
    return ViewPlugin.define(view => new cls(view), spec)
  }
}

export class PluginInstance {
  // When starting an update, all plugins have this field set to the
  // update object, indicating they need to be updated. When finished
  // updating, it is set to `false`. Retrieving a plugin that needs to
  // be updated with `view.plugin` forces an eager update.
  mustUpdate: ViewUpdate | null = null
  // This is null when the plugin is initially created, but
  // initialized on the first update.
  value: PluginValue | null = null

  constructor(public spec: ViewPlugin<any> | null) {}

  update(view: EditorView) {
    if (!this.value) {
      if (this.spec) {
        try { this.value = this.spec.create(view) }
        catch (e) {
          logException(view.state, e, "CodeMirror plugin crashed")
          this.deactivate()
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
          if (this.value.disconnect) try { this.value.disconnect() } catch (_) {}
          this.deactivate()
        }
      }
    }
    return this
  }

  connect(view: EditorView) {
    if (this.value?.connect) {
      try { this.value.connect() }
      catch (e) {
        logException(view.state, e, "CodeMirror plugin crashed")
        this.deactivate()
      }
    }
  }

  disconnect(view: EditorView) {
    if (this.value?.disconnect) {
      try { this.value.disconnect() }
      catch (e) {
        logException(view.state, e, "CodeMirror plugin crashed")
        this.deactivate()
      }
    }
  }

  deactivate() {
    this.spec = this.value = null
  }
}

export interface MeasureRequest<T> {
  /// Called in a DOM read phase to gather information that requires
  /// DOM layout. Should _not_ mutate the document.
  read(view: EditorView): T
  /// Called in a DOM write phase to update the document. Should _not_
  /// do anything that triggers DOM layout.
  write?(measure: T, view: EditorView): void
  /// When multiple requests with the same key are scheduled, only the
  /// last one will actually be run.
  key?: any
}

export type AttrSource = Attrs | ((view: EditorView) => Attrs | null)

export const editorAttributes = Facet.define<AttrSource>()

export const contentAttributes = Facet.define<AttrSource>()

export const decorations = Facet.define<DecorationSet>()

export const scrollMargins = Facet.define<(view: EditorView) => Partial<Rect> | null>()

export function getScrollMargins(view: EditorView) {
  let left = 0, right = 0, top = 0, bottom = 0
  for (let source of view.state.facet(scrollMargins)) {
    let m = source(view)
    if (m) {
      if (m.left != null) left = Math.max(left, m.left)
      if (m.right != null) right = Math.max(right, m.right)
      if (m.top != null) top = Math.max(top, m.top)
      if (m.bottom != null) bottom = Math.max(bottom, m.bottom)
    }
  }
  return {left, right, top, bottom}
}

export const styleModule = Facet.define<StyleModule>()

export const enum UpdateFlag { Focus = 1, Geometry = 2 }

/// View [plugins](#view.ViewPlugin) are given instances of this
/// class, which describe what happened, whenever the view is updated.
export class ViewUpdate {
  /// The changes made to the document by this update.
  readonly changes: ChangeSet
  /// @internal
  flags = 0

  private constructor(
    /// The editor view that the update is associated with.
    readonly view: EditorView,
    /// The previous editor state.
    readonly startState: EditorState,
    /// The new editor state.
    readonly state: EditorState,
    /// The transactions involved in the update. May be empty.
    readonly transactions: readonly Transaction[]
  ) {
    this.startState = view.state
    if (transactions.length) {
      this.changes = transactions[0].changes
      for (let i = 1; i < transactions.length; i++) this.changes = this.changes.compose(transactions[i].changes)
    } else {
      this.changes = ChangeSet.empty(startState.doc.length)
    }
  }

  /// @internal
  static create(view: EditorView, startState: EditorState, state: EditorState, transactions: readonly Transaction[]) {
    return new ViewUpdate(view, startState, state, transactions)
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
