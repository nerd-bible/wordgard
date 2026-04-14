import {Plot, Leaf, Node} from "./node"
import {Mark} from "./mark"
import {DOMElement} from "./helper"

// FIXME need some way to add parse rules and/or change DOM shapes without replacing node/mark config entirely

export class Elt<T = string> {
  private constructor(
    readonly tagName: string,
    readonly attrs: Attributes,
    readonly children: Elt.Fragment<T>
  ) {}

  static new<T = string>(
    tagName: string,
    attrs: Attributes,
    children: readonly (T | 0 | Elt<T>)[]
  ): Elt<Exclude<T, Elt<any> | 0>> {
    return new Elt(tagName, attrs, children as any)
  }

  get hasContent(): boolean {
    return this.children.some(ch => ch === 0 || ch instanceof Elt && ch.hasContent) }

  eqTag(elt: Elt<any>) {
    return elt.tagName == this.tagName && Attributes.eq(this.attrs, elt.attrs)
  }

  eqChildren(elt: Elt<T>) {
    if (elt.children == this.children) return true
    if (this.children.length != elt.children.length) return false
    for (let i = 0; i < this.children.length; i++) {
      let a = this.children[i], b = elt.children[i]
      if (typeof a == "object" && (a as any).eq && (b as any).eq ? (a as any).eq(b) : a === b) return false
    }
    return true
  }

  eq(other: any) {
    return other instanceof Elt && this.eqTag(other) && this.eqChildren(other)
  }

  outerDOM(doc = document) {
    let {tagName: name, attrs} = this
    let dom = /^svg:/.test(name) ? doc.createElementNS("http://www.w3.org/2000/svg", name.slice(4))
      : /^math:/.test(name) ? doc.createElementNS("http://www.w3.org/1998/Math/MathML", name.slice(5))
      : doc.createElement(name)
    for (let i = 0; i < attrs.length;) dom.setAttribute(attrs[i++], attrs[i++])
    return dom
  }

  addAttrs(attrs: Attributes, target?: Elt.Selector) {
    if (target) {
      let added = this.addAttrsBySelector(attrs, target)
      if (added) return added
    }
    return Elt.new(this.tagName, Attributes.merge(this.attrs, attrs), this.children)
  }

  private addAttrsBySelector(attrs: Attributes, target: Elt.Selector): Elt<T> | null {
    if (target.match(this)) return this.addAttrs(attrs)
    for (let i = 0; i < this.children.length; i++) {
      let ch = this.children[i], matched
      if (ch instanceof Elt && (matched = ch.addAttrsBySelector(attrs, target))) {
        let copy = this.children.slice()
        copy[i] = matched
        return Elt.new(this.tagName, this.attrs, copy)
      }
    }
    return null
  }

  static html(content: Elt | string | Elt.Fragment): string {
    let html = ""
    function scan(elt: Elt<string> | string | 0) {
      if (typeof elt == "string") {
        html += elt.replace(/[<&]/g, ch => ch == "<" ? "&lt;" : "&amp;")
        return
      } else if (elt === 0) {
        return
      }
      let {tagName: name, attrs} = elt, svg, math
      if (svg = /^svg:/.test(name)) name = name.slice(4)
      if (math = /^math:/.test(name)) name = name.slice(5)
      if (svg && name == "svg") html += `<svg xmlns="http://www.w3.org/2000/svg"`
      if (math && name == "math") html += `<math xmlns="http://www.w3.org/1998/Math/MathML"`
      else html += `<${name}`
      for (let i = 0; i < attrs.length;) {
        let name = attrs[i++], val = attrs[i++]
        html += ` ${name}="${val.replace(/["&]/g, ch => ch == '"' ? "&quot;" : "&amp;")}"`
      }
      if ((math || svg) && !elt.children.length) {
        html += "/>"
      } else if (!math && !svg && selfClosing.has(name)) {
        html += ">"
      } else {
        html += ">"
        for (let ch of elt.children) scan(ch)
        html += `</${name}>`
      }
    }
    if (Array.isArray(content)) for (let elt of content) scan(elt)
    else scan(content as Elt<string> | string)
    return html
  }

