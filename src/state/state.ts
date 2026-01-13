import {Schema, Plot, Node, parseDoc, PlotPos} from "wordgard/doc"
import {EditorSelection, SelectionSpec, SelectionPos, wordAt, selectionAtStart} from "./selection"
import {Transaction, resolveTransaction, asArray, StateEffect} from "./transaction"
import {Extension, Configuration, Facet, FacetReader, StateField, Slot, SlotStatus,
        DynamicSlot, ensureAddr, getAddr, transactionFilter,
        transactionExtender, Compartment, schemaElement} from "./facet"
import {TextblockMap} from "./textblock"
import {Direction} from "./bidi"

export type StateCommand = (target: {state: EditorState, dispatch: (tr: Transaction) => void}) => boolean

function readHTML(html: string): HTMLElement {
  let detachedDoc = document.implementation.createHTMLDocument("title")
  let trustedTypes = (window as any).trustedTypes
  if (trustedTypes) {
    // With the require-trusted-types-for CSP, Chrome will block
    // innerHTML, even on a detached document. This wraps the string in
    // a way that makes the browser allow us to use its parser again.
    html = trustedTypes.createPolicy("detachedDocument", {createHTML: (s: string) => s}).createHTML(html)
  }
  let elt = detachedDoc.createElement("div")
  elt.innerHTML = html
  return elt
}

function readDoc(schema: Schema, doc: DocSource): Plot.Doc {
  if (doc instanceof Plot.Doc) {
    if (doc.schema != schema) {
      if (doc.schema.elements.some(e => !schema.elements.includes(e)))
        throw new Error("Schema mismatch between document and editor configuration")
      return schema.doc(doc.content)
    }
    return doc
  }
  if (typeof doc == "function") return doc(schema)
  if (typeof doc == "string") doc = readHTML(doc)
  let {nodeType} = doc as any
  if (nodeType === 1 || nodeType === 11) return parseDoc(schema, doc as HTMLElement | DocumentFragment)
  return schema.docFromJSON(doc as Node.JSON)
}

type DocSource = Plot.Doc | HTMLElement | DocumentFragment | string | Node.JSON | ((schema: Schema) => Plot.Doc)

export namespace EditorState {
  /// Options passed when [creating](#state.EditorState^create) an
  /// editor state.
  export interface Spec {
    /// The initial document.
    doc: DocSource
    /// The starting selection. Defaults to a cursor at the start of the
    /// document.
    selection?: EditorSelection | SelectionSpec | ((doc: Plot.Doc) => EditorSelection)
    /// Configuration for this state.
    config?: Extension | Configuration
  }
}

/// The editor state class is a persistent (immutable) data structure.
/// To update a state, you [create](#state.EditorState.update) a
/// [transaction](#state.Transaction), which produces a _new_ state
/// instance, without modifying the original object.
///
/// _Do not_ mutate properties of a state directly.
export class EditorState {
  /// @internal
  readonly status: SlotStatus[]
  /// @internal
  computeSlot: null | ((state: EditorState, slot: DynamicSlot) => SlotStatus)
  private _resolvedSel: SelectionPos | null = null
  private trackAccess: Slot[] | null = null

  private constructor(
    /// The configuration 
    readonly config: Configuration,
    private _doc: Plot.Doc,
    private _selection: EditorSelection,
    /// @internal
    readonly values: any[],
    computeSlot: (state: EditorState, slot: DynamicSlot) => SlotStatus,
    tr: Transaction | null
  ) {
    this.status = config.statusTemplate.slice()
    this.computeSlot = computeSlot
    // Fill in the computed state immediately, so that further queries
    // for it made during the update return this state
    if (tr) tr._state = this
    for (let i = 0; i < this.config.dynamicSlots.length; i++) ensureAddr(this, i << 1)
    this.computeSlot = null
  }

  /// The current document.
  get doc() {
    if (this.trackAccess) addValue(this.trackAccess, "doc")
    return this._doc
  }

  /// The current selection.
  get selection() {
    if (this.trackAccess) addValue(this.trackAccess, "selection")
    return this._selection
  }

