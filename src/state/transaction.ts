import {Plot, ChangeSet} from "wordgard/doc"
import type {GardState} from "./state"
import {GardSelection} from "./selection"

/// Changes to the editor state are grouped into transactions.
/// Typically, a user action creates a single transaction, which may
/// contain any number of document changes, may change the selection,
/// or have other effects. Create a transaction by calling
/// [`GardState.update`](#state.GardState.update), or immediately
/// dispatch one by calling
/// [`Wordgard.dispatch`](#view.Wordgard.dispatch).
export class Transaction {
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
    /// The effects added to the transaction.
    readonly effects: readonly Transaction.Effect<any>[],
    /// @internal
    readonly annotations: readonly Transaction.Annotation<any>[],
    /// Whether the selection should be scrolled into view after this
    /// transaction is dispatched.
    readonly scrollIntoView: boolean
  ) {
    if (!annotations.some((a: Transaction.Annotation<any>) => a.type == Transaction.time))
      this.annotations = annotations.concat(Transaction.time.of(Date.now()))
    this.newDoc = this.changes.apply(this.startState.doc)
    this.newSelection = selection || startState.selection.map(changes, this.newDoc)
    this.newSelection.check(startState.config, this.newDoc)
  }

  /// The new document produced by the transaction. Contrary to
  /// [`.state`](#state.Transaction.state)`.doc`, accessing this won't
  /// force the entire new state to be computed right away, so it is
  /// recommended that [transaction
  /// filters](#state.GardState^transactionFilter) use this property
  /// when they need to look at the new document.
  newDoc: Plot.Doc

  /// The new selection produced by the transaction. If
  /// [`this.selection`](#state.Transaction.selection) is undefined,
  /// this will [map](#state.EditorSelection.map) the start state's
  /// current selection through the changes made by the transaction.
  newSelection: GardSelection

  /// @internal
  static create(startState: GardState, changes: ChangeSet,
                selection: GardSelection | undefined,
                effects: readonly Transaction.Effect<any>[], annotations: readonly Transaction.Annotation<any>[],
                scrollIntoView: boolean) {
    return new Transaction(startState, changes, selection, effects, annotations, scrollIntoView)
  }

  /// The new state created by the transaction.
  get state() {
    if (!this._state) this.startState.applyTransaction(this)
    return this._state!
  }

  /// Get the value of the given annotation type, if any.
  annotation<T>(type: Transaction.Annotation.Type<T>): T | undefined {
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
  declare static time: Transaction.Annotation.Type<number>

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
  declare static userEvent: Transaction.Annotation.Type<string>

  /// Annotation indicating whether a transaction should be added to
  /// the undo history or not.
  declare static addToHistory: Transaction.Annotation.Type<boolean>

  /// Annotation indicating (when present and true) that a transaction
  /// represents a change made by some other actor, not the user. This
  /// is used, for example, to tag other people's changes in
  /// collaborative editing.
  declare static remote: Transaction.Annotation.Type<boolean>

  /// Merge two transaction specs into a single one, combining the
  /// effect of both. Note that the
  /// [`sequential`](#state.Transaction.Spec.sequential) field will be
  /// interpreted *within* these transactions, and the resulting spec
  /// will not have it.
  static merge(state: GardState, a: Transaction.Spec, b: Transaction.Spec): Transaction.Spec {
    let seq = !!b.sequential
    let rA = resolveTransactionInner(state.doc, a)
    let rB = resolveTransactionInner(!seq || rA.changes.empty ? state.doc : rA.changes.apply(state.doc), b)
    return mergeTransaction(state.doc, rA, rB, seq)
  }
}

