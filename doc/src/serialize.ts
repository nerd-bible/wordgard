import {DocNode, Node, Tag, TokenType} from "./node"
import {Schema} from "./schema"
import {Slice, Token} from "./slice"
import {Prop, PropType} from "./prop"
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

export function serialize(doc: DocNode, options: SerializeOptions = {}) {
  let cx = new DOMContext(options, doc.schema)
  serializeChildren(doc.children, cx)
  return cx.top as DocumentFragment
}

export function serializeHTML(doc: DocNode, options: SerializeOptions = {}) {
  let cx = new HTMLContext(options, doc.schema)
  serializeChildren(doc.children, cx)
  return cx.html
}

export function serializeNode(node: Node, options: SerializeOptions & {schema: Schema}): HTMLElement | Text {
  let cx = new DOMContext(options, options.schema)
  serializeChildren([node], cx)
  return cx.top.firstChild as (HTMLElement | Text)
}

const genericTag = Tag.defineBlock("generic", {
  dom: {element: "div"}
})

type Nodeish = {tag: Tag<any>, children: readonly Nodeish[]}

function flattenSlice(
  content: readonly Token[],
  context: readonly Tag[], includeContext: number,
  openProp?: PropType<string>
): readonly Nodeish[] {
  let depth = 0, i = 0, scan = (inner: boolean): readonly Nodeish[] => {
    let result: Nodeish[] = []
    for (; i < content.length;) {
      let tok = content[i++]
      if (tok.tokenType == TokenType.Close) {
        if (inner) break
        let tag = depth < context.length ? context[depth++] : genericTag
        if (openProp) tag = tag.addProp(openProp.of("start"))
        result = [{tag, children: result}]
      } else if (tok.tokenType == TokenType.Open) {
        let content = scan(true), tag = tok
        if (openProp) tag = tag.addProp(openProp.of("end"))
        result.push({tag, children: content})
      } else {
        result.push(tok)
      }
    }
    return result
  }
  let result = scan(false)
  while (depth < includeContext && depth < context.length) {
    let tag = context[depth++]
    if (openProp) tag = tag.addProp(openProp.of("start end"))
    result = [{tag, children: result}]
  }
  return result
}

export function serializeSlice(slice: Slice, options: SerializeOptions & {
  schema: Schema,
  openProp?: PropType<string>,
  context?: readonly Tag[],
  includeContext?: number
}): DocumentFragment {
  let cx = new DOMContext(options, options.schema)
  serializeChildren(flattenSlice(slice.content, options.context || [], options.includeContext || 0, options.openProp), cx)
  return cx.top as DocumentFragment
}

export function serializeSliceHTML(slice: Slice, options: SerializeOptions & {
  schema: Schema,
  openProp?: PropType<string>,
  context?: readonly Tag[],
  includeContext?: number
}): string {
  let cx = new HTMLContext(options, options.schema)
  serializeChildren(flattenSlice(slice.content, options.context || [], options.includeContext || 0, options.openProp), cx)
  return cx.html
}

function serializeNodeInner(node: Nodeish, cx: Context) {
  let propAttrs: string[] = []
  for (let prop of node.tag.props) if (!prop.type.element) {
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
  let renderContent = (cx: Context) => {
    let {children} = node
    if (cx.emitNewlines && node.tag.type.preserveWhitespace && cx.schema.lineBreak)
      children = lineBreaksToNewlines(children, cx.schema.lineBreak)
    serializeChildren(children, cx)
  }
  let repr = node.tag.type.repr
  if (node.tag.isText()) {
    if (propAttrs.length) cx.openElt("span", propAttrs)
    cx.emitText(node.tag.param)
    if (propAttrs.length) cx.closeElt()
  } else if (isElementShape(repr)) {
    let attrs = typeof repr.attributes == "function" ? repr.attributes(node.tag.param) : repr.attributes
    let allAttrs = !attrs ? propAttrs : mergeAttributes(readAttributes(attrs), propAttrs)
    cx.openElt(repr.element, allAttrs)
    renderContent(cx)
    cx.closeElt()
  } else {
    let elt = typeof repr.structure == "function" ? repr.structure(node.tag.param) : repr.structure
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

function lineBreaksToNewlines(nodes: readonly Nodeish[], lineBreak: Tag<any>) {
  if (!nodes.some(n => n.tag == lineBreak)) return nodes
  let result: Nodeish[] = [], lastText = false
  for (let node of nodes) {
    let next = node.tag == lineBreak ? Node.text("\n", node.tag.props) : node
    if (lastText && next instanceof Node) next.pushTo(result as Node[])
    else result.push(next)
    lastText = next.tag.isText()
  }
  return result
}

function serializeChildren(children: readonly Nodeish[], cx: Context) {
  let active: Prop[] = []
  for (let child of children) {
    if (active.length || child.tag.props.some(p => isElementShape(p.type.repr))) {
      let keep = 0, rendered = 0, eltProps = []
      for (let prop of child.tag.props)
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
