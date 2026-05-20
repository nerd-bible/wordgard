import {Shape, ParseRule, Elt, Attributes} from "./shape"
import {compareDeep, eqArray, none} from "./helper"
import {Node, Plot} from "./node"
import {SchemaError} from "./error"

function remove<T>(arr: readonly T[], index: number) {
  return arr.length == 1 ? none : arr.filter((_, i) => i != index)
}

export function addSet<T>(a: readonly T[], b: readonly T[], compare: (a: T, b: T) => number) {
  let result: T[] = []
  for (let i = 0, j = 0;;) {
    if (i == a.length) {
      if (j == b.length) return result
      result.push(b[j++])
    } else if (j == b.length) {
      result.push(a[i++])
    } else {
      let cmp = compare(a[i], b[j])
      if (cmp == 0) i++
      else if (cmp < 0) result.push(a[i++])
      else result.push(b[j++])
    }
  }
}

export function subtractSet<T>(a: readonly T[], b: readonly T[], compare: (a: T, b: T) => number) {
  let result: T[] = []
  for (let i = 0, j = 0;;) {
    if (i == a.length) return result
    if (j == b.length) {
      result.push(a[i++])
    } else {
      let cmp = compare(a[i], b[j])
      if (cmp == 0) i++
      else if (cmp < 0) result.push(a[i++])
      else j++
    }
  }
}

export class Mark<Value = unknown> {
  constructor(readonly type: Mark.Type<Value>, readonly value: Value) {}

  eq(other: Mark<any>) {
    return this.type == other.type && compareDeep(this.value, other.value)
  }

  get name() { return this.type.name }

  get rank() { return this.type.rank }

  get spanning() { return this.type.spanning }

  toString() { return this.value == null ? this.name : `${this.name}=${JSON.stringify(this.value)}` }

  static define(name: string, spec: Mark.Spec<null>): Mark<null> {
    return new Mark.Type<null>(name, spec, true).default!
  }

  addToSet(set: readonly Mark<any>[]): readonly Mark[] {
    let placed: Mark<any> | null = null, copy: Mark<any>[] = []
    for (let i = 0; i < set.length; i++) {
      let other = set[i]
      if (this.eq(other)) return set
      if (other.type != this.type) {
        if (!placed && this.type.compareRank(other.type) < 0) copy.push(placed = this)
        copy.push(other)
      } else if (this.type.set) {
        copy.push(placed = new Mark(this.type, addSet(other.value as any[], this.value as any[], this.type.set) as any))
      }
    }
    if (!placed) copy.push(this)
    return copy
  }

  removeFromSet(set: readonly Mark<any>[]): readonly Mark[] {
    let type = this.type
    for (var i = 0; i < set.length; i++) if (set[i].type == type) {
      let val = set[i], newSet: readonly Mark<any>[]
      if (type.set) {
        let rest = subtractSet(val.value as any[], this.value as any[], type.set)
        if (!rest.length) {
          newSet = remove(set, i)
        } else {
          newSet = set.slice()
          ;(newSet as Mark[])[i] = new Mark(type, rest as any)
        }
      } else if (!val.eq(this as any)) {
        continue
      } else {
        newSet = remove(set, i)
      }
      return newSet
    }
    return set
  }

  isInSet(set: readonly Mark<any>[]): Mark<Value> | null {
    for (let v of set) if (v.eq(this)) return v as Mark<Value>
    return null
  }

  static sameSet(a: readonly Mark<any>[], b: readonly Mark<any>[]): boolean {
    return eqArray(a, b)
  }

  static none: readonly Mark[] = none
}

export namespace Mark {
  export class Type<Value> {
    readonly rank: number
    readonly set: null | ((a: any, b: any) => number)
    readonly default: Mark<Value> | null
    readonly inclusive: boolean
    readonly element: Mark.Element<Value> | null = null
    readonly attribute: Mark.Attribute<Value> | null = null
    readonly spanning: boolean

    constructor(
      readonly name: string,
      readonly spec: Mark.Spec<Value>,
      isFlag: boolean
    ) {
      this.rank = Math.max(0, Math.min(spec.rank ?? 100, 100))
      this.set = spec.set ? spec.set.compare : null
      this.default = isFlag ? new Mark(this, null as any) : null
      this.inclusive = spec.inclusive !== false
      if ("element" in spec.shape) this.element = new Mark.Element(spec.shape)
      else this.attribute = new Mark.Attribute(spec.shape, this)
      this.spanning = this.element ? spec.spanning !== false : !!spec.spanning
    }

    of(value: Value) { return new Mark(this, value) }

