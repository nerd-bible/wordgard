import {Plot, ChangeSet} from "wordgard/doc"
import type {GardState} from "./state"
import {GardSelection, normalize} from "./selection"

/// Annotations are tagged values that are used to add metadata to
/// transactions in an extensible way. They should be used to model
/// things that effect the entire transaction (such as its [time
/// stamp](#state.Transaction^time) or information about its
/// [origin](#state.Transaction^userEvent)). For effects that happen
/// _alongside_ the other changes made by the transaction, [state
/// effects](#state.StateEffect) are more appropriate.
export class Annotation<T> {
  /// @internal
  constructor(
    /// The annotation type.
    readonly type: Annotation.Type<T>,
    /// The value of this annotation.
    readonly value: T
  ) {}

  /// Define a new type of annotation.
  static define<T>() { return new Annotation.Type<T>() }

  // This is just to get less sloppy typing (where StateEffect is a subtype of Annotation)
  declare private _isAnnotation: true
}

export namespace Annotation {
  /// Marker that identifies a type of [annotation](#state.Annotation).
  export class Type<T> {
    /// Create an instance of this annotation.
    of(value: T): Annotation<T> { return new Annotation(this, value) }
  }
}

/// State effects can be used to represent additional effects
/// associated with a [transaction](#state.Transaction.effects). They
/// are often useful to model changes to custom [state
/// fields](#state.StateField), when those changes aren't implicit in
/// document or selection changes.
export class StateEffect<Value> {
  /// @internal
  constructor(
    /// @internal
    readonly type: StateEffect.Type<Value>,
    /// The value of this effect.
    readonly value: Value) {}

  /// Map this effect through a position mapping. Will return
  /// `undefined` when that ends up deleting the effect.
  map(mapping: ChangeSet): StateEffect<Value> | undefined {
    let mapped = this.type.map(this.value, mapping)
    return mapped === undefined ? undefined : mapped == this.value ? this : new StateEffect(this.type, mapped)
  }

  /// Tells you whether this effect object is of a given
  /// [type](#state.StateEffect.Type).
  is<T>(type: StateEffect.Type<T>): this is StateEffect<T> { return this.type == type as any }

  /// Define a new effect type. The type parameter indicates the type
  /// of values that his effect holds. It should be a type that
  /// doesn't include `undefined`, since that is used in
  /// [mapping](#state.StateEffect.map) to indicate that an effect is
  /// removed.
  static define<Value = null>(spec: StateEffect.Spec<Value> = {}): StateEffect.Type<Value> {
    return new StateEffect.Type(spec.map || (v => v))
  }

  /// Map an array of effects through a change set.
  static mapEffects(effects: readonly StateEffect<any>[], mapping: ChangeSet) {
    if (!effects.length) return effects
    let result = []
    for (let effect of effects) {
      let mapped = effect.map(mapping)
      if (mapped) result.push(mapped)
    }
    return result
  }

  /// This effect can be used to reconfigure the root extensions of
  /// the editor. Doing this will discard any extensions
  /// [appended](#state.StateEffect^appendConfig), but does not reset
  /// the content of [reconfigured](#state.Compartment.reconfigure)
  /// compartments.
  declare static reconfigure: StateEffect.Type<GardState.Extension>

    /// Append extensions to the top-level configuration of the editor.
    declare static appendConfig: StateEffect.Type<GardState.Extension>
}

export namespace StateEffect {
  /// Representation of a type of state effect. Defined with
  /// [`StateEffect.define`](#state.StateEffect^define).
  export class Type<Value> {
    /// @internal
    constructor(
      // The `any` types in these function types are there to work
      // around TypeScript issue #37631, where the type guard on
      // `StateEffect.is` mysteriously stops working when these properly
      // have type `Value`.
      /// @internal
      readonly map: (value: any, mapping: ChangeSet) => any | undefined
    ) {}

    /// Create a [state effect](#state.StateEffect) instance of this
    /// type.
    of(value: Value): StateEffect<Value> { return new StateEffect(this, value) }
  }

  export interface Spec<Value> {
    /// Provides a way to map an effect like this through a position
    /// mapping. When not given, the effects will simply not be mapped.
    /// When the function returns `undefined`, that means the mapping
    /// deletes the effect.
    map?: (value: Value, mapping: ChangeSet) => Value | undefined
  }
}

