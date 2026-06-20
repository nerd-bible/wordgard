import {Schema, Plot, Node, Pos, parse, SchemaError, ValidationError} from "wordgard/doc"
import {SelectionType, GardSelection, wordAt, cursorAtStart} from "./selection"
import {Transaction, resolveTransaction, asArray} from "./transaction"
import {TextblockMap} from "./textblock"

let nextID = 0

const none: readonly any[] = []

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
  if (doc instanceof Plot.Doc)
    return doc.schema == schema ? doc : schema.doc(doc.content)
  if (typeof doc == "function") return doc(schema)
  if (typeof doc == "string") doc = readHTML(doc)
  let {nodeType} = doc as any
  if (nodeType === 1 || nodeType === 11) return parse(schema, doc as HTMLElement | DocumentFragment)
  return schema.docFromJSON(doc as Node.JSON)
}

type DocSource = Plot.Doc | HTMLElement | DocumentFragment | string | Node.JSON | ((schema: Schema) => Plot.Doc)

/// The editor state tracks things like the current document, the
/// selection, the configuration of the editor, and any extra state
/// defined by extensions.
///
/// The state is a persistent (immutable) data structure. To update a
/// state, you {@link GardState.update create} a {@link Transaction
/// transaction}, which produces a _new_ state instance, without
/// modifying the original object.
export class GardState {
  /// @internal
  readonly status: SlotStatus[]
  /// @internal
  computeSlot: null | ((state: GardState, slot: DynamicSlot) => SlotStatus)
  private resolvedSel: GardSelection.Resolved | null = null
  private trackAccess: Slot[] | null = null

  /// Create a new state. You'll usually only need this when
  /// initializing an editor or loading a new document—updated states
  /// are created by applying transactions.
  ///
  /// The schema of the state can be provided either via the {@link
  /// GardState.schemaElement configuration} or by passing in an
  /// initialized document (which will have its own schema). If the
  /// configuration contains a document plot type, the schema from the
  /// configuration will be used, even if a document was provided.
  static create(spec: GardState.Spec): GardState {
    let config = spec.config instanceof GardState.Configuration ? spec.config
      : GardState.Configuration.resolve(spec.config || [], new Map)
    let configSchema = config.staticFacet(GardState.schemaElement)
    let configHasDoc = configSchema.some(elt => elt instanceof Plot.Type && elt.isDoc), schema
    if (configHasDoc) schema = Schema.define(configSchema)
    else if (spec.doc instanceof Plot.Doc) schema = spec.doc.schema
    else throw new SchemaError(`No document plot provided, unable to create schema`)
    let doc = readDoc(schema, spec.doc)
    let selection = !spec.selection ? cursorAtStart({doc, config})
      : typeof spec.selection == "function" ? spec.selection({doc, config})
      : spec.selection instanceof GardSelection ? spec.selection
      : GardSelection.Text.create(spec.selection)
    return GardState.fromConfig(config, doc, selection)
  }

