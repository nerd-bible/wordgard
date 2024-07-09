import {DocNode, Node, Mark, Params, Param} from "./node"

export type Attrs = {[name: string]: string | number | undefined}

export type ElementRepresentation<Params extends {} = {}> = {
  tag: string // FIXME allow a function?
  selector?: string
  attrs?: Attrs | ((params: Params) => Attrs)
  params?: Params | ((elt: HTMLElement) => Params | boolean)
}

export function isElementRepresentation(
  repr: ElementRepresentation | AttributeRepresentation | StyleRepresentation
): repr is ElementRepresentation {
  return (repr as ElementRepresentation).tag != null
}

export type AttributeRepresentation<Params extends {} = {}> = {
  attribute: string
  value: (params: Params) => string
  params: (value: string) => Params | boolean
}

export function isAttributeRepresentation(
  repr: ElementRepresentation | AttributeRepresentation | StyleRepresentation
): repr is AttributeRepresentation {
  return (repr as AttributeRepresentation).attribute != null
}

export type StyleRepresentation<Params extends {} = {}> = {
  style: string
  value: (params: Params) => string
  params: (value: string) => Params | boolean
}

export function isStyleRepresentation(
  repr: ElementRepresentation | AttributeRepresentation | StyleRepresentation
): repr is StyleRepresentation {
  return (repr as StyleRepresentation).style != null
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

export function serializeNode(node: Node, options?: SerializeOptions) {
  return serializeNodeInner(node, fillOptions(options))
}

function createElement(repr: ElementRepresentation<Params>, params: readonly Param[], values: Params, doc: Document) {
  let dom = doc.createElement(repr.tag)
  if (repr.attrs) {
    let attrs = typeof repr.attrs == "function" ? repr.attrs(values) : repr.attrs
    for (let attr in attrs) dom.setAttribute(attr, values[attr])
  } else {
    for (let param of params) {
      let attr = param.spec.attribute!, value = values[attr]
      if (value != null) dom.setAttribute(attr, value)
    }
  }
  return dom
}

function serializeNodeInner(node: Node, options: Required<SerializeOptions>) {
  if (node.isText()) return options.document.createTextNode(node.text)
  let dom = createElement(node.type.spec.dom, node.type.params, node.params, options.document)
  serializeChildren(node.children, dom, options, node.inlineContent())
  return dom
}

function serializeChildren(
  children: readonly Node[],
  target: Element | DocumentFragment,
  options: Required<SerializeOptions>,
  inline: boolean
) {
  let top = target, active: Mark[] = []
  for (let child of children) {
    let childDOM = serializeNodeInner(child, options)
    if (active.length || child.marks.length) {
      let keep = 0, rendered = 0, eltMarks = []
      for (let mark of child.marks) {
        let {dom} = mark.type.spec
        if (isElementRepresentation(dom)) {
          eltMarks.push(mark)
        } else {
          if (childDOM.nodeType != 1) {
            let wrap = options.document.createElement("span")
            wrap.appendChild(childDOM)
            childDOM = wrap
          }
          let value = typeof dom.value == "function" ? dom.value(mark.params) : dom.value
          if (value != null) {
            if (isAttributeRepresentation(dom))
              (childDOM as HTMLElement).setAttribute(dom.attribute, value)
            else
              (childDOM as HTMLElement).style.setProperty(dom.style, value)
          }
        }
      }
      while (keep < active.length && rendered < eltMarks.length) {
        let next = eltMarks[rendered]
        if (!next.eq(active[keep]) || !(next.type.spec.spanning ?? inline)) break
        keep++; rendered++
      }
      while (keep < active.length) {
        top = top.parentNode as (Element | DocumentFragment)
        active.pop()
      }
      while (rendered < eltMarks.length) {
        let add = eltMarks[rendered++]
        let markDOM = createElement(add.type.spec.dom as ElementRepresentation,
                                    add.type.params, add.params, options.document)
        active.push(add)
        top.appendChild(markDOM)
        top = markDOM
      }
    }
    top.appendChild(childDOM)
  }
}