  static dom(elt: Elt, doc?: Document): Element
  static dom(elt: string, doc?: Document): Text
  static dom(elt: Elt.Fragment, doc?: Document): DocumentFragment
  static dom(elt: Elt | string | Elt.Fragment, doc?: Document): Element | Text | DocumentFragment
  static dom(elt: Elt | string | Elt.Fragment, doc: Document = document): Element | Text | DocumentFragment {
    if (typeof elt == "string") {
      return doc.createTextNode(elt)
    } else if (elt instanceof Elt) {
      let dom = elt.outerDOM(doc)
      for (let ch of elt.children) if (ch !== 0) dom.appendChild(Elt.dom(ch, doc))
      return dom
    } else {
      let frag = doc.createDocumentFragment()
      for (let ch of elt) if (ch !== 0) frag.appendChild(Elt.dom(ch))
      return frag
    }
  }

  static empty: readonly any[] = []
  static hole: [0] = [0]
}

const selfClosing = new Set(["area", "base", "br", "col", "command", "embed", "frame",
                             "hr", "img", "input", "keygen", "link", "meta", "param",
                             "source", "track", "wbr", "menuitem"])

export namespace Elt {
  export type Fragment<T = string> = readonly (0 | T | Elt<T>)[]

  export class Selector {
    constructor(readonly tag: string | null, readonly classes: readonly string[]) {}

    eq(other: Elt.Selector) {
      return other.tag == this.tag && this.classes.length == other.classes.length &&
        this.classes.every((c, i) => c == other.classes[i])
    }

    match(elt: Elt<any>) {
      if (this.tag && elt.tagName != this.tag) return false
      if (this.classes.length) {
        let tagCls = Attributes.get(elt.attrs, "class")
        if (!tagCls) return false
        let pieces = tagCls.split(/ +/)
        for (let cls of this.classes) if (!pieces.includes(cls)) return false
      }
      return true
    }

    static parse(selector: string) {
      let m, tag = null, classes: string[] = [], txt = selector
      if (m = /^[\w\d\-_\u0c00-\uffff]+/.exec(txt)) {
        tag = m[0]
        txt = txt.slice(m[0].length)
      }
      while (m = /^\.[\w\d\-_\u0c00-\uffff]+/.exec(txt)) {
        classes.push(m[0].slice(1))
        txt = txt.slice(m[0].length)
      }
      if (txt) throw new Error("Invalid element selector " + selector)
      return new Selector(tag, classes)
    }
  }
}

export function elt<T = string>(
  tag: string | {_: string, [attr: string]: string | null},
  ...children: (T | 0 | Elt<T>)[]
): Elt<Exclude<T, Elt<any> | 0>> {
  let [name, attrs] = typeof tag == "string" ? [tag, Attributes.none] : [tag._, Attributes.read(tag)]
  let contentChildren = 0n
  for (let ch of children) {
    if (ch === 0 || ch instanceof Elt && ch.hasContent) contentChildren++
  }
  if (contentChildren > 1) throw new Error("Multiple holes in elt")
  return Elt.new(name, attrs, children.length ? children : Elt.empty as any)
}

// Sets of attributes are stored in arrays of strings, with the even
// indices holding attribute names, the odd ones attribute values. The
// attributes are sorted by name.
export type Attributes = readonly string[]

export namespace Attributes {
  export const none: Attributes = []

  export function eq(a: Attributes, b: Attributes) {
    if (a == b) return true
    if (a.length != b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] != b[i]) return false
    return true
  }

  export function compare(a: Attributes, b: Attributes) {
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
  export function merge(a: Attributes, b: Attributes) {
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
        iA += 2; iB += 2
      } else if (kA != null && (kB == null || kA < kB)) {
        result.push(kA, a[iA + 1])
        iA += 2
      } else {
        result.push(kB!, b[iB + 1])
        iB += 2
      }
    }
  }

  export function push(a: string[], name: string, value: string) {
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
  
  export function read(obj: Record<string, string | null> | null | undefined) {
    if (!obj) return Attributes.none
    let result: string[] = []
    for (let prop in obj) if (prop != "_") {
      let value = obj[prop]
      if (value != null) {
        if (/^style\//.test(prop)) {
          value = prop.slice(6) + ": " + value
          prop = "style"
        }
        Attributes.push(result, prop, value)
      }
    }
    return result.length ? result : Attributes.none
  }

  export function get(attrs: Attributes, name: string) {
    for (let i = 0; i < attrs.length; i += 2) if (attrs[i] == name) return attrs[i + 1]
    return null
  }
}

export type ElementShape<Param> = {
  element: string
  selector?: string
  attributes?: Record<string, string> | ((param: Param) => Record<string, string>)
  read?: (element: DOMElement) => Param | ParseRule.Reject
  atom?: boolean
}