  private constructor(
    /// The configuration for this state.
    readonly config: GardState.Configuration,
    private _doc: Plot.Doc,
    private _selection: GardSelection,
    /// @internal
    readonly values: any[],
    computeSlot: (state: GardState, slot: DynamicSlot) => SlotStatus,
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

  /// The document's schema.
  get schema() {
    if (this.trackAccess) addValue(this.trackAccess, "schema")
    return this._doc.schema
  }

  /// The current selection.
  get selection() {
    if (this.trackAccess) addValue(this.trackAccess, "selection")
    return this._selection
  }

  /// A resolved form of the state's selection. Instead of raw
  /// positions, this object holds {@link Pos document position}
  /// objects for `head`, `anchor`, `from`, and `to`.
  get sel() {
    return this.resolvedSel || (this.resolvedSel = this.selection.resolve(this.doc))
  }

  /// Retrieve the value of a {@link GardState.Field state field}.
  /// Throws an error when the state doesn't have that field, unless
  /// you pass `false` as second parameter.
  field<T>(field: GardState.Field<T>): T
  field<T>(field: GardState.Field<T>, require: false): T | undefined
  field<T>(field: GardState.Field<T>, require: boolean = true): T | undefined {
    let addr = this.config.address[field.id]
    if (addr == null) {
      if (require) throw new RangeError("Field is not present in this state")
      return undefined
    }
    let track = this.trackAccess
    if (track) {
      addValue(track, field)
      track = null
    }
    ensureAddr(this, addr)
    if (track) this.trackAccess = track
    return getAddr(this, addr)
  }

  /// Get the value of a state {@link GardState.Facet facet}.
  facet<Output>(facet: GardState.Facet.Reader<Output>): Output {
    if (this.trackAccess) addValue(this.trackAccess, facet)
    let addr = this.config.address[facet.id]
    if (addr == null) return facet.default
    ensureAddr(this, addr)
    return getAddr(this, addr)
  }

  /// Create a {@link Transaction transaction} that updates this
  /// state. Any number of {@link Transaction.Spec transaction specs}
  /// can be passed. Unless {@link Transaction.Spec.sequential
  /// `sequential`} is set, the {@link Transaction.Spec.changes
  /// changes} (if any) of each spec are assumed to start in the
  /// _current_ document (not the document produced by previous
  /// specs), and its {@link Transaction.Spec.selection selection} and
  /// {@link Transaction.Spec.effects effects} are assumed to refer to
  /// the document created by its _own_ changes. The resulting
  /// transaction contains the combined effect of all the different
  /// specs. For {@link Transaction.Spec.selection selection}, later
  /// specs take precedence over earlier ones.
  update(...specs: readonly Transaction.Spec[]): Transaction {
    return specs.length == 1 && specs[0] instanceof Transaction ? specs[0] : resolveTransaction(this, specs)
  }

  /// @internal
  applyTransaction(tr: Transaction) {
    let conf: GardState.Configuration | null = this.config, {base, compartments} = conf
    for (let effect of tr.effects) {
      if (effect.is(GardState.Compartment.reconfigureCompartment)) {
        if (conf) {
          compartments = new Map
          conf.compartments.forEach((val, key) => compartments!.set(key, val))
          conf = null
        }
        compartments.set(effect.value.compartment, effect.value.extension)
      } else if (effect.is(GardState.reconfigure)) {
        conf = null
        base = effect.value
      } else if (effect.is(GardState.appendConfig)) {
        conf = null
        base = asArray(base).concat(effect.value)
      }
    }
    let startValues, doc = tr.newDoc
    if (!conf) {
      conf = GardState.Configuration.resolve(base, compartments, this)
      let intermediateState = new GardState(conf, this.doc, this.selection, conf.dynamicSlots.map(() => null),
                                            (state, slot) => slot.reconfigure(state, this), null)
      startValues = intermediateState.values
      let schemaElts = conf.staticFacet(GardState.schemaElement)
      if (schemaElts != this.facet(GardState.schemaElement) &&
        schemaElts.some(elt => elt instanceof Plot.Type && elt.isDoc))
        doc = Schema.define(schemaElts).doc(doc.content)
    } else {
      startValues = tr.startState.values.slice()
    }
    new GardState(conf, doc, tr.newSelection, startValues, (state, slot) => slot.update(state, tr), tr)
  }

  /// @internal
  recordAccess<T>(slots: Slot[] | null, f: (state: GardState) => T): T {
    let prev = this.trackAccess
    this.trackAccess = slots
    let result = f(this)
    this.trackAccess = prev
    return result
  }

  /// Compute the textblock map for the given plot (which should be a
  /// textblock).
  textblockMap(node: Pos.Plot) {
    return TextblockMap.get(node.start, node.node, this.textblockLTR(node.node))
  }

  /// Convert this state to a JSON-serializable object. When custom
  /// fields should be serialized, you can pass them in as an object
  /// mapping property names (in the resulting object, which should
  /// not use `doc` or `selection`) to fields.
  toJSON(fields?: {[prop: string]: GardState.Field<any>}): any {
    let result: any = {
      doc: this.doc.toJSON(),
      selection: this.selection.toJSON(this)
    }
    if (fields) for (let prop in fields) {
      let value = fields[prop]
      if (value instanceof GardState.Field && this.config.address[value.id] != null)
        result[prop] = value.spec.toJSON!(this.field(fields[prop]), this)
    }
    return result
  }

  /// Deserialize a state from its JSON representation. When custom
  /// fields should be deserialized, pass the same object you passed
  /// to {@link GardState.toJSON `toJSON`} when serializing as third
  /// argument.
  static fromJSON(json: any, extensions: GardState.Extension, fields?: {[prop: string]: GardState.Field<any>}): GardState {
    if (!json)
      throw new ValidationError("Invalid JSON representation for GardState")
    let fieldInit = []
    if (fields) for (let prop in fields) {
      if (Object.prototype.hasOwnProperty.call(json, prop)) {
        let field = fields[prop], value = json[prop]
        fieldInit.push(field.init(state => field.spec.fromJSON!(value, state)))
      }
    }
    let config = GardState.Configuration.create([extensions, fieldInit])
    let schema = Schema.define(config.staticFacet(GardState.schemaElement))
    let doc = schema.docFromJSON(json.doc)
    return GardState.fromConfig(config, doc, GardSelection.fromJSON({config, doc}, json.selection))
  }

  /// @internal
  static fromConfig(config: GardState.Configuration, doc: Plot.Doc, selection: GardSelection) {
    selection.check(config, doc)
    return new GardState(config, doc, selection, config.dynamicSlots.map(() => null),
                         (state, slot) => slot.create(state), null)
  }

  /// Returns true when the editor is {@link GardState.readOnly} to be
  /// read-only.
  get readOnly() { return this.facet(GardState.readOnly) }

  /// Get the global text direction (true when left-to-right, false
  /// when right-to-left) for the document. Note that the direction of
  /// individual blocks can be overridden with {@link
  /// GardState.textblockLTR}.
  get textLTR() { return this.config.textLTR }

  /// Return the text direction in a given textblock (by tag).
  textblockLTR(plot: Plot) { return this.config.textblockLTR(plot) }

  /// Return the extent of the word around the given position, as a
  /// text selection.
  wordAt(pos: number, bias: -1 | 1 = 1) {
    return wordAt(this, pos, bias)
  }

  /// This effect can be used to reconfigure the root extensions of
  /// the editor. Doing this will discard any extensions {@link
  /// GardState.appendConfig appended}, but does not reset the
  /// content of {@link GardState.Compartment.reconfigure
  /// reconfigured} compartments.
  static reconfigure = Transaction.Effect.define<GardState.Extension>()

  /// Append extensions to the top-level configuration of the editor.
  static appendConfig = Transaction.Effect.define<GardState.Extension>()
}

export namespace GardState {
  /// Options passed when {@link GardState.create creating} an editor
  /// state.
  export interface Spec {
    /// The initial document. When passing in a document here, it is
    /// not necessary to include a schema in your configuration
    /// (though it is allowed, and the document content will be moved
    /// into that schema if it differs from the one on the given
    /// document).
    ///
    /// All other forms require a schema from the configuration. A
    /// string or DOM structure will be parsed as HTML, a JSON node
    /// deserialized, and a function called to produce the document.
    doc: DocSource
    /// The starting selection. Defaults to a cursor at the start of the
    /// document.
    selection?: GardSelection | GardSelection.Text.Spec | ((cx: GardSelection.Context) => GardSelection)
    /// The configuration for this state, either as a resolved {@link
    /// GardState.Configuration} or as a set of extensions.
    config?: GardState.Extension | GardState.Configuration
  }

