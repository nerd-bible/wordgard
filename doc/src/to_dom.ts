import {DocNode, Node, Tag, TokenType} from "./node"
import {Schema} from "./schema"
import {Slice, CloseToken} from "./slice"
import {Prop} from "./prop"
import {Attrs, ElementRepresentation, AttributeRepresentation, StructureRepresentation,
        isElementRepresentation, isAttributeRepresentation} from "./spec"
import {OpenSide} from "./from_dom"

export type SerializeOptions = {
  document?: Document
  emitNewlines?: boolean
}

// FIXME use a serialization context class

export type FullOptions = {
  document: Document,
  emitNewlines: boolean,
  schema: Schema
}

function fillOptions(options: SerializeOptions | undefined, schema: Schema): FullOptions {
  return {
    document: options?.document ?? document,
    emitNewlines: options?.emitNewlines !== false,
    schema
  }
}

// FIXME html string variants

export function serialize(doc: DocNode, options?: SerializeOptions) {
  let opts = fillOptions(options, doc.schema)
  let result = opts.document.createDocumentFragment()
  serializeChildren(doc.children, result, opts, doc.tag.inlineContent())
  return result
}

export function serializeNode(node: Node, options: SerializeOptions & {schema: Schema}): HTMLElement | Text {
  let opts = fillOptions(options, options.schema)
  let frag = opts.document.createDocumentFragment()
  serializeChildren([node], frag, opts, node.isInline())
  return frag.firstChild as (HTMLElement | Text)
}

export function serializeSlice(slice: Slice, options: SerializeOptions & {
  schema: Schema,
  markOpen?: (elt: HTMLElement, side: OpenSide) => void
  context?: readonly Tag[]
}): DocumentFragment {
  let opts = fillOptions(options, options.schema)
  let result = opts.document.createDocumentFragment(), top: DocumentFragment | HTMLElement = result
  let context = options.context || [], stack: Tag<any>[] = []
  let contextDepth = 0
  for (let i = 0;;) {
    let next = i < slice.content.length ? slice.content[i++]
      : contextDepth < context.length ? CloseToken : null
    if (!next) break
    if (next.tokenType == TokenType.Node) {
      let start = i - 1
      while (i < slice.content.length && slice.content[i].tokenType == TokenType.Node) i++
      let parent = stack.length ? stack[stack.length - 1] : context[contextDepth]
      let children = slice.content.slice(start, i) as readonly Node[]
      if (options.emitNewlines && parent.type.preserveWhitespace && options.schema.lineBreak)
        children = lineBreaksToNewlines(children, options.schema.lineBreak)
      serializeChildren(children, top, opts, next.isInline())
    } else if (next.tokenType == TokenType.Open) {
      let {outer, content} = serializeNodeMarkup(next.tag, opts)
      top.appendChild(outer)
      if (!content) throw new Error("Cannot serialize an open token for an atom node")
      top = content
      stack.push(next.tag)
    } else if (top.parentNode) {
      if (i == slice.content.length && options.markOpen) options.markOpen(top as HTMLElement, OpenSide.End)
      top = top.parentNode as DocumentFragment | HTMLElement
      stack.pop()
    } else {
      let outer, content
      if (contextDepth >= context.length) {
        outer = content = opts.document.createElement("div")
      } else {
        ;({outer, content} = serializeNodeMarkup(context[contextDepth++], opts))
      }
      content!.appendChild(top)
      if (options.markOpen)
        options.markOpen(outer as HTMLElement, OpenSide.Start | (i == slice.content.length ? OpenSide.End : 0))
      result = top = opts.document.createDocumentFragment()
      top.appendChild(outer)
      stack.pop()
    }
  }
  while (top != result) {
    if (options.markOpen) options.markOpen(top as HTMLElement, OpenSide.End)
    top = top.parentNode as DocumentFragment | HTMLElement
  }
  return result
}

function createElement<Param>(repr: ElementRepresentation<Param>, param: Param, doc: Document) {
  let dom = doc.createElement(repr.element)
  if (repr.attributes) {
    let attrs = typeof repr.attributes == "function" ? repr.attributes(param) : repr.attributes
    for (let attr in attrs) {
      let value = attrs[attr]
      if (value != null) dom.setAttribute(attr, String(value))
    }
  }
  return dom
}

function applyAttributes(attrs: Attrs, elt: Element) {
  for (let name in attrs) {
    let value = attrs[name]
    if (value != null) elt.setAttribute(name, String(value))
  }
}

