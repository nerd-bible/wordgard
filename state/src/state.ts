import {Schema, Slice, SchemaElement, DocNode, Node, NodeJSON, parseDoc,
        ChangeSet, ChangeSpec} from "@willows/doc"
import {EditorSelection, SelectionRange} from "./selection"
import {Transaction, TransactionSpec, resolveTransaction, asArray, StateEffect} from "./transaction"
import {Facet, FacetReader, StateField, SlotStatus, FacetProvider, Provider,
        sameArray, dynamicFacetSlot, ensureAddr, getAddr, schemaElement,
        transactionFilter, transactionExtender} from "./facet"

const schemaCache: WeakMap<readonly SchemaElement[], Schema> = new WeakMap

export function schemaFromConfig(config: Configuration) {
  let elts = config.staticFacet(schemaElement)
  let schema = schemaCache.get(elts)
  if (!schema) schemaCache.set(elts, schema = Schema.define(elts))
  return schema
}

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

function readDoc(schema: Schema, doc: DocSource): DocNode {
  if (doc instanceof DocNode) {
    if (doc.schema != schema) throw new Error("Schema mismatch between document and editor configuration")
    return doc
  }
  if (typeof doc == "function") return doc(schema)
  if (typeof doc == "string") doc = readHTML(doc)
  let {nodeType} = doc as any
  if (nodeType === 1 || nodeType === 11) return parseDoc(schema, doc as HTMLElement | DocumentFragment)
  return schema.docFromJSON(doc as NodeJSON)
}

/// Extension values can be
/// [provided](#state.EditorStateConfig.extensions) when creating a
/// state to attach various kinds of configuration and behavior
/// information. They can either be built-in extension-providing
/// objects, such as [state fields](#state.StateField) or [facet
/// providers](#state.Facet.of), or objects with an extension in its
/// `extension` property. Extensions can be nested in arrays
/// arbitrarily deep—they will be flattened when processed.
export type Extension = {extension: Extension} | readonly Extension[]

const Prec_ = {lowest: 4, low: 3, default: 2, high: 1, highest: 0}

function prec(value: number) {
  return (ext: Extension) => new PrecExtension(ext, value) as Extension
}

/// By default extensions are registered in the order they are found
/// in the flattened form of nested array that was provided.
/// Individual extension values can be assigned a precedence to
/// override this. Extensions that do not have a precedence set get
/// the precedence of the nearest parent with a precedence, or
/// [`default`](#state.Prec.default) if there is no such parent. The
/// final ordering of extensions is determined by first sorting by
/// precedence and then by order within each precedence.
export const Prec = {
  /// The highest precedence level, for extensions that should end up
  /// near the start of the precedence ordering.
  highest: prec(Prec_.highest),
  /// A higher-than-default precedence, for extensions that should
  /// come before those with default precedence.
  high: prec(Prec_.high),
  /// The default precedence, which is also used for extensions
  /// without an explicit precedence.
  default: prec(Prec_.default),
  /// A lower-than-default precedence.
  low: prec(Prec_.low),
  /// The lowest precedence level. Meant for things that should end up
  /// near the end of the extension order.
  lowest: prec(Prec_.lowest)
}

class PrecExtension {
  constructor(readonly inner: Extension, readonly prec: number) {}
  extension!: Extension
}

const reconfigure = StateEffect.define<{compartment: Compartment, extension: Extension}>()

/// Extension compartments can be used to make a configuration
/// dynamic. By [wrapping](#state.Compartment.of) part of your
/// configuration in a compartment, you can later
/// [replace](#state.Compartment.reconfigure) that part through a
/// transaction.
export class Compartment {
  /// Create an instance of this compartment to add to your [state
  /// configuration](#state.EditorStateConfig.extensions).
  of(ext: Extension): Extension { return new CompartmentInstance(this, ext) }

  /// Create an [effect](#state.TransactionSpec.effects) that
  /// reconfigures this compartment.
  reconfigure(content: Extension): StateEffect<unknown> {
    return reconfigure.of({compartment: this, extension: content})
  }