export namespace Transaction {
  /// Describes a [transaction](#state.Transaction) when calling the
  /// [`GardState.update`](#state.GardState.update) method.
  export interface Spec {
    /// The changes to the document made by this transaction.
    changes?: ChangeSet.Spec
    /// When set, this transaction explicitly updates the selection.
    /// Offsets in this selection should refer to the document as it is
    /// _after_ the transaction.
    // FIXME should this pass a selection context?
    selection?: GardSelection | GardSelection.Text.Spec | ((doc: Plot.Doc) => GardSelection) | undefined,
    /// Attach [state effects](#state.StateEffect) to this transaction.
    /// Again, when they contain positions and this same spec makes
    /// changes, those positions should refer to positions in the
    /// updated document.
    effects?: Transaction.Effect<any> | readonly Transaction.Effect<any>[],
    /// Set [annotations](#state.Annotation) for this transaction.
    annotations?: Transaction.Annotation<any> | readonly Transaction.Annotation<any>[],
    /// Shorthand for `annotations:` [`Transaction.userEvent`](#state.Transaction^userEvent)`.of(...)`.
    userEvent?: string, // FIXME define a union with some of the common events?
    /// When set to `true`, the transaction is marked as needing to
    /// scroll the current selection into view.
    scrollIntoView?: boolean,
    /// By default, transactions can be modified by [transaction
    /// filters](#state.GardState^transactionFilter). You can set this
    /// to `false` to disable that. This can be necessary for
    /// transactions that, for example, include annotations that must be
    /// kept consistent with their changes.
    filter?: boolean,
    /// Normally, when multiple specs are combined (for example by
    /// [`GardState.update`](#state.GardState.update)), the
    /// positions in `changes` are taken to refer to the document
    /// positions in the initial document. When a spec has `sequental`
    /// set to true, its positions will be taken to refer to the
    /// document created by the specs before it instead.
    sequential?: boolean
  }

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
      readonly type: Transaction.Annotation.Type<T>,
      /// The value of this annotation.
      readonly value: T
    ) {}

    /// Define a new type of annotation.
    static define<T>() { return new Transaction.Annotation.Type<T>() }

    // This is just to get less sloppy typing (where StateEffect is a subtype of Annotation)
    declare private _isAnnotation: true
  }

  export namespace Annotation {
    /// Marker that identifies a type of [annotation](#state.Annotation).
    export class Type<T> {
      /// Create an instance of this annotation.
      of(value: T): Transaction.Annotation<T> { return new Transaction.Annotation(this, value) }
    }
  }

  /// Transaction effects can be used to represent additional effects
  /// associated with a [transaction](#state.Transaction.effects). They
  /// are often useful to model changes to custom [state
  /// fields](#state.StateField), when those changes aren't implicit in
  /// document or selection changes.
  export class Effect<Value> {
    /// @internal
    constructor(
      /// @internal
      readonly type: Transaction.Effect.Type<Value>,
      /// The value of this effect.
      readonly value: Value
    ) {}

    /// Map this effect through a position mapping. Will return
    /// `undefined` when that ends up deleting the effect.
    map(mapping: ChangeSet): Transaction.Effect<Value> | undefined {
      let mapped = this.type.map(this.value, mapping)
      return mapped === undefined ? undefined : mapped == this.value ? this : new Transaction.Effect(this.type, mapped)
    }

    /// Tells you whether this effect object is of a given
    /// [type](#state.StateEffect.Type).
    is<T>(type: Transaction.Effect.Type<T>): this is Transaction.Effect<T> { return this.type == type as any }

    /// Define a new effect type. The type parameter indicates the type
    /// of values that his effect holds. It should be a type that
    /// doesn't include `undefined`, since that is used in
    /// [mapping](#state.StateEffect.map) to indicate that an effect is
    /// removed.
    static define<Value = null>(spec: Transaction.Effect.Spec<Value> = {}): Transaction.Effect.Type<Value> {
      return new Transaction.Effect.Type(spec.map || (v => v))
    }

    /// Map an array of effects through a change set.
    static mapEffects(effects: readonly Transaction.Effect<any>[], mapping: ChangeSet) {
      if (!effects.length) return effects
      let result = []
      for (let effect of effects) {
        let mapped = effect.map(mapping)
        if (mapped) result.push(mapped)
      }
      return result
    }

    // FIXME move these?

    /// This effect can be used to reconfigure the root extensions of
    /// the editor. Doing this will discard any extensions
    /// [appended](#state.StateEffect^appendConfig), but does not reset
    /// the content of [reconfigured](#state.Compartment.reconfigure)
    /// compartments.
    declare static reconfigure: Transaction.Effect.Type<GardState.Extension>

    /// Append extensions to the top-level configuration of the editor.
    declare static appendConfig: Transaction.Effect.Type<GardState.Extension>
  }

  export namespace Effect {
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
      of(value: Value): Transaction.Effect<Value> { return new Transaction.Effect(this, value) }
    }

    export interface Spec<Value> {
      /// Provides a way to map an effect like this through a position
      /// mapping. When not given, the effects will simply not be mapped.
      /// When the function returns `undefined`, that means the mapping
      /// deletes the effect.
      map?: (value: Value, mapping: ChangeSet) => Value | undefined
    }
  }
}

Transaction.Effect.reconfigure = Transaction.Effect.define<GardState.Extension>()

Transaction.Effect.appendConfig = Transaction.Effect.define<GardState.Extension>()

Transaction.time = Transaction.Annotation.define<number>()

Transaction.userEvent = Transaction.Annotation.define<string>()

Transaction.addToHistory = Transaction.Annotation.define<boolean>()

Transaction.remote = Transaction.Annotation.define<boolean>()

type ResolvedSpec = {
  changes: ChangeSet,
  selection: GardSelection | undefined,
  effects: readonly Transaction.Effect<any>[],
  annotations: readonly Transaction.Annotation<any>[],
  scrollIntoView: boolean
  filter?: boolean
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
    selection: b.selection ? b.selection.map(mapForB, () => changes.apply(doc))
      : a.selection?.map(mapForA, () => changes.apply(doc)),
    effects: Transaction.Effect.mapEffects(a.effects, mapForA).concat(Transaction.Effect.mapEffects(b.effects, mapForB)),
    annotations: a.annotations.length ? a.annotations.concat(b.annotations) : b.annotations,
    scrollIntoView: a.scrollIntoView || b.scrollIntoView,
    filter: a.filter || b.filter
  }
}

export function resolveTransactionInner(doc: Plot.Doc, spec: Transaction.Spec): ResolvedSpec {
  let changes = spec.changes instanceof ChangeSet ? spec.changes : ChangeSet.create(doc, spec.changes || [])
  let sel = spec.selection, annotations = asArray(spec.annotations)
  if (spec.userEvent) annotations = annotations.concat(Transaction.userEvent.of(spec.userEvent))
  if (typeof sel == "function") sel = sel(changes.apply(doc))
  return {
    changes,
    selection: sel && (sel instanceof GardSelection ? sel : GardSelection.Text.create(sel)),
    effects: asArray(spec.effects),
    annotations,
    scrollIntoView: !!spec.scrollIntoView,
    filter: !!spec.filter
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
    s = mergeTransaction(state.doc, s, s2, !!spec.sequential)
  }
  let tr = Transaction.create(state, s.changes, s.selection, s.effects, s.annotations, s.scrollIntoView)
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
  return spec == tr ? tr : Transaction.create(state, tr.changes, tr.selection, spec.effects,
                                              spec.annotations, spec.scrollIntoView)
}

const none: readonly any[] = []

export function asArray<T>(value: undefined | T | readonly T[]): readonly T[] {
  return value == null ? none : Array.isArray(value) ? value : [value as T]
}