function applyAttribute(repr: AttributeRepresentation<any>, elt: HTMLElement, input: any) {
  let value = repr.value == null ? String(input) : typeof repr.value == "string" ? repr.value : repr.value(input)
  if (value != null) {
    if (/^style\//.test(repr.attribute)) elt.style.setProperty(repr.attribute.slice(6), value)
    else if (repr.attribute == "class") elt.classList.add(value)
    else elt.setAttribute(repr.attribute, value)
  }
}

function renderStructure<T>(repr: StructureRepresentation<T>, param: T, document: Document) {
  let content: HTMLElement | undefined
  function scan(repr: StructureRepresentation<T>) {
    let elt = document.createElement(typeof repr[0] == "function" ? repr[0](param) : repr[0])
    for (let i = 1; i < repr.length; i++) {
      let val = repr[i]
      if (typeof val == "function") {
        val = val(param)
        if (Array.isArray(val)) throw new Error("Dynamic parts of a structure representation may not return arrays")
      }
      if (i == 1 && typeof val == "object" && !Array.isArray(val)) {
        applyAttributes(val, elt)
      } else if (typeof val == "string") {
        elt.appendChild(document.createTextNode(val))
      } else if (val === 0) {
        if (i < repr.length - 1 || elt.firstChild) throw new Error("Hole markers can only appear as the only child of an element")
        if (content) throw new Error("Multiple holes found")
        content = elt
      } else if (Array.isArray(val)) {
        elt.appendChild(scan(val))
      } else {
        throw new Error("Invalid value in structure representation: " + val)
      }
    }
    return elt
  }
  return {outer: scan(repr), content}
}

function serializeNodeMarkup(tag: Tag, options: FullOptions) {
  let {dom} = tag.type.spec, elt: HTMLElement | undefined, content: HTMLElement | undefined, text: Text | undefined
  if (tag.isText()) {
    text = options.document.createTextNode(tag.param as string)
  } else if (Array.isArray(dom)) {
    let struct = renderStructure(dom, tag.param, options.document)
    elt = struct.outer
    content = struct.content
  } else {
    elt = options.document.createElement(dom.element)
    if (dom.attributes)
      applyAttributes(typeof dom.attributes == "function" ? dom.attributes(tag.param) : dom.attributes, elt)
    content = elt
  }
  for (let {type, value} of tag.props) if (isAttributeRepresentation(type.repr)) {
    if (!elt) {
      elt = document.createElement("span")
      elt.appendChild(text!)
    }
    applyAttribute(type.repr, elt, value)
  }
  return {outer: elt || text!, content}
}

function serializeNodeInner(node: Node, options: FullOptions) {
  let {outer, content} = serializeNodeMarkup(node.tag, options)
  if (!node.isAtom()) {
    if (!content) throw new Error("Non-atom node without a content hole in its representation")
    let {children} = node
    if (options.emitNewlines && node.type.preserveWhitespace && options.schema.lineBreak)
      children = lineBreaksToNewlines(children, options.schema.lineBreak)
    serializeChildren(children, content, options, node.tag.inlineContent())
  }
  return outer
}

function lineBreaksToNewlines(nodes: readonly Node[], lineBreak: Tag<any>) {
  if (!nodes.some(n => n.tag == lineBreak)) return nodes
  let result: Node[] = []
  for (let node of nodes)
    (node.tag == lineBreak ? Node.text("\n", node.tag.props) : node).pushTo(result)
  return result
}

function serializeChildren(
  children: readonly Node[],
  target: Element | DocumentFragment,
  options: FullOptions,
  inline: boolean
) {
  let top = target, active: Prop[] = []
  for (let child of children) {
    let childDOM = serializeNodeInner(child, options)
    if (active.length || child.tag.props.some(p => isElementRepresentation(p.type.repr))) {
      let keep = 0, rendered = 0, eltProps = []
      for (let prop of child.tag.props)
        if (isElementRepresentation(prop.type.repr)) eltProps.push(prop)
      while (keep < active.length && rendered < eltProps.length) {
        let next = eltProps[rendered]
        if (!next.eq(active[keep]) || !next.type.spanning) break
        keep++; rendered++
      }
      while (keep < active.length) {
        top = top.parentNode as (Element | DocumentFragment)
        active.pop()
      }
      while (rendered < eltProps.length) {
        let add = eltProps[rendered++]
        let markDOM = createElement(add.type.repr as ElementRepresentation<any>,
                                    add.value, options.document)
        active.push(add)
        top.appendChild(markDOM)
        top = markDOM
      }
    }
    top.appendChild(childDOM)
  }
}