StateEffect.reconfigure = StateEffect.define<GardState.Extension>()

StateEffect.appendConfig = StateEffect.define<GardState.Extension>()

export namespace Transaction {
  /// Describes a [transaction](#state.Transaction) when calling the
  /// [`EditorState.update`](#state.EditorState.update) method.
  export interface Spec {
    /// The changes to the document made by this transaction.
    changes?: ChangeSet.Spec
    /// When set, this transaction explicitly updates the selection.
    /// Offsets in this selection should refer to the document as it is
    /// _after_ the transaction.
    selection?: GardSelection | GardSelection.Spec | undefined,
    /// When true, cursor ranges in the provided selection will be
    /// [normalized](#state.EditorSelection.normalize) in the created
    /// state.
    normalizeSelection?: boolean,
    /// Attach [state effects](#state.StateEffect) to this transaction.
    /// Again, when they contain positions and this same spec makes
    /// changes, those positions should refer to positions in the
    /// updated document.
    effects?: StateEffect<any> | readonly StateEffect<any>[],
    /// Set [annotations](#state.Annotation) for this transaction.
    annotations?: Annotation<any> | readonly Annotation<any>[],
    /// Shorthand for `annotations:` [`Transaction.userEvent`](#state.Transaction^userEvent)`.of(...)`.
    userEvent?: string, // FIXME define a union with some of the common events?
    /// When set to `true`, the transaction is marked as needing to
    /// scroll the current selection into view.
    scrollIntoView?: boolean,
    /// By default, transactions can be modified by [transaction
    /// filters](#state.EditorState^transactionFilter). You can set this
    /// to `false` to disable that. This can be necessary for
    /// transactions that, for example, include annotations that must be
    /// kept consistent with their changes.
    filter?: boolean,
    /// Normally, when multiple specs are combined (for example by
    /// [`EditorState.update`](#state.EditorState.update)), the
    /// positions in `changes` are taken to refer to the document
    /// positions in the initial document. When a spec has `sequental`
    /// set to true, its positions will be taken to refer to the
    /// document created by the specs before it instead.
    sequential?: boolean
  }
}

/// Changes to the editor state are grouped into transactions.
/// Typically, a user action creates a single transaction, which may
/// contain any number of document changes, may change the selection,
/// or have other effects. Create a transaction by calling
/// [`EditorState.update`](#state.EditorState.update), or immediately
/// dispatch one by calling
/// [`EditorView.dispatch`](#view.EditorView.dispatch).
export class Transaction {
  /// @internal
  _selection: GardSelection | null = null
  /// @internal
  _state: GardState | null = null

  private constructor(
    /// The state from which the transaction starts.
    readonly startState: GardState,
    /// The document changes made by this transaction.
    readonly changes: ChangeSet,
    /// The selection set by this transaction, or undefined if it
    /// doesn't explicitly set a selection.
    readonly selection: GardSelection | undefined,
    /// Whether [selection
    /// normalization](#state.TransactionSpec.normalizeSelection) is
    /// enabled for this transaction,
    readonly normalizeSelection: boolean,
    /// The effects added to the transaction.
    readonly effects: readonly StateEffect<any>[],
    /// @internal
    readonly annotations: readonly Annotation<any>[],
    /// Whether the selection should be scrolled into view after this
    /// transaction is dispatched.
    readonly scrollIntoView: boolean
  ) {
    if (!annotations.some((a: Annotation<any>) => a.type == Transaction.time))
      this.annotations = annotations.concat(Transaction.time.of(Date.now()))
    this.newDoc = this.changes.apply(this.startState.doc)
  }

  /// The new document produced by the transaction. Contrary to
  /// [`.state`](#state.Transaction.state)`.doc`, accessing this won't
  /// force the entire new state to be computed right away, so it is
  /// recommended that [transaction
  /// filters](#state.EditorState^transactionFilter) use this property
  /// when they need to look at the new document.
  newDoc: Plot.Doc