    compareRank(other: Mark.Type<any>) {
      return this.rank - other.rank || (other.name < this.name ? 1 : -1)
    }

    removeFromSet(set: readonly Mark[]): readonly Mark[] {
      for (var i = 0; i < set.length; i++) if (set[i].type == this) return remove(set, i)
      return set
    }

    isInSet(set: readonly Mark[]): Mark<Value> | null {
      for (let v of set) if (v.type == this) return v as Mark<Value>
      return null
    }

    static define<Value>(name: string, spec: Mark.Spec<Value>) {
      return new Mark.Type<Value>(name, spec, false)
    }
  }

  /// Configuration for marks.
  export interface Spec<Value> {
    /// Which node tags this mark may apply to, as a space separated
    /// string of tag or group names. The default is `"Inline:Leaf"`.
    target?: Node.Query
    /// Determines the position of this mark relative to other marks.
    /// Marks with lower rank appear first in mark set arrays, and are
    /// rendered around higher rank marks in DOM representation. Ties
    /// are broken by name.
    rank?: number
    /// Whether this mark should be active when the cursor is positioned
    /// at its end (or at its start when that is also the start of the
    /// parent node). Defaults to true.
    inclusive?: boolean
    /// Whether this mark can span across multiple nodes, or refers to
    /// an individual node. Only spanning marks can be added to text.
    /// Spanning marks with an element representation can be drawn as
    /// elements containing multiple nodes, unless another, lower-ranked
    /// mark requires the nodes to be wrapped separately. Defaults to
    /// true for specs with an element representation, false
    /// for specs with an attribute representation.
    spanning?: boolean
    /// Used by `Tag.split` to determine whether to keep this mark in
    /// the split-off tag. `atEnd` will be true if the split happens at
    /// the end of the node's content.
    keepOnSplit?: boolean | ((tag: Plot.Tag.Any, atEnd: boolean) => boolean)
    /// Used by `Tag.changeType` to decide whether marks of this type
    /// are preserved after the type change.
    keepOnTypeChange?: boolean | ((from: Node.Tag, to: Node.Tag) => boolean)
    /// A function or type name used to validate values of this mark.
    /// See [`Tag.Spec.validateParam`](#doc.Tag.Spec.validateParam).
    validate?: string | ((value: Value) => void)
    set?: Value extends ReadonlyArray<infer Content> ? {compare: (a: Content, b: Content) => number} : never
    /// A mark can be either represented with a wrapping element, or
    /// with one or more attributes added to the affected nodes.
    shape: Shape.Element<Value> | Shape.Attribute<Value> | Shape.Attributes<Value>
    /// A set of parse rules for this mark. The `mark` field for these
    /// will automatically be defaulted to the mark type itself.
    parseRules?: readonly (ParseRule.Element<Value> | ParseRule.Attribute<Value>)[]
  }

  export class Element<Value> {
    readonly name: string
    readonly attrs: (value: Value) => Attributes

    constructor(readonly spec: Shape.Element<Value>) {
      this.name = spec.element
      const {attributes} = spec
      if (typeof attributes == "function") {
        this.attrs = (value: Value) => Attributes.read(attributes(value))
      } else {
        let attrs = Attributes.read(attributes)
        this.attrs = () => attrs
      }
    }
  }

  export class Attribute<Value> {
    readonly get: (param: Value) => Attributes
    readonly target: Elt.Selector | null

    constructor(readonly spec: Shape.Attribute<Value> | Shape.Attributes<Value>, type: Mark.Type<Value>) {
      if ("attribute" in spec) {
        const {value, attribute} = spec, style = /^style\//.test(attribute) ? attribute.slice(6) + ": " : null
        if (value === 0) {
          if (type.default) throw new SchemaError("Attribute shapes for parameter-less marks cannot use 0 as value")
          if (style) this.get = param => ["style", style + param]
          else this.get = param => [attribute, String(param)]
        } else if (typeof value == "function") {
          if (style)
            this.get = param => { let val = value(param); return val == null ? Attributes.none : ["style", style + val] }
          else
            this.get = param => { let val = value(param); return val == null ? Attributes.none : [attribute, val] }
        } else {
          let attrs = style ? ["style", style + value] : [attribute, value]
          this.get = () => attrs
        }
      } else {
        const {attributes} = spec
        if (typeof attributes == "function") {
          this.get = param => Attributes.read(attributes(param))
        } else {
          let attrs = Attributes.read(attributes)
          this.get = () => attrs
        }
      }
      this.target = spec.preferTarget ? Elt.Selector.parse(spec.preferTarget) : null
    }
  }
}