  /// Fields can store additional information in an editor state, and
  /// keep it in sync with the rest of the state. The type parameter
  /// indicates the type of value stored in the field.
  export class Field<Value> {
    /// @internal
    public provides: GardState.Extension | undefined = undefined

    private constructor(
      /// @internal
      readonly id: number,
      private createF: (state: GardState) => Value,
      private updateF: (value: Value, tr: Transaction) => Value,
      private compareF: (a: Value, b: Value) => boolean,
      /// @internal
      readonly spec: GardState.Field.Spec<Value>
    ) {}

    /// Define a state field.
    static define<Value>(config: GardState.Field.Spec<Value>): GardState.Field<Value> {
      let field = new GardState.Field<Value>(nextID++, config.create, config.update,
                                             config.compare || ((a, b) => a === b), config)
      if (config.provide) field.provides = config.provide(field)
      return field
    }

    private create(state: GardState) {
      let init = state.facet(initField).find(i => i.field == this)
      return (init?.create || this.createF)(state)
    }

    /// @internal
    slot(addresses: {[id: number]: number}): DynamicSlot {
      let idx = addresses[this.id] >> 1
      return {
        create: (state) => {
          state.values[idx] = this.create(state)
          return SlotStatus.Changed
        },
        update: (state, tr) => {
          let oldVal = state.values[idx]
          let value = this.updateF(oldVal, tr)
          if (this.compareF(oldVal, value)) return 0
          state.values[idx] = value
          return SlotStatus.Changed
        },
        reconfigure: (state, oldState) => {
          if (oldState.config.address[this.id] != null) {
            state.values[idx] = oldState.field(this)
            return 0
          }
          state.values[idx] = this.create(state)
          return SlotStatus.Changed
        }
      }
    }

    /// State field instances can be used as {@link
    /// GardState.Extension `Extension`} values to enable the field in
    /// a given state.
    get extension(): GardState.Extension { return this }

    /// Returns an extension that enables this field and overrides the
    /// way it is initialized. Can be useful when you need to provide a
    /// non-default starting value for the field.
    init(create: (state: GardState) => Value): GardState.Extension {
      return [this, initField.of({field: this as any, create})]
    }
  }

  export namespace Field {
    /// The options passed when defining a state field.
    export type Spec<Value> = {
      /// Creates the initial value for the field when a state is created.
      create: (state: GardState) => Value,

      /// Compute a new value from the field's previous value and a
      /// {@link Transaction transaction}. Should not mutate the old
      /// value (since that will change the existing state), but
      /// create a fresh one or return the old value unchanged.
      update: (value: Value, transaction: Transaction) => Value,

      /// Compare two values of the field, returning `true` when they are
      /// the same. This is used to avoid recomputing facets that depend
      /// on the field when its value did not change. Defaults to using
      /// `===`.
      compare?: (a: Value, b: Value) => boolean,

      /// Provide extensions based on this field. The given function
      /// will be called once with the initialized field. It is
      /// typically used with a facet's {@link GardState.Facet.from}
      /// method to create facet inputs from this field, but can also
      /// return other extensions that should be enabled when the
      /// field is present in a configuration.
      provide?: (field: GardState.Field<Value>) => GardState.Extension

      /// A function used to serialize this field's content to JSON. Only
      /// necessary when this field is included in the argument to
      /// {@link GardState.toJSON}.
      toJSON?: (value: Value, state: GardState) => any

      /// A function that deserializes the JSON representation of this
      /// field's content.
      fromJSON?: (json: any, state: GardState) => Value
    }
  }