  /// @internal
  static create(startState: GardState, changes: ChangeSet,
                selection: GardSelection | undefined, normalizeSelection: boolean,
                effects: readonly StateEffect<any>[], annotations: readonly Annotation<any>[],
                scrollIntoView: boolean) {
    return new Transaction(startState, changes, selection, normalizeSelection, effects, annotations, scrollIntoView)
  }

  /// The new selection produced by the transaction. If
  /// [`this.selection`](#state.Transaction.selection) is undefined,
  /// this will [map](#state.EditorSelection.map) the start state's
  /// current selection through the changes made by the transaction.
  get newSelection() {
    if (!this._selection) {
      let sel = this.selection || this.startState.selection.map(this.changes)
      this._selection = this.normalizeSelection ? normalize({
        doc: this.newDoc,
        textDirection: this.startState.textDirection,
        visualCursorMotion: this.startState.visualCursorMotion,
        // FIXME somehow handle isAtom correctly
      }, sel) : sel
    }
    return this._selection
  }

  /// The new state created by the transaction.
  get state() {
    if (!this._state) this.startState.applyTransaction(this)
    return this._state!
  }

  /// Get the value of the given annotation type, if any.
  annotation<T>(type: Annotation.Type<T>): T | undefined {
    for (let ann of this.annotations) if (ann.type == type) return ann.value
    return undefined
  }

  /// Indicates whether the transaction changed the document.
  get docChanged(): boolean { return !this.changes.empty }

  /// Indicates whether this transaction reconfigures the state
  /// (through a [configuration compartment](#state.Compartment) or
  /// with a top-level configuration
  /// [effect](#state.StateEffect^reconfigure).
  get reconfigured(): boolean { return this.startState.config != this.state.config }

  /// Returns true if the transaction has a [user
  /// event](#state.Transaction^userEvent) annotation that is equal to
  /// or more specific than `event`. For example, if the transaction
  /// has `"select.pointer"` as user event, `"select"` and
  /// `"select.pointer"` will match it.
  isUserEvent(event: string): boolean {
    let e = this.annotation(Transaction.userEvent)
    return !!(e && (e == event || e.length > event.length && e.startsWith(event) && e[event.length] == "."))
  }

  /// Annotation used to store transaction timestamps. Automatically
  /// added to every transaction, holding `Date.now()`.
  static time = Annotation.define<number>()

  /// Annotation used to associate a transaction with a user interface
  /// event. Holds a string identifying the event, using a
  /// dot-separated format to support attaching more specific
  /// information. The events used by the core libraries are:
  ///
  ///  - `"input"` when content is entered
  ///    - `"input.type"` for typed input
  ///      - `"input.type.compose"` for composition
  ///    - `"input.paste"` for pasted input
  ///    - `"input.drop"` when adding content with drag-and-drop
  ///  - `"delete"` when the user deletes content
  ///    - `"delete.selection"` when deleting the selection
  ///    - `"delete.forward"` when deleting forward from the selection
  ///    - `"delete.backward"` when deleting backward from the selection
  ///    - `"delete.cut"` when cutting to the clipboard
  ///  - `"move"` when content is moved
  ///    - `"move.drop"` when content is moved within the editor
  ///      through drag-and-drop
  ///  - `"select"` when explicitly changing the selection
  ///    - `"select.pointer"` when selecting with a mouse or other pointing
  ///      device
  ///    - `"select.all"` when selecting the entire document
  ///  - `"undo"` and `"redo"` for history actions
  ///  - `"insert"` for actions that insert nodes
  ///  - `"mark"` for actions that manipulate marks
  ///    - `"mark.add"` when a command adds a mark
  ///    - `"mark.remove"` when a command removes one
  ///  - `"split"`, `"wrap"`, `"settype"`, `"wrap"`, `"unwrap"` for
  ///    block manipulation actions
  ///
  /// Use [`isUserEvent`](#state.Transaction.isUserEvent) to check
  /// whether the annotation matches a given event.
  static userEvent = Annotation.define<string>()

  /// Annotation indicating whether a transaction should be added to
  /// the undo history or not.
  static addToHistory = Annotation.define<boolean>()

  /// Annotation indicating (when present and true) that a transaction
  /// represents a change made by some other actor, not the user. This
  /// is used, for example, to tag other people's changes in
  /// collaborative editing.
  static remote = Annotation.define<boolean>()
}