  /// @internal
  track(slot: Slot) {
    let track = this.trackAccess
    if (!track) return null
    addValue(track, slot)
    this.trackAccess = null
    return track
  }

  /// Retrieve the value of a [state field](#state.StateField). Throws
  /// an error when the state doesn't have that field, unless you pass
  /// `false` as second parameter.
  field<T>(field: StateField<T>): T
  field<T>(field: StateField<T>, require: false): T | undefined
  field<T>(field: StateField<T>, require: boolean = true): T | undefined {
    let addr = this.config.address[field.id]
    if (addr == null) {
      if (require) throw new RangeError("Field is not present in this state")
      return undefined
    }
    let track = this.track(field)
    ensureAddr(this, addr)
    this.trackAccess = track
    return getAddr(this, addr)
  }

  /// Get the value of a state [facet](#state.Facet).
  facet<Output>(facet: FacetReader<Output>): Output {
    let track = this.track(facet)
    let addr = this.config.address[facet.id]
    if (addr == null) return facet.default
    ensureAddr(this, addr)
    this.trackAccess = track
    return getAddr(this, addr)
  }

  /// Create a [transaction](#state.Transaction) that updates this
  /// state. Any number of [transaction specs](#state.TransactionSpec)
  /// can be passed. Unless
  /// [`sequential`](#state.TransactionSpec.sequential) is set, the
  /// [changes](#state.TransactionSpec.changes) (if any) of each spec
  /// are assumed to start in the _current_ document (not the document
  /// produced by previous specs), and its
  /// [selection](#state.TransactionSpec.selection) and
  /// [effects](#state.TransactionSpec.effects) are assumed to refer
  /// to the document created by its _own_ changes. The resulting
  /// transaction contains the combined effect of all the different
  /// specs. For [selection](#state.TransactionSpec.selection), later
  /// specs take precedence over earlier ones.
  update(...specs: readonly Transaction.Spec[]): Transaction {
    return resolveTransaction(this, specs, true)
  }

  /// @internal
  applyTransaction(tr: Transaction) {
    let conf: Configuration | null = this.config, {base, compartments} = conf
    for (let effect of tr.effects) {
      if (effect.is(Compartment.reconfigureCompartment)) {
        if (conf) {
          compartments = new Map
          conf.compartments.forEach((val, key) => compartments!.set(key, val))
          conf = null
        }
        compartments.set(effect.value.compartment, effect.value.extension)
      } else if (effect.is(StateEffect.reconfigure)) {
        conf = null
        base = effect.value
      } else if (effect.is(StateEffect.appendConfig)) {
        conf = null
        base = asArray(base).concat(effect.value)
      }
    }
    let startValues
    if (!conf) {
      conf = Configuration.resolve(base, compartments, this)
      let intermediateState = new EditorState(conf, this.doc, this.selection, conf.dynamicSlots.map(() => null),
                                              (state, slot) => slot.reconfigure(state, this), null)
      startValues = intermediateState.values
    } else {
      startValues = tr.startState.values.slice()
    }
    new EditorState(conf, tr.newDoc, tr.newSelection, startValues, (state, slot) => slot.update(state, tr), tr)
  }

  /// A resolved form of the state's selection. Instead of raw
  /// positions, this object holds [document position](#doc.Pos)
  /// objects for `head`, `anchor`, `from`, and `to`.
  get sel() {
    return this._resolvedSel || (this._resolvedSel = this.selection.resolve(this.doc))
  }

  /// @internal
  recordAccess<T>(slots: Slot[], f: (state: EditorState) => T): T {
    let prev = this.trackAccess
    this.trackAccess = slots
    let result = f(this)
    this.trackAccess = prev
    return result
  }

  textblockMap(node: PlotPos) {
    return TextblockMap.get(node.start, node.node, this.textDirection(node.node.tag))
  }