  /// A facet is a labeled value that is associated with an editor
  /// state. It takes inputs from any number of extensions, and combines
  /// those into a single output value.
  ///
  /// Examples of uses of facets are the {@link GardState.readOnly
  /// read-only configuration}, {@link
  /// editor.Wordgard.editorAttributes editor attributes}, and {@link
  /// editor.Wordgard.afterUpdate update listeners}.
  ///
  /// Note that `Facet` instances can be used anywhere where {@link
  /// GardState.Facet.Reader} is expected.
  ///
  /// Facets have an input type (the type of values provided for it),
  /// and an output type (the type you get when you read the facet)
  /// that defaults to an array of input values, but can be anything
  /// if a {@link GardState.Facet.Spec.combine}
  /// option is provided.
  export class Facet<Input, Output = readonly Input[]> implements GardState.Facet.Reader<Output> {
    /// @internal
    readonly id = nextID++
    /// The output of the facet when it has no inputs.
    readonly default: Output
    /// @internal
    readonly extensions: GardState.Extension | undefined

    private constructor(
      /// @internal
      readonly combine: (values: readonly Input[]) => Output,
      /// @internal
      readonly compareInput: (a: Input, b: Input) => boolean,
      /// @internal
      readonly compare: (a: Output, b: Output) => boolean,
      /// True when this is a static facet.
      readonly isStatic: boolean,
      enables: GardState.Extension | undefined | ((self: GardState.Facet<Input, Output>) => GardState.Extension)
    ) {
      this.default = combine(none)
      this.extensions = typeof enables == "function" ? enables(this) : enables
    }

    /// A facet reader for this facet, which can be used to {@link
    /// GardState.facet read} it but not to define values for it.
    get reader(): GardState.Facet.Reader<Output> { return this }

    /// Defines a facet with the given input an output types.
    static define<Input, Output = readonly Input[]>(config: GardState.Facet.Spec<Input, Output> = {}) {
      return new GardState.Facet<Input, Output>(config.combine || ((a: any) => a) as any,
                                                config.compareInput || ((a, b) => a === b),
                                                config.compare || (!config.combine ? sameArray as any : (a, b) => a === b),
                                                !!config.static,
                                                config.enables)
    }

    /// Returns an extension that provides the given value to this
    /// facet.
    of(value: Input): GardState.Extension {
      return new FacetProvider<Input>(none, this, ProviderFlag.Static, value)
    }

    /// Create an extension that computes a value for the facet from a
    /// state. The given function should only depend on the state, not
    /// any external non-constant inputs. Its return value will be kept
    /// on state update, unless any of the fields or facets (including
    /// document and selection) that it read are changed by the update,
    /// in which case it is called again.
    ///
    /// In cases where your value depends only on a single field, you
    /// can use the {@link GardState.Facet.from `from`} method
    /// instead.
    compute(get: (state: GardState) => Input): GardState.Extension {
      if (this.isStatic) throw new Error("Can't compute a static facet")
      return new FacetProvider<Input>([], this, ProviderFlag.Auto, get)
    }

    /// Create an extension that computes zero or more values for this
    /// facet from a state.
    computeN(get: (state: GardState) => readonly Input[]): GardState.Extension {
      if (this.isStatic) throw new Error("Can't compute a static facet")
      return new FacetProvider<Input>([], this, ProviderFlag.Multi | ProviderFlag.Auto, get)
    }

    /// Shorthand method for registering a facet source with a state
    /// field as input. If the field's type corresponds to this facet's
    /// input type, the getter function can be omitted. If given, it
    /// will be used to produce the input from the field value.
    from<T extends Input>(field: GardState.Field<T>): GardState.Extension
    from<T>(field: GardState.Field<T>, get: (value: T) => Input): GardState.Extension
    from<T>(field: GardState.Field<T>, get?: (value: T) => Input): GardState.Extension {
      if (this.isStatic) throw new Error("Can't compute a static facet")
      if (!get) get = x => x as any
      return new FacetProvider<Input>([field], this, 0 as ProviderFlag, state => get!(state.field(field)))
    }

    tag!: Output
  }

  export namespace Facet {
    /// Options passed when {@link GardState.Facet.define defining} a
    /// facet.
    export type Spec<Input, Output> = {
      /// How to combine the input values into a single output value. When
      /// not given, the array of input values becomes the output. This
      /// function will immediately be called on creating the facet, with
      /// an empty array, to compute the facet's default value when no
      /// inputs are present.
      combine?: (value: readonly Input[]) => Output,
      /// How to compare output values to determine whether the value
      /// of the facet changed. When a new value for the facet is
      /// computed that that compares as equal to the old value, the
      /// old value is kept. So in most circumstances, facet values
      /// can be cheaply compared by identity to check for changes.
      /// Defaults to comparing by `===` or, if no `combine` function
      /// was given, comparing each element of the array with `===`.
      compare?: (a: Output, b: Output) => boolean,
      /// How to compare input values to avoid recomputing the output
      /// value when no inputs changed. Defaults to comparing with `===`.
      compareInput?: (a: Input, b: Input) => boolean,
      /// Forbids dynamic inputs to this facet. Allows the facet to be
      /// {@link GardState.Configuration.staticFacet read} from a
      /// configuration.
      static?: boolean,
      /// If given, these extensions (or the result of calling the
      /// given function with the facet) will be added to any state
      /// where this facet is provided. (Note that, while a facet's
      /// {@link GardState.Facet.default default} value can be read
      /// from a state even if the facet wasn't present in the state
      /// at all, the extensions won't be added in that situation.)
      enables?: GardState.Extension | ((self: GardState.Facet<Input, Output>) => GardState.Extension)
    }

