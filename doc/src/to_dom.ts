import {DocNode, Node} from "./node"
import {Prop} from "./prop"
import {Attrs, ElementRepresentation, AttributeRepresentation, isElementRepresentation, isAttributeRepresentation} from "./spec"

export type SerializeOptions = {
  document?: Document
}

function fillOptions(options: SerializeOptions | undefined): Required<SerializeOptions> {
  return {document: options?.document ?? document}
}

export function serialize(doc: DocNode, options?: SerializeOptions) {
  let opts = fillOptions(options)
  let result = opts.document.createDocumentFragment()
  serializeChildren(doc.children, result, opts, doc.tag.inlineContent())
  return result
}

export function serializeNode(node: Node, options?: SerializeOptions): HTMLElement | Text {
  let opts = fillOptions(options)
  let frag = opts.document.createDocumentFragment()
  serializeChildren([node], frag, opts, node.tag.isInline())
  return frag.firstChild as (HTMLElement | Text)
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

function serializeNodeInner(node: Node, options: Required<SerializeOptions>) {
  let {dom} = node.tag.type.spec, elt: HTMLElement | undefined, text: Text | undefined
  if (node.isText()) {
    text = options.document.createTextNode(node.text)
  } else if (typeof dom == "function") {
    elt = dom(node.tag.param) // FIXME include dangling parents
  } else {
    elt = options.document.createElement(dom.element)
    if (dom.attributes)
      applyAttributes(typeof dom.attributes == "function" ? dom.attributes(node.tag.param) : dom.attributes, elt)
  }
  for (let {type, value} of node.props.set) if (isAttributeRepresentation(type.spec.dom)) {
    if (!elt) {
      elt = document.createElement("span")
      elt.appendChild(text!)
    }
    applyAttribute(type.spec.dom, elt, value)
  }
  if (!text) serializeChildren(node.children, elt!, options, node.tag.inlineContent())
  return elt || text!
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
