import {TagType} from "./node"

export class Elt<T> {
  constructor(
    readonly tagName: string,
    readonly attrs: Attributes,
    // Null means a content hole
    readonly children: readonly (Elt<T> | T)[] | null
  ) {}

  get hasContent(): boolean { return this.children == null || this.children.some(ch => ch instanceof Elt && ch.hasContent) }

  eqTag(elt: Elt<any>) {
    return elt.tagName == this.tagName && sameAttributes(this.attrs, elt.attrs)
  }

  eqChildren(elt: Elt<T>) {
    if (elt.children == this.children) return true
    if (!elt.children || !this.children) return false
    if (this.children.length != elt.children.length) return false
    for (let i = 0; i < this.children.length; i++) {
      let a = this.children[i], b = elt.children[i]
      if ((a as any).eq && (b as any).eq ? (a as any).eq(b) : a === b) return false
    }
    return true
  }

  eq(other: any) {
    return other instanceof Elt && this.eqTag(other) && this.eqChildren(other)
  }
}

export const noChildren: readonly any[] = []

export function elt<T>(
  tag: string | {_: string, [attr: string]: string | null},
  ...children: (Elt<T> | 0 | T)[]
): Elt<Exclude<T, Elt<any> | 0>> {
  let [name, attrs] = typeof tag == "string" ? [tag, noAttributes] : [tag._, readAttributes(tag)]
  if (children.length == 1 && children[0] === 0)
    return new Elt(name, attrs, null)
  let contentChildren = 0
  for (let ch of children) {
    if (ch === 0) throw new Error("Elts with a hole cannot have direct children")
    if (ch instanceof Elt && ch.hasContent) contentChildren++
  }
  if (contentChildren > 1) throw new Error("Multiple holes in elt children")
  return new Elt(name, attrs, children.length ? children : noChildren)
}

// Sets of attributes are stored in arrays of strings, with the even
// indices holding attribute names, the odd ones attribute values. The
// attributes are sorted by name.
export type Attributes = readonly string[]

export const noAttributes: Attributes = []

export function sameAttributes(a: Attributes, b: Attributes) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
  return true
}

export function compareAttributes(a: Attributes, b: Attributes) {
  for (let iA = 0, iB = 0, score = 0;;) {
    if (iA < a.length && iB < b.length && a[iA] == b[iB]) {
      if (a[iA + 1] != b[iB + 1]) score--
      iA += 2; iB += 2
    } else if (iA < a.length && (iB == b.length || a[iA] < b[iB])) {
      score--
      iA += 2
    } else if (iB < b.length && iA < a.length) {
      score--
      iB += 2
    } else {
      return score
    }
  }
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

export function readAttributes(obj: Record<string, string | null> | null | undefined) {
  if (!obj) return noAttributes
  let result: string[] = []
  for (let prop in obj) if (prop != "_") {
    let value = obj[prop]
    if (value != null) {
      if (/^style\//.test(prop)) {
        value = prop.slice(6) + ": " + value
        prop = "style"
      }
      pushAttribute(result, prop, value)
    }
  }
  return result.length ? result : noAttributes
}

export const Reject: unique symbol = Symbol("reject")
export type Reject = typeof Reject

export type ElementShape<Param> = {
  element: string
  selector?: string
  attributes?: Record<string, string> | ((param: Param) => Record<string, string>)
  readElement?: (element: HTMLElement) => Param | Reject
  atom?: boolean
}

// FIXME not a great name
export type StructureShape<Param> = {
  structure: Elt<string> | ((param: Param) => Elt<string>),
  atom?: boolean
}

export type AttributeShape<Param> = {
  attribute: string
  value?: string | ((param: Param) => string | null)
  readAttribute?: (value: string) => Param | Reject
}

export function isElementShape<T>(
  repr: AttributeShape<T> | ElementShape<T> | StructureShape<T>
): repr is ElementShape<T> {
  return (repr as ElementShape<any>).element != null
}

export function isAttributeShape<T>(
  repr: AttributeShape<T> | ElementShape<T> | StructureShape<T>
): repr is AttributeShape<T> {
  return (repr as AttributeShape<any>).attribute != null
}

export function isStructureShape<T>(
  repr: AttributeShape<T> | ElementShape<T> | StructureShape<T>
): repr is StructureShape<T> {
  return (repr as StructureShape<any>).structure != null
}

export class NodeShape<Param> {
  constructor(
    readonly atom: boolean,
    readonly create: (param: Param) => Elt<string>,
    readonly spec: ElementShape<Param> | StructureShape<Param>
  ) {}

  static from<Param>(tag: TagType<Param>, spec: ElementShape<Param> | StructureShape<Param>) {
    let atom = spec.atom, create: (param: Param) => Elt<string>
    if (isElementShape(spec)) {
      if (atom == null) atom = tag.isLeaf
      let {element, attributes} = spec
      if (typeof attributes == "function") {
        create = (param: Param) => new Elt(element, readAttributes(attributes(param)), atom ? noChildren : null)
      } else {
        let elt = new Elt(element, readAttributes(attributes), atom ? noChildren : null)
        create = () => elt
      }
    } else {
      let {structure} = spec
      if (typeof structure == "function") {
        if (atom == null) throw new Error(`Dynamic structure for tag ${tag.name} must define an \`atom\` field`)
        create = structure
      } else {
        if (atom == null)
          atom = !structure.hasContent
        else if (atom != !structure.hasContent)
          throw new Error(`Disagreement between \`atom\` field and structure for tag ${tag.name}`)
        create = () => structure
      }
    }
    if (atom == false && tag.isLeaf) throw new Error(`Leaf tag ${tag.name}'s shape must be atomic`)
    return new NodeShape<Param>(atom, create, spec)
  }
}