    /// A facet reader can be used to fetch the value of a facet,
    /// through {@link GardState.facet} or as a dependency in {@link
    /// GardState.Facet.compute `Facet.compute`}, but not to define
    /// new values for the facet.
    export type Reader<Output> = {
      /// @internal
      id: number
      /// @internal
      default: Output
      /// @hidden
      tag: Output
    }

    /// Utility function for combining multiple configuration objects.
    /// `defaults` should hold default values for all optional fields
    /// in `Config`.
    ///
    /// The function will, by default, raise an error when a field
    /// gets two values that aren't `===`-equal, but you can provide
    /// combine functions per field to do something else.
    export function combineConfig<Config extends object>(
      configs: readonly Partial<Config>[],
      defaults: Partial<Config>, // Should hold only the optional properties of Config, but I haven't managed to express that
      combine: {[P in keyof Config]?: (first: Config[P], second: Config[P]) => Config[P]} = {}
    ): Config {
      let result: any = {}
      for (let config of configs) for (let key of Object.keys(config) as (keyof Config)[]) {
        let value = config[key], current = result[key]
        if (current === undefined) result[key] = value
        else if (current === value || value === undefined) {} // No conflict
        else if (Object.hasOwnProperty.call(combine, key)) result[key] = combine[key]!(current as any, value as any)
        else throw new Error("Config merge conflict for field " + (key as string))
      }
      for (let key in defaults) if (result[key] === undefined) result[key] = defaults[key]
      return result
    }
  }

  /// A state configuration stores a set of extensions, structured so
  /// that state updates can be performed efficiently.
  export class Configuration {
    /// @internal
    readonly statusTemplate: SlotStatus[] = []

    private constructor(
      /// The set of extensions that this configuration is based on.
      readonly base: GardState.Extension,
      /// @internal
      readonly compartments: Map<GardState.Compartment, GardState.Extension>,
      /// @internal
      readonly dynamicSlots: DynamicSlot[],
      /// @internal
      readonly address: {[id: number]: number},
      /// @internal
      readonly staticValues: readonly any[],
      /// @internal
      readonly facets: {[id: number]: readonly FacetProvider<any>[]}
    ) {
      while (this.statusTemplate.length < dynamicSlots.length)
        this.statusTemplate.push(SlotStatus.Unresolved)
    }

    /// Read the value of a static facet.
    staticFacet<Output>(facet: GardState.Facet<any, Output>): Output {
      if (!facet.isStatic) throw new Error("Only static facets can be accessed from a configuration")
      let addr = this.address[facet.id]
      return addr == null ? facet.default : this.staticValues[addr >> 1]
    }

    /// @internal
    static resolve(base: GardState.Extension, compartments: Map<GardState.Compartment, GardState.Extension>, oldState?: GardState) {
      let fields: GardState.Field<any>[] = []
      let facets: {[id: number]: FacetProvider<any>[]} = Object.create(null)
      let newCompartments = new Map<GardState.Compartment, GardState.Extension>()

      for (let ext of flatten(base, compartments, newCompartments)) {
        if (ext instanceof FacetProvider) (facets[ext.facet.id] || (facets[ext.facet.id] = [])).push(ext)
        else fields.push(ext)
      }

      let address: {[id: number]: number} = Object.create(null)
      let staticValues: any[] = []
      let dynamicSlots: ((address: {[id: number]: number}) => DynamicSlot)[] = []

      for (let field of fields) {
        address[field.id] = dynamicSlots.length << 1
        dynamicSlots.push(a => field.slot(a))
      }

      let oldFacets = oldState?.config.facets
      for (let id in facets) {
        let providers = facets[id], facet = providers[0].facet
        let oldProviders = oldFacets && oldFacets[id] || none
        if (providers.every(p => p.flags & ProviderFlag.Static)) {
          address[facet.id] = (staticValues.length << 1) | 1
          if (sameArray(oldProviders, providers)) {
            staticValues.push(oldState!.facet(facet))
          } else {
            let value = facet.combine(providers.map(p => p.value))
            staticValues.push(oldState && facet.compare(value, oldState.facet(facet)) ? oldState.facet(facet) : value)
          }
        } else {
          for (let p of providers) {
            if (p.flags & ProviderFlag.Static) {
              address[p.id] = (staticValues.length << 1) | 1
              staticValues.push(p.value)
            } else {
              address[p.id] = dynamicSlots.length << 1
              dynamicSlots.push(a => p.dynamicSlot(a))
            }
          }
          address[facet.id] = dynamicSlots.length << 1
          dynamicSlots.push(a => dynamicFacetSlot(a, facet, providers))
        }
      }

      let dynamic = dynamicSlots.map(f => f(address))
      return new GardState.Configuration(base, newCompartments, dynamic, address, staticValues, facets)
    }

    /// Create a configuration from the given set of extensions.
    static create(extensions: GardState.Extension) {
      return GardState.Configuration.resolve(extensions, new Map)
    }