// FIXME not a great name
export type StructureShape<Param> = {
  structure: Elt<string> | ((param: Param) => Elt<string>),
  atom?: boolean
}

/// Declares that a mark is represented with a specific DOM attribute.
/// This allows a matching parse rule to be derived automatically in
/// most situations.
export type AttributeShape<Param> = {
  /// The name of the attribute.
  attribute: string
  /// Its value. When given as 0, which is ony valid when the `Param`
  /// type is `string`, the value of the mark's parameter is used.
  value: (Param extends string ? 0 : never) | string | ((param: Param) => string | null)
  /// An optional function that converts the value of the attribute
  /// back into a parameter value. Used in the parse rule.
  readAttribute?: (value: string) => Param | ParseRule.Reject
  /// If the target node may be a composite shape (rather than a
  /// single DOM element), you can provide a limited form of selector
  /// here to target a specific element in that shape. Node names and
  /// class names are selected, as in `"img"`, `"img.my-class"`, or
  /// `".class1.class2"`. If no matching element is found, the
  /// attributes will be added to the node's outer element, as normal.
  preferTarget?: string
}

/// Declares that a dynamic attribute or set of attributes should be
/// added to nodes with this mark. 
export type AttributesShape<Param> = {
  /// The attributes to add, either directly or as a function of the
  /// mark's parameter.
  attributes: Record<string, string> | ((param: Param) => Record<string, string>)
  /// A selector for the [preferred
  /// target](#doc.AttributeShape.preferTarget) element.
  preferTarget?: string
}

export class NodeShape<Param> {
  constructor(
    readonly atom: boolean,
    readonly create: (param: Param) => Elt<string>,
    readonly spec: ElementShape<Param> | StructureShape<Param>
  ) {}

  static from<Param>(type: Node.Type.Base<Param>, spec: ElementShape<Param> | StructureShape<Param>) {
    let atom = spec.atom, create: (param: Param) => Elt<string>
    if (atom == null) atom = type.isLeaf
    if ("element" in spec) {
      let {element, attributes} = spec
      if (typeof attributes == "function") {
        create = (param: Param) => Elt.new(element, Attributes.read(attributes(param)), atom ? Elt.empty : Elt.hole)
      } else {
        let elt = Elt.new(element, Attributes.read(attributes), atom ? Elt.empty : Elt.hole)
        create = () => elt
      }
    } else {
      let {structure} = spec
      if (typeof structure == "function") {
        if (atom == null) throw new Error(`Dynamic structure for tag ${type.name} must define an \`atom\` field`)
        create = structure
      } else {
        if (atom == null)
          atom = !structure.hasContent
        else if (atom != !structure.hasContent)
          throw new Error(`Disagreement between \`atom\` field and structure for tag ${type.name}`)
        create = () => structure
      }
    }
    if (atom == false && type.isLeaf) throw new Error(`Leaf tag ${type.name}'s shape must be atomic`)
    return new NodeShape<Param>(atom, create, spec)
  }
}

export namespace ParseRule {
  export interface Element<Param> {
    selector: string
    plot?: Plot.Tag<Param> | Plot.Type<Param>
    leaf?: Leaf<Param> | Leaf.Type<Param>
    mark?: Mark.Type<Param> | Mark<Param>
    ignore?: boolean | "skip"
    param?: Param
    readElement?: (element: DOMElement) => Param | ParseRule.Reject
    contentElement?: string | ((elt: DOMElement) => DOMElement)
    /// Ignore DOM nodes matching this selector or predicate, when
    /// they appear in this plot's content element.
    ignoreContent?: string | ((elt: DOMElement) => boolean)
    /// A number between -10 and 10 (inclusive) that specifies the
    /// relative precedence of this rule. Defaults to 0.
    precedence?: number
  }

  export interface Attribute<Param> {
    attribute: string
    mark?: Mark.Type<Param> | Mark<Param>
    ignore?: boolean
    clearMark?: (mark: Mark<unknown>) => boolean
    param?: Param
    value?: string
    readAttribute?: (value: string) => Param | ParseRule.Reject
    consuming?: boolean
    /// A number between -10 and 10 (inclusive) that specifies the
    /// relative precedence of this rule. Defaults to 0.
    precedence?: number
  }

  export const Reject: unique symbol = Symbol("reject")
  export type Reject = typeof ParseRule.Reject
}

export type ParseRule<Param = any> = ParseRule.Element<Param> | ParseRule.Attribute<Param>
