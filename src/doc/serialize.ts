import {Plot, Part, Leaf} from "./node"
import {Schema} from "./schema"
import {Slice, Token, TokenType} from "./slice"
import {Prop} from "./prop"
import {ElementShape, AttributeShape, isElementShape,
        Elt, Attributes, readAttributes, pushAttribute, mergeAttributes} from "./shape"

export type SerializeOptions = {
  document?: Document
  emitNewlines?: boolean
}

abstract class Context {
  readonly emitNewlines: boolean

  constructor(options: SerializeOptions, readonly schema: Schema) {
    this.emitNewlines = options.emitNewlines !== false
  }

  abstract emitText(text: string): void
  abstract openElt(name: string, attrs: Attributes): void
  abstract closeElt(): void
}

class DOMContext extends Context {
  top: DocumentFragment | HTMLElement
  document: Document

  constructor(options: SerializeOptions, schema: Schema) {
    super(options, schema)
    this.document = options.document || document
    this.top = document.createDocumentFragment()
  }

  emitText(text: string) {
    this.top.appendChild(this.document.createTextNode(text))
  }

  openElt(name: string, attrs: Attributes) {
    let elt = this.top.appendChild(this.document.createElement(name))
    for (let i = 0; i < attrs.length;) elt.setAttribute(attrs[i++], attrs[i++])
    this.top = elt
  }

  closeElt() {
    this.top = this.top.parentNode as (DocumentFragment | HTMLElement)
  }
}

const selfClosing = new Set(["area", "base", "br", "col", "command", "embed", "frame",
                             "hr", "img", "input", "keygen", "link", "meta", "param",
                             "source", "track", "wbr", "menuitem"])

class HTMLContext extends Context {
  html = ""
  stack: string[] = []

  emitText(text: string) {
    this.html += text.replace(/[<&]/g, ch => ch == "<" ? "&lt;" : "&amp;")
  }