    // Kludge to avoid cyclic dep with ./selection
    /// @internal
    get textLTR() { return this.staticFacet(GardState.textLTR) }
    /// @internal
    textblockLTR(plot: Plot) {
      for (let f of this.staticFacet(GardState.textblockLTR)) {
        let result = f(plot)
        if (result != null) return result
      }
      return this.textLTR
    }
    /// @internal
    get visualCursorMotion() { return this.staticFacet(GardState.visualCursorMotion) }
  }

  function flatten(extension: GardState.Extension, compartments: Map<GardState.Compartment, GardState.Extension>, newCompartments: Map<GardState.Compartment, GardState.Extension>) {
    let result: (FacetProvider<any> | GardState.Field<any>)[][] = [[], [], [], [], []]
    let seen = new Map<GardState.Extension, number>()
    function inner(ext: GardState.Extension, prec: number) {
      let known = seen.get(ext)
      if (known != null) {
        if (known <= prec) return
        let found = result[known].indexOf(ext as any)
        if (found > -1) result[known].splice(found, 1)
        if (ext instanceof CompartmentInstance) newCompartments.delete(ext.compartment)
      }
      seen.set(ext, prec)
      if (Array.isArray(ext)) {
        for (let e of ext) inner(e, prec)
      } else if (ext instanceof CompartmentInstance) {
        if (newCompartments.has(ext.compartment))
          throw new RangeError(`Duplicate use of compartment in extensions`)
        let content = compartments.get(ext.compartment) || ext.inner
        newCompartments.set(ext.compartment, content)
        inner(content, prec)
      } else if (ext instanceof PrecExtension) {
        inner(ext.inner, ext.prec)
      } else if (ext instanceof GardState.Field) {
        result[prec].push(ext)
        if (ext.provides) inner(ext.provides, prec)
      } else if (ext instanceof FacetProvider) {
        result[prec].push(ext)
        if (ext.facet.extensions) inner(ext.facet.extensions, Prec.Default)
      } else {
        let content = (ext as any).extension
        if (!content) throw new Error(`Unrecognized extension value in extension set (${ext}). This sometimes happens because multiple instances of @codemirror/state are loaded, breaking instanceof checks.`)
        inner(content, prec)
      }
    }
    inner(extension, Prec.Default)
    return result.reduce((a, b) => a.concat(b))
  }

  /// Extension values can be {@link GardState.Spec.config provided}
  /// when creating a state to attach various kinds of configuration
  /// and behavior information. They can either be built-in
  /// extension-providing objects, such as {@link GardState.Field
  /// state fields} or {@link GardState.Facet.of facet providers}, or
  /// objects with an extension in its `extension` property.
  /// Extensions can be nested in arrays arbitrarily deep—they will be
  /// flattened when resolved into a configuration.
  export type Extension = {extension: GardState.Extension} | readonly GardState.Extension[]

  /// By default extensions are registered in the order they are found
  /// in the flattened form of the configuration's extension tree.
  /// Individual extension values can be assigned a precedence to
  /// override this. Extensions that do not have a precedence set get
  /// the precedence of the nearest parent with a precedence, or
  /// {@link GardState.prec.default `default`} if there is no such
  /// parent. The final ordering of extensions is determined by first
  /// sorting by precedence and then by order within each precedence.
  export const prec = {
    /// The highest precedence level, for extensions that should end up
    /// near the start of the precedence ordering.
    highest: mkPrec(Prec.Highest),
    /// A higher-than-default precedence, for extensions that should
    /// come before those with default precedence.
    high: mkPrec(Prec.High),
    /// The default precedence, which is also used for extensions
    /// without an explicit precedence.
    default: mkPrec(Prec.Default),
    /// A lower-than-default precedence.
    low: mkPrec(Prec.Low),
    /// The lowest precedence level. Meant for things that should end up
    /// near the end of the extension order.
    lowest: mkPrec(Prec.Lowest)
  }

  /// Extension compartments can be used to make a configuration
  /// dynamic. By {@link GardState.Compartment.of wrapping} part of your
  /// configuration in a compartment, you can later {@link
  /// GardState.Compartment.reconfigure replace} that part through a
  /// transaction.
  export class Compartment {
    private constructor() {}

    /// Define a new compartment.
    static define() { return new Compartment }

    /// Create an instance of this compartment to add to your {@link
    /// GardState.Spec.config state configuration}.
    of(ext: GardState.Extension): GardState.Extension { return new CompartmentInstance(this, ext) }

    /// Create an {@link Transaction.Spec.effects effect} that
    /// reconfigures this compartment.
    reconfigure(content: GardState.Extension): Transaction.Effect<unknown> {
      return GardState.Compartment.reconfigureCompartment.of({compartment: this, extension: content})
    }

    /// Get the current content of the compartment in the state, or
    /// `undefined` if it isn't present.
    get(state: GardState): GardState.Extension | undefined {
      return state.config.compartments.get(this)
    }

    /// @internal
    static reconfigureCompartment = Transaction.Effect.define<{compartment: GardState.Compartment, extension: GardState.Extension}>()
  }