  /// Convert this state to a JSON-serializable object. When custom
  /// fields should be serialized, you can pass them in as an object
  /// mapping property names (in the resulting object, which should
  /// not use `doc` or `selection`) to fields.
  toJSON(fields?: {[prop: string]: StateField<any>}): any {
    let result: any = {
      doc: this.doc.toJSON(),
      selection: this.selection.toJSON()
    }
    if (fields) for (let prop in fields) {
      let value = fields[prop]
      if (value instanceof StateField && this.config.address[value.id] != null)
        result[prop] = value.spec.toJSON!(this.field(fields[prop]), this)
    }
    return result
  }

  /// Deserialize a state from its JSON representation. When custom
  /// fields should be deserialized, pass the same object you passed
  /// to [`toJSON`](#state.EditorState.toJSON) when serializing as
  /// third argument.
  static fromJSON(json: any, extensions: Extension, fields?: {[prop: string]: StateField<any>}): EditorState {
    if (!json)
      throw new RangeError("Invalid JSON representation for EditorState")
    let fieldInit = []
    if (fields) for (let prop in fields) {
      if (Object.prototype.hasOwnProperty.call(json, prop)) {
        let field = fields[prop], value = json[prop]
        fieldInit.push(field.init(state => field.spec.fromJSON!(value, state)))
      }
    }
    let config = Configuration.create([extensions, fieldInit])
    let schema = Schema.define(config.staticFacet(schemaElement))
    return EditorState.fromConfig(config, schema.docFromJSON(json.doc), EditorSelection.fromJSON(schema, json.selection))
  }

  /// Create a new state. You'll usually only need this when
  /// initializing an editor—updated states are created by applying
  /// transactions.
  static create(spec: EditorState.Spec): EditorState {
    let config = spec.config instanceof Configuration ? spec.config : Configuration.resolve(spec.config || [], new Map)
    let configSchema = config.staticFacet(schemaElement)
    let schema = spec.doc instanceof Plot.Doc ? spec.doc.schema.append(configSchema) : Schema.define(configSchema)
    let doc = readDoc(schema, spec.doc)
    let selection = !spec.selection ? selectionAtStart({
      doc,
      textDirection: config.staticFacet(EditorState.textDirection),
      visualCursorMotion: config.staticFacet(EditorState.visualCursorMotion),
    })
      : typeof spec.selection == "function" ? spec.selection(doc)
      : spec.selection instanceof EditorSelection ? spec.selection
      : EditorSelection.create(spec.selection)
    return EditorState.fromConfig(config, doc, selection)
  }

  /// @internal
  static fromConfig(config: Configuration, doc: Plot.Doc, selection: EditorSelection) {
    selection.check(doc)
    if (config.staticFacet(EditorState.validateDoc)) doc.schema.validate(doc)
    return new EditorState(config, doc, selection, config.dynamicSlots.map(() => null),
                           (state, slot) => slot.create(state), null)
  }

  /// This facet controls the value of the
  /// [`readOnly`](#state.EditorState.readOnly) getter, which is
  /// consulted by commands and extensions that implement editing
  /// functionality to determine whether they should apply. It
  /// defaults to false, but when its highest-precedence value is
  /// `true`, such functionality disables itself.
  ///
  /// Not to be confused with
  /// [`EditorView.editable`](#view.EditorView^editable), which
  /// controls whether the editor's DOM is set to be editable (and
  /// thus focusable).
  static readOnly = Facet.define<boolean, boolean>({
    combine: values => values.length ? values[0] : false
  })

  static validateDoc = Facet.define<boolean, boolean>({
    combine: values => values.length ? values[0] : true,
    static: true
  })

  /// Returns true when the editor is
  /// [configured](#state.EditorState^readOnly) to be read-only.
  get readOnly() { return this.facet(EditorState.readOnly) }

  /// Registers translation phrases. The
  /// [`phrase`](#state.EditorState.phrase) method will look through
  /// all objects registered with this facet to find translations for
  /// its argument.
  static phrases = Facet.define<{[key: string]: string}>({
    compare(a, b) {
      let kA = Object.keys(a), kB = Object.keys(b)
      return kA.length == kB.length && kA.every(k => a[k as any] == b[k as any])
    }
  })

