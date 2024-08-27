import {Schema} from "./schema"
import {Tag, Node, PropType, PropSet, Prop} from "./node"
import {ParseRule, isElementRepresentation} from "./spec"

type DOMNode = InstanceType<typeof window.Node>

function isEmpty<T>(obj: Record<string, T>) {
  for (let _ in obj) return false
  return true
}

function readProps(props: Record<string, PropType<any>>) {
  let read: {name: string, read: (node: HTMLElement) => string}[] = []
  for (let name in props) {
    let prop = props[name], {dom} = prop.spec
    if (!isAttributeRepresentation(prop.spec.dom)) throw new Error(`Missing DOM representation for local property ${prop.name}`)
    read.push({name, read: (
  }
}

function collectRules(schema: Schema) {
  let rules: ParseRule[] = []
  for (let node of schema.tags) {
    let {dom, parseRules} = node.spec
    // FIXME synthesize readElement from local attribute specs
    if (typeof dom != "function") rules.push({
      selector: dom.selector || dom.tag,
      readElement: dom.readElement || readProps(node.props)
      node
    })
    if (parseRules) for (let rule of parseRules) rules.push({...rule, node: rule.node || node})
  }
  for (let prop of schema.props) if (!prop.local) {
    let {dom, parseRules} = prop.spec
    if (isElementRepresentation(dom)) {
      rules.push({
        selector: dom.selector || dom.tag,
        readElement: dom.readElement,
        prop
      })
    } else {
      rules.push({
        attribute: dom.attribute,
        readAttribute: dom.readAttribute,
        prop
      })
    }
    if (parseRules) for (let rule of parseRules) rules.push({...rule, prop: rule.prop || prop})
  }
  return rules
}

export type ParseOptions = {
  // rules: readonly ParseRule[]

  /// Controls whether HTML-style whitespace collapsing is used
  /// (outside nodes that don't enable `preserveWhitespace`).
  preserveWhiteSpace?: boolean // FIXME rename
  /// When given, the parser will, beside parsing the content, record
  /// the document positions of the given DOM positions. It will do so
  /// by writing to the objects, setting a `pos` property that holds
  /// the document position.
  findPositions?: {node: DOMNode, offset: number, pos?: number}[]
}

export function parseDoc(schema: Schema, doc: HTMLElement | DocumentFragment, options: ParseOptions = {}) {
  let top = new NodeContext(schema.docTag, PropSet.empty, CxFlag.Solid, null)
  let cx = new ParseContext(schema, options, top)
  cx.parseChildren(doc, [])
  cx.sync(top)
  return top.finish(schema)
}

const enum CxFlag {
  None = 0,
  Open = 1,
  Solid = 2,
}

class ParseContext {
  find: {node: DOMNode, offset: number, pos?: number}[] | undefined

  constructor(readonly schema: Schema, readonly options: ParseOptions, public top: NodeContext) {
    this.find = options.findPositions
  }

  parseChildren(parent: HTMLElement | DocumentFragment, props: readonly Prop[]) {
    for (let ch = parent.firstChild; ch; ch = ch.nextSibling) {
      if (ch.nodeType == 1) this.parseElement(ch as HTMLElement, props)
      else if (ch.nodeType == 3) this.parseTextNode(ch as Text, props)
    }
  }

  parseElement(elt: HTMLElement, props: readonly Prop[]) {
    for (let type of this.schema.tags) {
      let repr = type.spec.dom
    }
  }

  parseTextNode(dom: Text, props: readonly Prop[]) {
    let text = dom.nodeValue!
    if (!(this.top.type.preserveWhitespace || this.options.preserveWhiteSpace)) {
      // Ignore entirely blank node
      if (!this.top.type.inlineContent() && !/[^ \t\r\n\u000c]/.test(text)) {
        this.scanInside(dom)
        return
      }
      // Collapse spans of whitespace into a single space
      text = text.replace(/[ \t\r\n\u000c]+/g, " ")
      // If this starts with whitespace, and there is no node before it, or
      // a hard break, or a text node that ends with whitespace, strip the
      // leading space.
      if (/^ /.test(text)) {
        let nodeBefore = this.top.children[this.top.children.length - 1]
        let domNodeBefore = dom.previousSibling
        if (!nodeBefore && !(this.top.flags & CxFlag.Open) ||
            (domNodeBefore && domNodeBefore.nodeName == 'BR') ||
            nodeBefore && nodeBefore.isText() && / $/.test(nodeBefore.text))
          text = text.slice(1)
      }
    } else {
      text = text.replace(/\r?\n|\r/g, this.top.type.preserveWhitespace ? "\n" : " ")
    }
    if (text) this.insertNode(Node.text(text), props)
    this.scanText(dom, text)
  }

  insertNode(node: Node, props: readonly Prop[]) {
    let innerProps = this.findPlace(node, props)
    if (innerProps) {
      let top = this.top
      let nodeProps = PropSet.empty
      for (let p of innerProps) if (p.type.canTarget(node.tag)) nodeProps = nodeProps.add(p)
      for (let p of node.props.set) nodeProps = nodeProps.add(p)
      top.children.push(node.withProps(nodeProps))
      return true
    }
    return false
  }

  // Try to find a way to fit the given node type into the current
  // context. May add intermediate wrappers and/or leave non-solid
  // nodes that we're in. Returns null if no place could be created, a
  // set of prop values not applied to wrappers otherwise.
  findPlace(node: Node, props: readonly Prop[]): readonly Prop[] | null {
    let route, under: NodeContext | undefined
    for (let cx: NodeContext = this.top;; cx = cx.parent!) {
      let found = this.schema.findWrapping(cx.type, node.tag)
      if (found && (!route || route.length > found.length)) {
        route = found
        under = cx
        if (!found.length) break
      }
      if (cx.flags & CxFlag.Solid) break
    }
    if (!route) return null
    this.sync(under!)
    for (let i = 0; i < route.length; i++)
      props = this.enterInner(route[i].tag, route[i].props, props, false)
    return props
  }

  // Open a node of the given type. Return the set of marks not
  // assigned to that node.
  enterInner(type: Tag, nodeProps: PropSet | null, props: readonly Prop[], solid: boolean = false) {
    let localProps = PropSet.empty
    props = props.filter(p => {
      if (!p.type.canTarget(type)) return true
      localProps = localProps.add(p)
      return false
    })
    if (nodeProps) for (let p of nodeProps.set) localProps = localProps.add(p)
    this.top = new NodeContext(type, localProps, solid ? CxFlag.Solid : CxFlag.None, this.top)
    return props
  }

  sync(to: NodeContext) {
    if (!this.top.isIn(to)) return false
    for (let cx: NodeContext = this.top; cx != to;) {
      let parent = cx.parent!
      parent.children.push(cx.finish(this.schema)) // FIXME use close method?
      cx = this.top = parent
    }
    return true
  }

  scanInside(dom: DOMNode) {
    if (this.find && dom.nodeType == 1) for (let query of this.find) {
      if (query.pos == null && dom.contains(query.node)) query.pos = this.currentPos()
    }
  }

  scanAtPoint(dom: DOMNode, offset: number) {
    if (this.find) for (let query of this.find) {
      if (query.node == dom && query.offset == offset) query.pos = this.currentPos()
    }
  }

  scanAround(parent: DOMNode, content: DOMNode, before: boolean) {
    if (parent != content && this.find && parent.nodeType == 1) for (let query of this.find) {
      if (query.pos == null && parent.contains(query.node) &&
          content.compareDocumentPosition(query.node) & (before ? 2 : 4))
        query.pos = this.currentPos()
    }
  }

  scanText(dom: Text, text: string) {
    if (this.find) for (let query of this.find) {
      if (query.node == dom) {
        let oldText = dom.nodeValue!, overlap = 0
        for (let i = oldText.length, j = text.length; i > query.offset && j > 0; i--, overlap++)
          if (oldText[i - 1] != text[j - 1]) break
        query.pos = this.currentPos() - overlap
      }
    }
  }

  currentPos() {
    for (let cx = this.top, pos = 0;;) {
      pos += cx.children.reduce((s, ch) => s + ch.length, 0)
      let {parent} = cx
      if (!parent) return pos
      cx = parent
      pos++
    }
  }
}

class NodeContext {
  children: Node[] = []

  constructor(readonly type: Tag, readonly props: PropSet,
              readonly flags: CxFlag,
              readonly parent: NodeContext | null) {}

  isIn(parent: NodeContext) {
    for (let cx: NodeContext | null = this; cx; cx = cx.parent) if (cx == parent) return true
    return false
  }

  finish(schema: Schema) {
    if (!this.type.inlineContent() && !this.type.isLeaf() && !this.children.length)
      this.children.push(schema.createDefault(this.type))
    return this.type.isDoc() ? schema.doc(this.children) : this.type.create(this.props, this.children)
  }
}