  /// Facet used to register {@link Schema schema} elements. *If*
  /// a configuration contains a {@link Plot.defineDoc document}
  /// type, the editor's document schema will be derived from the
  /// content of this facet. (Otherwise, the state will try to use the
  /// schema provided via the {@link GardState.Spec.doc} option, or
  /// raise an error is none is provided.)
  export const schemaElement = GardState.Facet.define<Schema.Element | readonly Schema.Element[], readonly Schema.Element[]>({
    combine: values => values.reduce((set: readonly Schema.Element[], elt) => set.concat(elt), none),
    static: true
  })

  /// This facet controls the value of the {@link GardState.readOnly
  /// `readOnly` getter}, which is consulted by commands and
  /// extensions that implement editing functionality to determine
  /// whether they should apply. It defaults to false, but when its
  /// highest-precedence value is `true`, the state is considered
  /// read-only, and such functions won't change the document.
  ///
  /// Not to be confused with {@link editor.Wordgard.editable}, which
  /// controls whether the editor's DOM is set to be editable (and
  /// thus focusable).
  export const readOnly = GardState.Facet.define<boolean, boolean>({
    combine: values => values.length ? values[0] : false
  })

  /// Facet that indicates the document's default text direction. Note
  /// that this will not affect the editor CSS, and when the state's
  /// value disagrees with the direction set in the editor, the editor
  /// component will automatically inject an instance of this with a
  /// high precedence to align the state to the DOM. Still, if you
  /// know the direction in advance, it can be useful to set this, so
  /// that the direction is already accurate during initialization.
  /// Defaults to true.
  export const textLTR = GardState.Facet.define<boolean, boolean>({
    combine: values => values.length ? values[0] : true,
    static: true
  })

  /// Configure the text direction per textblock. All values given for
  /// this will be consulted in order of precedence, until one returns
  /// a non-null value. If none set a direction, the editor's {@link
  /// GardState.textLTR base direction} is used.
  ///
  /// Schema elements like {@link schema.direction} register an
  /// instance of this to make the editor aware of the meaning of the
  /// {@link types.Direction} mark.
  export const textblockLTR = GardState.Facet.define<((plot: Plot) => boolean | null)>({
    static: true
  })

  /// Configure whether to use visual or logical cursor motion in
  /// bidirectional text. The default is visual, where pressing
  /// left/right arrow keys moves the cursor in the direction that
  /// corresponds to the arrow on key. When disabled, the motion uses
  /// the string index order instead.
  export const visualCursorMotion = GardState.Facet.define<boolean, boolean>({
    combine(values) { return !values.length ? true : values[0] },
    static: true
  })
}

const initField = GardState.Facet.define<{field: GardState.Field<unknown>, create: (state: GardState) => unknown}>({static: true})

function addValue<T>(set: T[], value: T) {
  if (set.indexOf(value) < 0) set.push(value)
}

const enum Prec { Lowest = 4, Low = 3, Default = 2, High = 1, Highest = 0}

function mkPrec(value: number) {
  return (ext: GardState.Extension) => new PrecExtension(ext, value) as GardState.Extension
}

class PrecExtension {
  constructor(readonly inner: GardState.Extension, readonly prec: number) {}
  extension!: GardState.Extension
}

function sameArray<T>(a: readonly T[], b: readonly T[]) {
  return a == b || a.length == b.length && a.every((e, i) => e === b[i])
}

type Slot = GardState.Facet.Reader<any> | GardState.Field<any> | "doc" | "selection" | "schema"

const enum ProviderFlag {
  Static = 1,
  Multi = 2, // Dynamic providers may produce an array of values
  Auto = 4   // Dependencies automatically tracked
}

const enum SlotStatus {
  Unresolved = 0,
  Changed = 1,
  Computed = 2,
  Computing = 4
}

class DependencySet {
  doc: boolean = false
  sel: boolean = false
  schema: boolean = false
  addrs: number[] = []
  count: number = 0

  update(deps: readonly Slot[], addresses: {[id: number]: number}) {
    while (this.count < deps.length) {
      let dep = deps[this.count++]
      if (dep === "doc") this.doc = true
      else if (dep === "selection") this.sel = true
      else if (dep === "schema") this.schema = true
      else if (((addresses[dep.id] ?? 1) & 1) == 0) this.addrs.push(addresses[dep.id])
    }
  }
}

class FacetProvider<Input> {
  readonly id = nextID++
  extension!: GardState.Extension // Kludge to convince the type system these count as extensions
  dependencies: Slot[]

  constructor(dependencies: readonly Slot[],
              readonly facet: GardState.Facet<Input, any>,
              readonly flags: ProviderFlag,
              readonly value: ((state: GardState) => Input) | ((state: GardState) => readonly Input[]) | Input) {
    this.dependencies = dependencies as Slot[] // Only mutated for auto providers
  }

