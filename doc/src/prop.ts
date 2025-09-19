import {PropSpec} from "./spec"
import {isElementShape, AttributeShape, ElementShape} from "./shape"
import {compareDeep, eqArray, none, splitGroups} from "./helper"
import {SchemaElement} from "./schema"
import {TagType} from "./node"

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

export class PropType<Value> {
  readonly targetGroups: readonly string[]
  readonly rank: number
  readonly set: null | ((a: any, b: any) => number)
  readonly default: Prop<Value> | null
  readonly inclusive: boolean
  readonly element: boolean
  readonly spanning: boolean
  readonly repr: ElementShape<Value> | AttributeShape<Value>

  constructor(
    readonly name: string,
    readonly spec: PropSpec<Value>,
    isFlag: boolean
  ) {
    this.targetGroups = spec.tags == null ? ["Inline:Leaf"] : splitGroups(spec.tags)
    this.rank = Math.max(0, Math.min(spec.rank ?? 100, 100))
    this.set = spec.set ? spec.set.compare : null
    this.default = isFlag ? new Prop(this, null as any) : null
    this.inclusive = spec.inclusive !== false
    this.element = isElementShape(spec.shape)
    this.spanning = spec.spanning ?? this.element
    this.repr = spec.shape
  }

  of(value: Value) { return new Prop(this, value) }

  get schemaElement(): SchemaElement { return this }

  canTarget(tag: TagType<any>) {
    return this.targetGroups.some(g => tag.isInGroup(g))
  }

  compareRank(other: PropType<any>) {
    return this.rank - other.rank || (other.name < this.name ? 1 : -1)
  }

  removeFromSet(set: readonly Prop[]): readonly Prop[] {
    for (var i = 0; i < set.length; i++) if (set[i].type == this) return remove(set, i)
    return set
  }

  isInSet(set: readonly Prop[]): Prop | null {
    for (let v of set) if (v.type == this) return v
    return null
  }

  static define<Value>(name: string, spec: PropSpec<Value>) {
    return new PropType<Value>(name, spec, false)
  }
}

export class Prop<Value = unknown> {
  constructor(readonly type: PropType<Value>, readonly value: Value) {}

  eq(other: Prop<any>) {
    return this.type == other.type && compareDeep(this.value, other.value)
  }

  get name() { return this.type.name }

  get rank() { return this.type.rank }

  get spanning() { return this.type.spanning }

  get schemaElement() { return this.type }

  toString() { return this.value == null ? this.name : `${this.name}=${JSON.stringify(this.value)}` }

  static define(name: string, spec: PropSpec<null>): Prop<null> {
    return new PropType<null>(name, spec, true).default!
  }

  addToSet(set: readonly Prop<any>[]): readonly Prop[] {
    let placed: Prop<any> | null = null, copy: Prop<any>[] = []
    for (let i = 0; i < set.length; i++) {
      let other = set[i]
      if (this.eq(other)) return set
      if (other.type != this.type) {
        if (!placed && this.type.compareRank(other.type) < 0) copy.push(placed = this)
        copy.push(other)
      } else if (this.type.set) {
        copy.push(placed = new Prop(this.type, addSet(other.value as any[], this.value as any[], this.type.set) as any))
      }
    }
    if (!placed) copy.push(this)
    return copy
  }

  removeFromSet(set: readonly Prop<any>[]): readonly Prop[] {
    let type = this.type
    for (var i = 0; i < set.length; i++) if (set[i].type == type) {
      let val = set[i], newSet: readonly Prop<any>[]
      if (type.set) {
        let rest = subtractSet(val.value as any[], this.value as any[], type.set)
        if (!rest.length) {
          newSet = remove(set, i)
        } else {
          newSet = set.slice()
          ;(newSet as Prop[])[i] = new Prop(type, rest as any)
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

  isInSet(set: readonly Prop<any>[]): Prop | null {
    for (let v of set) if (v.eq(this)) return v
    return null
  }

  static sameSet(a: readonly Prop<any>[], b: readonly Prop<any>[]): boolean {
    return eqArray(a, b)
  }
}
