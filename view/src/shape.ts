export enum EltFlag { Hole = 1, Spanning = 2 }

export class Elt {
  constructor(
    readonly tagName: string,
    readonly attrs: Attributes,
    readonly flags: number
  ) {}

  get hasHole() { return !!(this.flags & EltFlag.Hole) }
  get spanning() { return !!(this.flags & EltFlag.Spanning) }
}

export type Structure = Elt | Widget<any> | readonly [Elt, ...Structure[]]

export type EltChild = Structure | string | 0

export function E(name: string, attrs: Record<string, string>, ...children: EltChild[]): Elt
export function E(name: string, ...children: EltChild[]): Elt
export function E(name: string, ...args: (EltChild | Record<string, string>)[]) {
  let children: Structure[] = [], attrs = noAttributes, i = 0
  if (args.length && typeof args[0] == "object" && !Array.isArray(args[0]) && !(args[0] instanceof Elt)) {
    i++
    attrs = readAttributes(args[0] as Record<string, string>)
  }
  let flags = 0, directHole = false
  while (i < args.length) {
    let elt = args[i++]
    if (elt === 0) {
      directHole = true
      flags |= EltFlag.Hole
    } else if (typeof elt == "string") {
      children.push(TextWidget.of(elt))
    } else {
      children.push(elt as Structure)
      if (Array.isArray(elt) && (elt[0] as Elt).hasHole || elt instanceof Elt && elt.hasHole) {
        if (flags & EltFlag.Hole) throw new Error("Multiple holes in elt")
        flags |= EltFlag.Hole
      }
    }
  }
  if (directHole && children.length)
    throw new Error("An element can either have a hole or children, not both")
  let result = new Elt(name, attrs, flags)
  return children.length ? [result, ...children] : result
}

export type WidgetSpec<T> = {
  render: (value: T) => Node,
  rank?: number
}

export class WidgetType<T> {
  render: (value: T) => Node
  rank: number

  constructor(spec: WidgetSpec<T>) {
    this.render = spec.render
    this.rank = spec.rank || 0
  }

  of(value: T) { return new Widget(this, value) }
}

export class Widget<T> {
  constructor(readonly type: WidgetType<T>, value: T) {}
  get rank() { return this.type.rank }

  static define<T>(spec: WidgetSpec<T>) {
    return new WidgetType(spec)
  }

  static create(spec: WidgetSpec<null>) {
    return new WidgetType<null>(spec).of(null)
  }
}

export const TextWidget = Widget.define<string>({
  render: s => document.createTextNode(s)
})

export class Wrapper {
  constructor(
    readonly tagName: string | null,
    readonly attrs: Attributes
  ) {}
}

// Sets of attributes are stored in arrays of strings, with the even
// indices holding attribute names, the odd ones attribute values. The
// attributes are sorted by name.
export type Attributes = readonly string[]

export const noAttributes: Attributes = []

export function sameAttributes(a: Attributes, b: Attributes) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] != b[1]) return false
  return true
}

// Combine two attribute sets, with b having higher precedence when
// they set the same attribute.
export function mergeAttributes(a: Attributes, b: Attributes) {
  if (!a.length) return b
  if (!b.length) return a
  let result: string[] = []
  for (let iA = 0, iB = 0;;) {
    let kA = iA < a.length ? a[iA] : null, kB = iB < b.length ? b[iB] : null
    if (kA == kB) {
      if (kA == null) return result
      let value = b[iB + 1]
      if (kA == "class") value = a[iA + 1] + " " + value
      else if (kA == "style") value = a[iA + 1] + ";" + value
      result.push(kA, value)
      iA += 2; iB + 2
    } else if (kA != null && (kB == null || kA < kB)) {
      result.push(kA, a[iA + 1])
      iA += 2
    } else {
      result.push(kB!, b[iB + 1])
      iB += 2
    }
  }
}

export function pushAttribute(a: string[], name: string, value: string) {
  let i = 0
  while (i < a.length && a[i] < name) i += 2
  if (i < a.length && a[i] == name) {
    if (name == "class") a[i + 1] += " " + value
    else if (name == "style") a[i + 1] += ";" + value
    else a[i + 1] = value
  } else {
    a.splice(i, 0, name, value)
  }
}

export function readAttributes(obj: Record<string, string>) {
  let result: string[] = []
  for (let prop in obj) pushAttribute(result, prop, obj[prop])
  return result.length ? result : noAttributes
}