type ResolvedSpec = {
  changes: ChangeSet,
  selection: GardSelection | undefined,
  normalizeSelection: boolean,
  effects: readonly StateEffect<any>[],
  annotations: readonly Annotation<any>[],
  scrollIntoView: boolean
}

export function mergeTransaction(doc: Plot.Doc, a: ResolvedSpec, b: ResolvedSpec, sequential: boolean): ResolvedSpec {
  let mapForA, mapForB, changes
  if (sequential) {
    mapForA = b.changes
    mapForB = ChangeSet.empty(b.changes.length)
    changes = a.changes.compose(b.changes)
  } else {
    mapForA = b.changes.map(a.changes, doc)
    mapForB = a.changes.map(b.changes, doc, true)
    changes = a.changes.compose(mapForA)
  }
  return {
    changes,
    selection: b.selection ? b.selection.map(mapForB) : a.selection?.map(mapForA),
    normalizeSelection: b.normalizeSelection || a.normalizeSelection,
    effects: StateEffect.mapEffects(a.effects, mapForA).concat(StateEffect.mapEffects(b.effects, mapForB)),
    annotations: a.annotations.length ? a.annotations.concat(b.annotations) : b.annotations,
    scrollIntoView: a.scrollIntoView || b.scrollIntoView
  }
}

export function resolveTransactionInner(doc: Plot.Doc, spec: Transaction.Spec): ResolvedSpec {
  let sel = spec.selection, annotations = asArray(spec.annotations)
  if (spec.userEvent) annotations = annotations.concat(Transaction.userEvent.of(spec.userEvent))
  return {
    changes: spec.changes instanceof ChangeSet ? spec.changes : ChangeSet.create(doc, spec.changes || []),
    selection: sel && (sel instanceof GardSelection ? sel : GardSelection.create(sel)),
    normalizeSelection: !!spec.normalizeSelection,
    effects: asArray(spec.effects),
    annotations,
    scrollIntoView: !!spec.scrollIntoView
  }
}

export function resolveTransaction(state: GardState, specs: readonly Transaction.Spec[], filter: boolean): Transaction {
  let s = resolveTransactionInner(state.doc, specs.length ? specs[0] : {})
  if (specs.length && specs[0].filter === false) filter = false
  for (let i = 1; i < specs.length; i++) {
    let spec = specs[i]
    if (spec.filter === false) filter = false
    let seq = !!spec.sequential
    let s2 = resolveTransactionInner(seq && spec.changes ? s.changes.apply(state.doc) : state.doc, spec)
    s = mergeTransaction(state.doc, s, s2, seq)
  }
  let tr = Transaction.create(state, s.changes, s.selection, s.normalizeSelection, s.effects, s.annotations, s.scrollIntoView)
  return extendTransaction(filter ? filterTransaction(tr) : tr)
}

// Finish a transaction by applying filters if necessary.
function filterTransaction(tr: Transaction) {
  // Transaction filters
  let filters = tr.startState.facet((tr.startState.constructor as typeof GardState).transactionFilter)
  for (let i = filters.length - 1; i >= 0; i--) {
    let filtered = filters[i](tr)
    if (filtered instanceof Transaction) tr = filtered
    else if (Array.isArray(filtered) && filtered.length == 1 && filtered[0] instanceof Transaction) tr = filtered[0]
    else tr = resolveTransaction(tr.startState, asArray(filtered as any), false)
  }
  return tr
}

function extendTransaction(tr: Transaction) {
  let state = tr.startState, spec: ResolvedSpec = tr
  let extenders = state.facet((tr.startState.constructor as typeof GardState).transactionExtender)
  for (let i = extenders.length - 1; i >= 0; i--) {
    let extension = extenders[i](tr)
    if (extension && Object.keys(extension).length)
      spec = mergeTransaction(state.doc, tr, resolveTransactionInner(state.doc, extension), true)
  }
  return spec == tr ? tr : Transaction.create(state, tr.changes, tr.selection, tr.normalizeSelection, spec.effects,
                                              spec.annotations, spec.scrollIntoView)
}

const none: readonly any[] = []

export function asArray<T>(value: undefined | T | readonly T[]): readonly T[] {
  return value == null ? none : Array.isArray(value) ? value : [value as T]
}