  /// Get the current content of the compartment in the state, or
  /// `undefined` if it isn't present.
  get(state: EditorState): Extension | undefined {
    return state.config.compartments.get(this)
  }
}

export class CompartmentInstance {
  constructor(readonly compartment: Compartment, readonly inner: Extension) {}
  extension!: Extension
}

export interface DynamicSlot {
  create(state: EditorState): SlotStatus
  update(state: EditorState, tr: Transaction): SlotStatus
  reconfigure(state: EditorState, oldState: EditorState): SlotStatus
}

export class Configuration {
  readonly statusTemplate: SlotStatus[] = []

  constructor(readonly base: Extension,
              readonly compartments: Map<Compartment, Extension>,
              readonly dynamicSlots: DynamicSlot[],
              readonly address: {[id: number]: number},
              readonly staticValues: readonly any[],
              readonly facets: {[id: number]: readonly FacetProvider<any>[]}) {
    while (this.statusTemplate.length < dynamicSlots.length)
      this.statusTemplate.push(SlotStatus.Unresolved)
  }

  staticFacet<Output>(facet: Facet<any, Output>) {
    let addr = this.address[facet.id]
    return addr == null ? facet.default : this.staticValues[addr >> 1]
  }

  createState(spec: {doc: DocNode, selection: EditorSelection}) {
    return EditorState.fromConfig(this, spec.doc, spec.selection)
  }

