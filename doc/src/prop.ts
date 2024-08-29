import {PropSpec} from "./spec"
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

  constructor(
    readonly name: string,
    readonly spec: PropSpec<Value>,
    isFlag: boolean
  ) {
    this.targetGroups = spec.tags == null ? ["Inline"] : splitGroups(spec.tags)
    this.rank = spec.rank ?? 100
    this.set = spec.set ? spec.set.compare : null
    this.default = isFlag ? new Prop(this, null as any) : null
  }

  of(value: Value) { return new Prop(this, value) }

  get schemaElement(): SchemaElement { return this }

  canTarget(tag: TagType<any>) {
    return this.targetGroups.some(g => tag.isInGroup(g))
  }

  compareRank(other: PropType<any>) {
    return this.rank - other.rank || (other.name < this.name ? 1 : -1)
  }

  static define<Value>(name: string, spec: PropSpec<Value>) {
    return new PropType<Value>(name, spec, false)
  }
}

export class Prop<Value = any> {
  constructor(readonly type: PropType<Value>, readonly value: Value) {}

  eq(other: Prop) {
    return this.type == other.type && compareDeep(this.value, other.value)
  }

  get name() { return this.type.name }

  get schemaElement() { return this.type }

  toString() { return this.value == null ? this.name : `${this.name}=${JSON.stringify(this.value)}` }

  static define(name: string, spec: PropSpec<null>): Prop<null> {
    return new PropType<null>(name, spec, true).default!
  }
}

export class PropSet {
  constructor(readonly set: readonly Prop[]) {}

  eq(other: PropSet) {
    return this == other || eqArray(this.set, other.set)
  }

  add(prop: Prop) {
    let placed = null, copy: Prop[] = []
    for (let i = 0; i < this.set.length; i++) {
      let other = this.set[i]
      if (prop.eq(other)) return this
      if (other.type != prop.type) {
        if (!placed && prop.type.compareRank(other.type) < 0) copy.push(placed = prop)
        copy.push(other)
      } else if (prop.type.set) {
        copy.push(placed = new Prop(prop.type, addSet(other.value, prop.value, prop.type.set)))
      }
    }
    if (!placed) copy.push(prop)
    return new PropSet(copy)
  }

  join(other: PropSet) {
    let result = this as PropSet
    for (let val of other.set) result = result.add(val)
    return result
  }

  remove(prop: PropType<any> | Prop): PropSet {
    if (prop instanceof PropType) {
      for (var i = 0; i < this.set.length; i++) if (this.set[i].type == prop)
        return this.set.length > 1 ? new PropSet(remove(this.set, i)) : PropSet.empty
    } else {
      let type = prop.type
      for (var i = 0; i < this.set.length; i++) if (this.set[i].type == type) {
        let val = this.set[i], set: readonly Prop[]
        if (type.set) {
          let rest = subtractSet(val.value, prop.value, type.set)
          if (!rest.length) {
            set = remove(this.set, i)
          } else {
            set = this.set.slice()
            ;(set as Prop[])[i] = new Prop(type, rest)
          }
        } else if (!val.eq(prop)) {
          continue
        } else {
          set = remove(this.set, i)
        }
        return set.length ? new PropSet(set) : PropSet.empty
      }
    }
    return this
  }

  has(prop: PropType<any> | Prop): Prop | null {
    if (prop instanceof PropType) {
      for (let v of this.set) if (v.type == prop) return v
    } else {
      for (let v of this.set) if (v.eq(prop)) return v
    }
    return null
  }

  get<Value>(prop: PropType<Value>, required: true): Value
  get<Value>(prop: PropType<Value>): Value | undefined
  get<Value>(prop: PropType<Value>, required = false): Value | undefined {
    for (let v of this.set) if (v.type == prop) return v.value
    if (required) throw new Error(`Missing required prop ${prop.name}`)
    return undefined
  }
  
  get empty() { return this.set.length == 0 }

  toString() { return "{" + this.set.join(",") + "}" }

  static empty = new PropSet(none)

  static of(props: readonly Prop[]) {
    let result = PropSet.empty
    for (let prop of props) result = result.add(prop)
    return result
  }
}
