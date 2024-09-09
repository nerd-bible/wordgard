import {DocNode, Node, Tag, TokenType} from "./node"
import {Slice} from "./slice"
import {Prop, PropSet} from "./prop"
import {Attrs, ElementRepresentation, AttributeRepresentation,
        isElementRepresentation, isAttributeRepresentation} from "./spec"

export type SerializeOptions = {
  document?: Document
}

function fillOptions(options: SerializeOptions | undefined): Required<SerializeOptions> {
  return {document: options?.document ?? document}
}

// FIXME html string variants

export function serialize(doc: DocNode, options?: SerializeOptions) {
  let opts = fillOptions(options)
  let result = opts.document.createDocumentFragment()
  serializeChildren(doc.children, result, opts, doc.tag.inlineContent())
  return result
}

export function serializeNode(node: Node, options?: SerializeOptions): HTMLElement | Text {
  let opts = fillOptions(options)
  let frag = opts.document.createDocumentFragment()
  serializeChildren([node], frag, opts, node.isInline())
  return frag.firstChild as (HTMLElement | Text)
}

export function serializeSlice(slice: Slice, options?: SerializeOptions): DocumentFragment {
  let opts = fillOptions(options)
  let result = opts.document.createDocumentFragment(), top: DocumentFragment | HTMLElement = result
  let contextDepth = 0
  for (let i = 0; i < slice.content.length;) {
    let next = slice.content[i++]
    if (next.tokenType == TokenType.Node) {
      let start = i - 1
      while (i < slice.content.length && slice.content[i].tokenType == TokenType.Node) i++
      serializeChildren(slice.content.slice(start, i) as Node[], top, opts, next.isInline())
    } else if (next.tokenType == TokenType.Open) {
      let wrap = serializeNodeMarkup(next.node.tag, next.node.props, opts) as HTMLElement
      top.appendChild(wrap)
      top = wrap
    } else if (top.parentNode) {
      top = top.parentNode as DocumentFragment | HTMLElement
    } else {
      let wrap = slice.context.length < contextDepth ? opts.document.createElement("div")
        : serializeNodeMarkup(slice.context[contextDepth++], PropSet.empty, opts)
      wrap.appendChild(top)
      result = top = opts.document.createDocumentFragment()
      top.appendChild(wrap)
    }
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
    else elt.setAttribute(repr.attribute, value)
  }
}

function serializeNodeMarkup(tag: Tag, props: PropSet, options: Required<SerializeOptions>) {
  let {dom} = tag.type.spec, elt: HTMLElement | undefined, text: Text | undefined
  if (tag.isText()) {
    text = options.document.createTextNode(tag.param as string)
  } else if (typeof dom == "function") {
    elt = dom(tag.param) // FIXME include dangling parents
  } else {
    elt = options.document.createElement(dom.element)
    if (dom.attributes)
      applyAttributes(typeof dom.attributes == "function" ? dom.attributes(tag.param) : dom.attributes, elt)
  }
  for (let {type, value} of props.set) if (isAttributeRepresentation(type.spec.dom)) {
    if (!elt) {
      elt = document.createElement("span")
      elt.appendChild(text!)
    }
    applyAttribute(type.spec.dom, elt, value)
  }
  return elt || text!
}

function serializeNodeInner(node: Node, options: Required<SerializeOptions>) {
  let dom = serializeNodeMarkup(node.tag, node.props, options)
  if (!node.isLeaf()) serializeChildren(node.children, dom as HTMLElement, options, node.tag.inlineContent())
  return dom
}

function serializeChildren(
  children: readonly Node[],
  target: Element | DocumentFragment,
  options: Required<SerializeOptions>,
  inline: boolean
) {
  let top = target, active: Prop[] = []
  for (let child of children) {
    let childDOM = serializeNodeInner(child, options)
    if (active.length || child.props.set.some(p => isElementRepresentation(p.type.spec.dom))) {
      let keep = 0, rendered = 0, eltProps = []
      for (let prop of child.props.set)
        if (isElementRepresentation(prop.type.spec.dom)) eltProps.push(prop)
      while (keep < active.length && rendered < eltProps.length) {
        let next = eltProps[rendered]
        if (!next.eq(active[keep]) || !(next.type.spec.spanning ?? inline)) break
        keep++; rendered++
      }
      while (keep < active.length) {
        top = top.parentNode as (Element | DocumentFragment)
        active.pop()
      }
      while (rendered < eltProps.length) {
        let add = eltProps[rendered++]
        let markDOM = createElement(add.type.spec.dom as ElementRepresentation<any>,
                                    add.value, options.document)
        active.push(add)
        top.appendChild(markDOM)
        top = markDOM
      }
    }
    top.appendChild(childDOM)
  }
}
