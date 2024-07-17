import {DocNode, Node, PropValue} from "./node"

export type Attrs = {[name: string]: string | number | undefined}

export const Reject = {[Symbol()]: "reject"}

// FIXME typing of optional local props in node representations

export type Representation<Param> = ElementRepresentation<Param>
  | AttributeRepresentation<Param>
  | StyleRepresentation<Param>
  | DynamicElementRepresentation<Param>

export type ElementRepresentation<Param> = {
  tag: string // FIXME allow a function?
  selector?: string
  attrs?: Attrs | ((param: Param) => Attrs)
  read?: Param | ((elt: HTMLElement) => Param | typeof Reject)
}

export type DynamicElementRepresentation<Param> = {
  create: (param: Param) => HTMLElement
}

export function isElementRepresentation(repr: Representation<any>): repr is ElementRepresentation<any> {
  return (repr as ElementRepresentation<any>).tag != null
}

export type AttributeRepresentation<Param> = {
  attribute: string
  value?: (param: Param) => string | null
  read: (value: string) => Param | typeof Reject
}

export function isAttributeRepresentation(repr: Representation<any>): repr is AttributeRepresentation<any> {
  return (repr as AttributeRepresentation<any>).attribute != null
}

export type StyleRepresentation<Param> = {
  style: string
  value?: (param: Param) => string | null
  read: (value: string) => Param | typeof Reject
}

export function isStyleRepresentation(repr: Representation<any>): repr is StyleRepresentation<any> {
  return (repr as StyleRepresentation<any>).style != null
}

export type SerializeOptions = {
  document?: Document
}

function fillOptions(options: SerializeOptions | undefined): Required<SerializeOptions> {
  return {document: options?.document ?? document}
}

export function serialize(doc: DocNode, options?: SerializeOptions) {
  let opts = fillOptions(options)
  let result = opts.document.createDocumentFragment()
  serializeChildren(doc.children, result, opts, doc.type.inlineContent())
  return result
}

export function serializeNode(node: Node, options?: SerializeOptions): HTMLElement | Text {
  let opts = fillOptions(options)
  let frag = opts.document.createDocumentFragment()
  serializeChildren([node], frag, opts, node.type.isInline())
  return frag.firstChild as (HTMLElement | Text)
}

function createElement<Param>(repr: ElementRepresentation<Param>, param: Param, doc: Document) {
  let dom = doc.createElement(repr.tag)
  if (repr.attrs) {
    let attrs = typeof repr.attrs == "function" ? repr.attrs(param) : repr.attrs
    for (let attr in attrs) {
      let value = attrs[attr]
      if (value != null) dom.setAttribute(attr, String(value))
    }
  }
  return dom
}

function localProps(node: Node): {[name: string]: any} {
  let {props} = node.type, result: {[name: string]: any} = Object.create(null)
  for (let name in props) result[name] = node.prop(props[name])
  return result
}

function applyAttributes(attrs: Attrs, elt: Element) {
  for (let name in attrs) {
    let value = attrs[name]
    if (value != null) elt.setAttribute(name, String(value))
  }
}

function applyAttribute(repr: AttributeRepresentation<any>, elt: Element, input: any) {
  let value = repr.value ? repr.value(input) : String(input)
  if (value != null) elt.setAttribute(repr.attribute, value)
}

function applyStyle(repr: StyleRepresentation<any>, elt: HTMLElement, input: any) {
  let value = repr.value ? repr.value(input) : String(input)
  if (value != null) elt.style.setProperty(repr.style, value)
}

function serializeNodeInner(node: Node, options: Required<SerializeOptions>) {
  if (node.isText()) return options.document.createTextNode(node.text)
  let {dom} = node.type.spec, elt: HTMLElement
  if (isElementRepresentation(dom)) {
    elt = options.document.createElement(dom.tag)
    if (dom.attrs)
      applyAttributes(typeof dom.attrs == "function" ? dom.attrs(localProps(node)) : dom.attrs, elt)
  } else {
    elt = dom.create(localProps(node))
  }
  for (let {prop, value} of node.props.set) {
    let propDOM = prop.spec.dom
    if (propDOM) {
      if (isElementRepresentation(propDOM)) {
        if (prop.local) throw new Error("Local properties DOM representation must be an attribute or a style")
      } else if (isAttributeRepresentation(propDOM)) {
        applyAttribute(propDOM, elt, value)
      } else if (isStyleRepresentation(propDOM)) {
        applyStyle(propDOM, elt, value)
      }
    }
  }
  return elt
}

function serializeChildren(
  children: readonly Node[],
  target: Element | DocumentFragment,
  options: Required<SerializeOptions>,
  inline: boolean
) {
  let top = target, active: PropValue[] = []
  for (let child of children) {
    let childDOM = serializeNodeInner(child, options)
    if (active.length || child.props.set.some(p => !p.prop.local)) {
      let keep = 0, rendered = 0, eltProps = []
      for (let val of child.props.set) {
        let {dom} = val.prop.spec
        if (dom && isElementRepresentation(dom)) eltProps.push(val)
      }
      while (keep < active.length && rendered < eltProps.length) {
        let next = eltProps[rendered]
        if (!next.eq(active[keep]) || !(next.prop.spec.spanning ?? inline)) break
        keep++; rendered++
      }
      while (keep < active.length) {
        top = top.parentNode as (Element | DocumentFragment)
        active.pop()
      }
      while (rendered < eltProps.length) {
        let add = eltProps[rendered++]
        let markDOM = createElement(add.prop.spec.dom as ElementRepresentation<any>,
                                    add.value, options.document)
        active.push(add)
        top.appendChild(markDOM)
        top = markDOM
      }
    }
    top.appendChild(childDOM)
  }
}