  /// Look up a translation for the given phrase (via the
  /// [`phrases`](#state.EditorState^phrases) facet), or return the
  /// original string if no translation is found.
  ///
  /// If additional arguments are passed, they will be inserted in
  /// place of markers like `$1` (for the first value) and `$2`, etc.
  /// A single `$` is equivalent to `$1`, and `$$` will produce a
  /// literal dollar sign.
  phrase(phrase: string, ...insert: any[]): string {
    for (let map of this.facet(EditorState.phrases))
      if (Object.prototype.hasOwnProperty.call(map, phrase)) { phrase = map[phrase]; break }
    if (insert.length) phrase = phrase.replace(/\$(\$|\d*)/g, (m, i) => {
      if (i == "$") return "$"
      let n = +(i || 1)
      return !n || n > insert.length ? m : insert[n - 1]
    })
    return phrase
  }

  /// Configure the text direction in the editor. A `Direction` value
  /// sets the direction for the entire editor. A function is
  /// consulted for a given textblock tag to determine the direction
  /// in that block, or given `null` to query the direction outside of
  /// textblocks. When multiple values are given, they are consulted
  /// in order of precedence.
  static textDirection = Facet.define<Direction | ((tag?: Plot.Tag.Any) => Direction | null), (tag?: Plot.Tag.Any) => Direction>({
    combine(values) {
      return (tag?: Plot.Tag.Any) => {
        for (let elt of values) {
          if (typeof elt != "function") return elt
          let result = elt(tag)
          if (result != null) return result
        }
        return Direction.LTR
      }
    },
    static: true
  })

  /// Return the text direction in a given textblock (by tag) or the
  /// global default direction (when no tag is given).
  get textDirection() {
    return this.facet(EditorState.textDirection)
  }

  static visualCursorMotion = Facet.define<boolean, boolean>({
    combine(values) { return !values.length ? true : values[0] },
    static: true
  })

  get visualCursorMotion() {
    return this.facet(EditorState.visualCursorMotion)
  }

  wordAt(pos: number, bias: -1 | 1 = 1) {
    return wordAt(this, pos, bias)
  }

  /// @hidden
  static isAtom = Facet.define<(state: EditorState, node: Plot, pos: number) => boolean | null>()

  isAtom(pos: number, node: Node = this.doc.nodeAt(pos)!) {
    if (!node) throw new Error("No node at position " + pos)
    if (node.isLeaf) return true
    for (let src of this.facet(EditorState.isAtom)) {
      let result = src(this, node, pos)
      if (result != null) return result
    }
    return node.tag.type.shape.atom
  }

  /// Facet used to register a hook that gets a chance to update or
  /// replace transaction specs before they are applied. This will
  /// only be applied for transactions that don't have
  /// [`filter`](#state.TransactionSpec.filter) set to `false`. You
  /// can either return a single transaction spec (possibly the input
  /// transaction), or an array of specs (which will be combined in
  /// the same way as the arguments to
  /// [`EditorState.update`](#state.EditorState.update)).
  ///
  /// When possible, it is recommended to avoid accessing
  /// [`Transaction.state`](#state.Transaction.state) in a filter,
  /// since it will force creation of a state that will then be
  /// discarded again, if the transaction is actually filtered.
  ///
  /// (This functionality should be used with care. Indiscriminately
  /// modifying transaction is likely to break something or degrade
  /// the user experience.)
  static transactionFilter = transactionFilter

  /// This is a more limited form of
  /// [`transactionFilter`](#state.EditorState^transactionFilter),
  /// which can only add
  /// [annotations](#state.TransactionSpec.annotations) and
  /// [effects](#state.TransactionSpec.effects). _But_, this type
  /// of filter runs even if the transaction has disabled regular
  /// [filtering](#state.TransactionSpec.filter), making it suitable
  /// for effects that don't need to touch the changes or selection,
  /// but do want to process every transaction.
  ///
  /// Extenders run _after_ filters, when both are present.
  static transactionExtender = transactionExtender
}

function addValue<T>(set: T[], value: T) {
  if (set.indexOf(value) < 0) set.push(value)
}