  static resolve(base: Extension, compartments: Map<Compartment, Extension>, oldState?: EditorState) {
    let fields: StateField<any>[] = []
    let facets: {[id: number]: FacetProvider<any>[]} = Object.create(null)
    let newCompartments = new Map<Compartment, Extension>()

    for (let ext of flatten(base, compartments, newCompartments)) {
      if (ext instanceof StateField) fields.push(ext)
      else (facets[ext.facet.id] || (facets[ext.facet.id] = [])).push(ext)
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
      let oldProviders = oldFacets && oldFacets[id] || []
      if (providers.every(p => p.type == Provider.Static)) {
        address[facet.id] = (staticValues.length << 1) | 1
        if (sameArray(oldProviders, providers)) {
          staticValues.push(oldState!.facet(facet))
        } else {
          let value = facet.combine(providers.map(p => p.value))
          staticValues.push(oldState && facet.compare(value, oldState.facet(facet)) ? oldState.facet(facet) : value)
        }
      } else {
        for (let p of providers) {
          if (p.type == Provider.Static) {
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
    return new Configuration(base, newCompartments, dynamic, address, staticValues, facets)
  }

  /// Create a configuration from the given set of extensions.
  static create(extensions: Extension) {
    return Configuration.resolve(extensions, new Map)
  }
}

function flatten(extension: Extension, compartments: Map<Compartment, Extension>, newCompartments: Map<Compartment, Extension>) {
  let result: (FacetProvider<any> | StateField<any>)[][] = [[], [], [], [], []]
  let seen = new Map<Extension, number>()
  function inner(ext: Extension, prec: number) {
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
    } else if (ext instanceof StateField) {
      result[prec].push(ext)
      if (ext.provides) inner(ext.provides, prec)
    } else if (ext instanceof FacetProvider) {
      result[prec].push(ext)
      if (ext.facet.extensions) inner(ext.facet.extensions, Prec_.default)
    } else {
      let content = (ext as any).extension
      if (!content) throw new Error(`Unrecognized extension value in extension set (${ext}). This sometimes happens because multiple instances of @codemirror/state are loaded, breaking instanceof checks.`)
      inner(content, prec)
    }
  }
  inner(extension, Prec_.default)
  return result.reduce((a, b) => a.concat(b))
}

type DocSource = DocNode | HTMLElement | DocumentFragment | string | NodeJSON | ((schema: Schema) => DocNode)

/// Options passed when [creating](#state.EditorState^create) an
/// editor state.
export interface EditorStateSpec {
  /// The initial document.
  doc: DocSource
  /// The starting selection. Defaults to a cursor at the start of the
  /// document.
  selection?: EditorSelection | {anchor: number, head?: number} | ((doc: DocNode) => EditorSelection)
  /// Configuration for this state.
  extensions: Extension
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

  private constructor(
    /// The configuration 
    readonly config: Configuration,
    /// The current document.
    readonly doc: DocNode,
    /// The current selection.
    readonly selection: EditorSelection,
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
    ensureAddr(this, addr)
    return getAddr(this, addr)
  }

  /// Get the value of a state [facet](#state.Facet).
  facet<Output>(facet: FacetReader<Output>): Output {
    let addr = this.config.address[facet.id]
    if (addr == null) return facet.default
    ensureAddr(this, addr)
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
  update(...specs: readonly TransactionSpec[]): Transaction {
    return resolveTransaction(this, specs, true)
  }

  /// @internal
  applyTransaction(tr: Transaction) {
    let conf: Configuration | null = this.config, {base, compartments} = conf
    for (let effect of tr.effects) {
      if (effect.is(reconfigure)) {
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

  replaceSelection(content: Slice | string | Node) {
      /* FIXME
    return this.changeByRange(range => {
      let slice = content
      if (!(slice instanceof Slice)) {
        let props = this.selection.props || this.doc.resolve(range.from).props(this.doc.resolve(range.to))
        slice = new Slice([typeof slice == "string" ? Node.text(slice, props) : slice.withProps(props)])
      }
      let fit = fitReplacement(this.doc, range.from, range.to, slice)
      if (!fit) return {range}
      return {
        changes: fit.change,
        range: EditorSelection.cursor(fit.sliceEnd, -1)
      }
    })
      */
    return {}
  }

  changeByRange(f: (range: SelectionRange) => {
    range: SelectionRange,
    changes?: ChangeSpec,
    effects?: StateEffect<any> | readonly StateEffect<any>[]
  }): {
    changes: ChangeSet,
    selection: EditorSelection,
    effects: readonly StateEffect<any>[]
  } {
    let sel = this.selection
    let result1 = f(sel.ranges[0])
    let changes = ChangeSet.create(this.doc, result1.changes || []), ranges = [result1.range]
    let effects = !result1.effects ? [] : Array.isArray(result1.effects) ? result1.effects : [result1.effects]
    for (let i = 1; i < sel.ranges.length; i++) {
      let result = f(sel.ranges[i])
      let newChanges = ChangeSet.create(this.doc, result.changes || []), newMapped = newChanges.map(changes, this.doc)
      for (let j = 0; j < i; j++) ranges[j] = ranges[j].map(newMapped)
      let mapBy = changes.map(newChanges, this.doc, true)
      ranges.push(result.range.map(mapBy))
      changes = changes.compose(newMapped)
      effects = StateEffect.mapEffects(effects, newMapped).concat(StateEffect.mapEffects(asArray(result.effects), mapBy))
    }
    return {
      changes,
      selection: EditorSelection.create(ranges, sel.mainIndex),
      effects
    }
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
    let schema = schemaFromConfig(config)
    return EditorState.fromConfig(config, schema.docFromJSON(json.doc), EditorSelection.fromJSON(schema, json.selection))
  }

  /// Create a new state. You'll usually only need this when
  /// initializing an editor—updated states are created by applying
  /// transactions.
  static create(spec: EditorStateSpec): EditorState {
    let config = Configuration.resolve(spec.extensions, new Map)
    let schema = schemaFromConfig(config)
    let doc = readDoc(schema, spec.doc)
    let selection = !spec.selection ? EditorSelection.atStart(doc)
      : typeof spec.selection == "function" ? spec.selection(doc)
      : spec.selection instanceof EditorSelection ? spec.selection
      : EditorSelection.single(spec.selection.anchor, spec.selection.head)
    return EditorState.fromConfig(config, doc, selection)
  }

  /// @internal
  static fromConfig(config: Configuration, doc: DocNode, selection: EditorSelection) {
    selection.check(doc)
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