  dynamicSlot(addresses: {[id: number]: number}): DynamicSlot {
    let getter: (state: GardState) => any = this.value as any
    let compare = this.facet.compareInput
    let id = this.id, idx = addresses[id] >> 1
    let multi = this.flags & ProviderFlag.Multi
    let dependencies = this.dependencies
    let auto: Slot[] | null = this.flags & ProviderFlag.Auto ? dependencies : null
    let depSet = new DependencySet

    return {
      create(state) {
        state.values[idx] = state.recordAccess(auto, getter)
        return SlotStatus.Changed
      },
      update(state, tr) {
        depSet.update(dependencies, addresses)
        if ((depSet.doc && tr.docChanged) || (depSet.sel && (tr.docChanged || tr.selection)) ||
            (depSet.schema && tr.startState.schema != state.schema) || ensureAll(state, depSet.addrs)) {
          let newVal = state.recordAccess(auto, getter)
          if (multi ? !compareArray(newVal, state.values[idx], compare) : !compare(newVal, state.values[idx])) {
            state.values[idx] = newVal
            return SlotStatus.Changed
          }
        }
        return 0
      },
      reconfigure(state, oldState) {
        let newVal, oldAddr = oldState.config.address[id]
        if (oldAddr != null) {
          let oldVal = getAddr(oldState, oldAddr)
          if (dependencies.every(dep => {
            return dep instanceof GardState.Facet ? oldState.facet(dep) === state.facet(dep)
              : dep instanceof GardState.Field ? oldState.field(dep, false) == state.field(dep, false)
              : true
          }) || (multi ? compareArray(newVal = getter(state), oldVal, compare) : compare(newVal = getter(state), oldVal))) {
            state.values[idx] = oldVal
            return 0
          }
        } else {
          newVal = state.recordAccess(auto, getter)
        }
        state.values[idx] = newVal
        return SlotStatus.Changed
      }
    }
  }
}

function compareArray<T>(a: readonly T[], b: readonly T[], compare: (a: T, b: T) => boolean) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!compare(a[i], b[i])) return false
  return true
}

function ensureAll(state: GardState, addrs: readonly number[]) {
  let changed = false
  for (let addr of addrs)
    if (ensureAddr(state, addr) & SlotStatus.Changed) changed = true
  return changed
}

function dynamicFacetSlot<Input, Output>(
  addresses: {[id: number]: number},
  facet: GardState.Facet<Input, Output>,
  providers: readonly FacetProvider<Input>[]
): DynamicSlot {
  let providerAddrs = providers.map(p => addresses[p.id])
  let dynamic = providerAddrs.filter(p => !(p & 1))
  let idx = addresses[facet.id] >> 1

  function get(state: GardState) {
    let values: Input[] = []
    for (let i = 0; i < providerAddrs.length; i++) {
      let value = getAddr(state, providerAddrs[i])
      if (providers[i].flags & ProviderFlag.Multi) for (let val of value) values.push(val)
      else values.push(value)
    }
    return facet.combine(values)
  }

  return {
    create(state) {
      for (let addr of providerAddrs) ensureAddr(state, addr)
      state.values[idx] = get(state)
      return SlotStatus.Changed
    },
    update(state, tr) {
      if (!ensureAll(state, dynamic)) return 0
      let value = get(state)
      if (facet.compare(value, state.values[idx])) return 0
      state.values[idx] = value
      return SlotStatus.Changed
    },
    reconfigure(state, oldState) {
      let depChanged = ensureAll(state, providerAddrs)
      let oldProviders = oldState.config.facets[facet.id], oldValue = oldState.facet(facet)
      if (oldProviders && !depChanged && sameArray(providers, oldProviders)) {
        state.values[idx] = oldValue
        return 0
      }
      let value = get(state)
      if (facet.compare(value, oldValue)) {
        state.values[idx] = oldValue
        return 0
      }
      state.values[idx] = value
      return SlotStatus.Changed
    }
  }
}

function ensureAddr(state: GardState, addr: number) {
  if (addr & 1) return SlotStatus.Computed
  let idx = addr >> 1
  let status = state.status[idx]
  if (status == SlotStatus.Computing) throw new Error("Cyclic dependency between fields and/or facets")
  if (status & SlotStatus.Computed) return status
  state.status[idx] = SlotStatus.Computing
  let changed = state.computeSlot!(state, state.config.dynamicSlots[idx])
  return state.status[idx] = SlotStatus.Computed | changed
}

function getAddr(state: GardState, addr: number) {
  return addr & 1 ? state.config.staticValues[addr >> 1] : state.values[addr >> 1]
}

class CompartmentInstance {
  constructor(readonly compartment: GardState.Compartment, readonly inner: GardState.Extension) {}
  extension!: GardState.Extension
}

interface DynamicSlot {
  create(state: GardState): SlotStatus
  update(state: GardState, tr: Transaction): SlotStatus
  reconfigure(state: GardState, oldState: GardState): SlotStatus
}

// Kludge to avoid cyclic dependency with ./selection
GardSelection.selectionType = GardState.Facet.define<SelectionType>({
  combine(values) {
    let types = [GardSelection.Text.type, GardSelection.Node.type, ...values]
    for (let i = 0; i < types.length; i++) for (let j = i + 1; j < types.length; j++) {
      if (types[i].tag == types[j].tag) throw new Error("Duplicate selection JSON tag: " + types[i].tag)
    }
    return types
  },
  static: true
})

Transaction.extender = GardState.Facet.define()

Transaction.appender = GardState.Facet.define()