  openElt(name: string, attrs: Attributes) {
    this.html += "<" + name
    for (let i = 0; i < attrs.length;) {
      let name = attrs[i++], val = attrs[i++]
      this.html += " " + name
      if (val) this.html += '="' + val.replace(/["&]/g, ch => ch == '"' ? "&quot;" : "&amp;") + '"'
    }
    this.html += ">"
    this.stack.push(name)
  }

  closeElt() {
    let name = this.stack.pop()!
    if (!selfClosing.has(name)) this.html += "</" + name + ">"
  }
}

export function serialize(doc: Plot.Doc, options: SerializeOptions = {}) {
  let cx = new DOMContext(options, doc.schema)
  serializeChildren(doc.content, cx)
  return cx.top as DocumentFragment
}

export function serializeHTML(doc: Plot.Doc, options: SerializeOptions = {}) {
  let cx = new HTMLContext(options, doc.schema)
  serializeChildren(doc.content, cx)
  return cx.html
}

export function serializeNode(node: Plot, options: SerializeOptions & {schema: Schema}): HTMLElement | Text {
  let cx = new DOMContext(options, options.schema)
  serializeChildren([node], cx)
  return cx.top.firstChild as (HTMLElement | Text)
}

const genericTag = Plot.defineBlock("generic", {
  shape: {element: "div"}
})

function flattenSlice(
  content: readonly Token[],
  context: readonly Plot.Label.Any[], includeContext: number,
  openProp?: Prop.Type<string>
): readonly Part[] {
  let depth = 0, i = 0, scan = (inner: boolean): readonly Part[] => {
    let result: Part[] = []
    for (; i < content.length;) {
      let tok = content[i++]
      if (tok.tokenType == TokenType.Close) {
        if (inner) break
        let tag = depth < context.length ? context[depth++] : genericTag
        if (openProp) tag = tag.withProps(openProp.of("start").addToSet(tag.props))
        result = [tag.create(result)]
      } else if (tok.tokenType == TokenType.Open) {
        let content = scan(true), tag = tok
        if (openProp) tag = tag.withProps(openProp.of("end").addToSet(tag.props))
        result.push(tag.create(content))
      } else {
        result.push(tok)
      }
    }
    return result
  }
  let result = scan(false)
  while (depth < includeContext && depth < context.length) {
    let tag = context[depth++]
    if (openProp) tag = tag.withProps(openProp.of("start end").addToSet(tag.props))
    result = [tag.create(result)]
  }
  return result
}

export function serializeSlice(slice: Slice, options: SerializeOptions & {
  schema: Schema,
  openProp?: Prop.Type<string>,
  context?: readonly Plot.Label.Any[],
  includeContext?: number
}): DocumentFragment {
  let cx = new DOMContext(options, options.schema)
  serializeChildren(flattenSlice(slice.content, options.context || [], options.includeContext || 0, options.openProp), cx)
  return cx.top as DocumentFragment
}

export function serializeSliceHTML(slice: Slice, options: SerializeOptions & {
  schema: Schema,
  openProp?: Prop.Type<string>,
  context?: readonly Plot.Label.Any[],
  includeContext?: number
}): string {
  let cx = new HTMLContext(options, options.schema)
  serializeChildren(flattenSlice(slice.content, options.context || [], options.includeContext || 0, options.openProp), cx)
  return cx.html
}

function serializeNodeInner(node: Part, cx: Context) {
  let propAttrs: string[] = []
  for (let prop of node.label.props) if (!prop.type.element) {
    let repr = prop.type.repr as AttributeShape<any>
    let name = repr.attribute
    let value = typeof repr.value == "function" ? repr.value(prop.value) : repr.value ?? prop.value as string
    if (value != null) {
      if (/^style\//.test(name)) {
        value = name.slice(6) + ": " + value
        name = "style"
      }
      pushAttribute(propAttrs, name, value)
    }
  }
  let renderContent = node.isLeaf ? () => {} : (cx: Context) => {
    let {content} = node
    if (cx.emitNewlines && node.type.preserveWhitespace && cx.schema.lineBreak)
      content = lineBreaksToNewlines(content, cx.schema.lineBreak)
    serializeChildren(content, cx)
  }
  let repr = node.type.spec.shape
  if (Leaf.Text.chk(node)) {
    if (propAttrs.length) cx.openElt("span", propAttrs)
    cx.emitText(node.param)
    if (propAttrs.length) cx.closeElt()
  } else if (isElementShape(repr)) {
    let attrs = typeof repr.attributes == "function" ? repr.attributes(node.label.param) : repr.attributes
    let allAttrs = !attrs ? propAttrs : mergeAttributes(readAttributes(attrs), propAttrs)
    cx.openElt(repr.element, allAttrs)
    renderContent(cx)
    cx.closeElt()
  } else {
    let elt = typeof repr.structure == "function" ? repr.structure(node.label.param) : repr.structure
    if (propAttrs.length) elt = new Elt(elt.tagName, mergeAttributes(elt.attrs, propAttrs), elt.children)
    serializeStructure(elt, cx, renderContent)
  }
}

function serializeStructure(elt: Elt<string>, cx: Context, content: (cx: Context) => void) {
  cx.openElt(elt.tagName, elt.attrs)
  if (elt.children == null) {
    content(cx)
  } else {
    for (let ch of elt.children) {
      if (typeof ch == "string") cx.emitText(ch)
      else serializeStructure(ch, cx, content)
    }
  }
  cx.closeElt()
}

function lineBreaksToNewlines(nodes: readonly Part[], lineBreak: Leaf.Any) {
  if (!nodes.some(n => lineBreak.type.chk(n))) return nodes
  let result: Part[] = [], lastText = false
  for (let node of nodes) {
    let next = lineBreak.type.chk(node) ? Leaf.text("\n", node.props) : node
    if (lastText && next instanceof Plot) next.pushTo(result as Plot[])
    else result.push(next)
    lastText = next.isText
  }
  return result
}

function serializeChildren(children: readonly Part[], cx: Context) {
  let active: Prop[] = []
  for (let child of children) {
    if (active.length || child.props.some(p => isElementShape(p.type.repr))) {
      let keep = 0, rendered = 0, eltProps = []
      for (let prop of child.props)
        if (isElementShape(prop.type.repr)) eltProps.push(prop)
      while (keep < active.length && rendered < eltProps.length) {
        let next = eltProps[rendered]
        if (!next.eq(active[keep]) || !next.type.spanning) break
        keep++; rendered++
      }
      while (keep < active.length) {
        cx.closeElt()
        active.pop()
      }
      while (rendered < eltProps.length) {
        let add = eltProps[rendered++]
        let repr = add.type.repr as ElementShape<any>
        cx.openElt(repr.element, readAttributes(typeof repr.attributes == "function" ? repr.attributes(add.value) : repr.attributes))
        active.push(add)
      }
    }
    serializeNodeInner(child, cx)
  }
  for (let i = 0; i < active.length; i++) cx.closeElt()
}
