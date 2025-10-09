import {Schema} from "./schema"
import {Tag, TagType, Node, DocNode, Text} from "./node"
import {Prop, PropType} from "./prop"
import {Slice, Token, CloseToken} from "./slice"
import {ParseRule, ElementParseRule, isElementParseRule, AttributeParseRule} from "./spec"
import {isElementShape, Reject} from "./shape"

type DOMNode = InstanceType<typeof window.Node>

class RuleSet {
  elementRules: ElementParseRule<unknown>[] = []
  attributeRules: AttributeParseRule<unknown>[] = []

  constructor(rules: readonly ParseRule[]) {
    for (let rule of rules) {
      if (isElementParseRule(rule)) this.elementRules.push(rule)
      else this.attributeRules.push(rule)
    }
  }

  static fromSchema(schema: Schema) {
    let rules: ParseRule[] = []
    for (let tag of schema.tags) {
      let {spec: {shape, parseRules}} = tag
      if (isElementShape(shape) && shape.element) rules.push({
        selector: shape.selector || shape.element,
        readElement: shape.readElement,
        tag
      })
      if (parseRules) for (let rule of parseRules) rules.push({...rule, tag: rule.tag || tag})
    }
    for (let prop of schema.props) {
      let {shape, parseRules} = prop.spec
      if (isElementShape(shape)) {
        rules.push({
          selector: shape.selector || shape.element,
          readElement: shape.readElement,
          prop
        })
      } else {
        rules.push({
          attribute: shape.attribute,
          readAttribute: shape.readAttribute,
          prop
        })
      }
      if (parseRules) for (let rule of parseRules) rules.push({...rule, prop: rule.prop || prop})
    }
    return new RuleSet(rules)
  }

  matchElement(elt: HTMLElement): {rule: ElementParseRule<unknown>, value?: unknown} | null {
    for (let rule of this.elementRules) {
      if (elt.matches(rule.selector)) {
        if (!rule.readElement) return Object.prototype.hasOwnProperty.call(rule, "param") ? {rule, value: rule.param} : {rule}
        let result = rule.readElement(elt)
        if (result === Reject) continue
        return {rule, value: result}
      }
    }
    return null
  }
}

export type ParseOptions = {
  // rules: readonly ParseRule[]

  /// Controls whether HTML-style whitespace collapsing is used
  /// (outside nodes that don't enable `preserveWhitespace`). Defaults
  /// to true.
  collapseWhiteSpace?: boolean
  /// When given, the parser will, beside parsing the content, record
  /// the document positions of the given DOM positions. It will do so
  /// by writing to the objects, setting a `pos` property that holds
  /// the document position.
  findPositions?: {node: DOMNode, offset: number, pos?: number}[] // FIXME no longer needed?
  isOpen?: (elt: HTMLElement) => OpenSide
}

export function parseDoc(schema: Schema, doc: HTMLElement | DocumentFragment, options: ParseOptions = {}) {
  let top = new NodeContext(schema.docTag, CxFlag.Solid, null)
  let cx = new ParseContext(schema, options, top)
  cx.parseChildren(doc, [], false)
  cx.sync(top)
  return cx.finishNode(cx.top) as DocNode
}

export enum OpenSide { None = 0, Start = 1, End = 2, Both = 3 }

export function parseSlice(schema: Schema, doc: HTMLElement | DocumentFragment, options: ParseOptions = {}) {
  let top = new NodeContext(guessParent(doc, schema), CxFlag.Solid | CxFlag.OpenStart | CxFlag.OpenEnd, null)
  let cx = new ParseContext(schema, options, top)
  cx.parseChildren(doc, [], true)
  cx.sync(top)
  let tokens: Token[] = [], context: Tag[] = []
  let emitTokens = (children: readonly Node[], openStart: boolean, openEnd: boolean) => {
    for (let i = 0; i < children.length; i++) {
      let child = children[i]
      if (openStart && i == 0 && !child.isLeaf && ((cx.open.get(child) || 0) & CxFlag.OpenStart)) {
        if (children.length == 1 && openEnd && ((cx.open.get(child) || 0) & CxFlag.OpenEnd)) {
          emitTokens(child.children, true, true)
        } else {
          emitTokens(child.children, true, false)
          tokens.push(CloseToken)
        }
        context.push(children[0].tag)
      } else if (openEnd && i == children.length - 1 && !child.isLeaf && ((cx.open.get(child) || 0) & CxFlag.OpenEnd)) {
        tokens.push(child.tag)
        emitTokens(child.children, false, true)
      } else {
        tokens.push(child)
      }
    }
  }
  emitTokens(top.children, true, true)
  return {slice: new Slice(tokens), context}
}

const enum CxFlag {
  None = 0,
  OpenStart = 1,
  OpenEnd = 2,
  Solid = 4,
}

class ParseContext {
  find: {node: DOMNode, offset: number, pos?: number}[] | undefined
  rules: RuleSet
  open: Map<Node, CxFlag> = new Map

  constructor(readonly schema: Schema, readonly options: ParseOptions, public top: NodeContext) {
    this.find = options.findPositions
    this.rules = RuleSet.fromSchema(schema)
  }

  parseChildren(parent: HTMLElement | DocumentFragment, props: readonly Prop[], endOfSlice: boolean) {
    for (let ch = parent.firstChild; ch; ch = ch.nextSibling) {
      if (ch.nodeType == 1) this.parseElement(ch as HTMLElement, props, endOfSlice && !ch.nextSibling)
      else if (ch.nodeType == 3) this.parseTextNode(ch as Text, props)
    }
  }

  ignoreElement(elt: HTMLElement, props: readonly Prop[]) {
    if (elt.nodeName == "BR" && !this.top.tag.inlineContent)
      this.findPlace(Text.of("-"), props, false)
  }

  parseElement(elt: HTMLElement, props: readonly Prop[], endOfSlice: boolean) {
    let name = elt.nodeName.toLowerCase()
    if (name in normalizers) normalizers[name](elt)
    let match = this.rules.matchElement(elt)
    if (match ? match.rule.ignore === true : ignoreTags.has(name)) {
      this.scanInside(elt)
      this.ignoreElement(elt, props)
    } else if (!match || match.rule.ignore === "skip") {
      let sync, top = this.top
      if (blockTags.has(name)) {
        if (top.children.length && top.children[0].isInline) this.close()
        sync = true
      }
      let innerProps = match && match.rule.ignore ? props : this.parseAttributes(elt, props)
      if (innerProps) this.parseChildren(elt, innerProps, endOfSlice)
      if (sync) this.sync(top)
    } else {
      let innerProps = this.parseAttributes(elt, props)
      if (innerProps)
        this.parseElementByRule(elt, match, innerProps, endOfSlice)
    }
  }

  parseElementByRule(elt: HTMLElement, match: {rule: ElementParseRule<unknown>, value?: unknown},
                     props: readonly Prop[], endOfSlice: boolean) {
    let sync, tag, {rule} = match, hasValue = Object.prototype.hasOwnProperty.call(match, "value")
    if (rule.tag) {
      tag = rule.tag instanceof Tag ? rule.tag :
        rule.tag instanceof TagType ? (hasValue ? rule.tag.of(match.value) : rule.tag.default) : null
      if (!tag) throw new Error(`Parse rule for ${rule.selector} does not produce a tag`)
      if (tag.isLeaf) {
        this.insertNode(tag.create(), props)
      } else {
        let innerProps = this.enter(tag, props, endOfSlice, elt)
        if (innerProps) {
          sync = true
          props = innerProps
        }
      }
    } else {
      let prop = rule.prop instanceof Prop ? rule.prop :
        rule.prop instanceof PropType ? (hasValue ? rule.prop.of(match.value) : rule.prop.default) : null
      if (!prop) throw new Error(`Parse rule for ${rule.selector} does not produce a prop`)
      props = props.concat(prop)
    }
    let startIn = this.top

    if (tag && tag.isLeaf) {
      this.scanInside(elt)
    } else {
      let content = elt
      if (typeof rule.contentElement == "string") content = elt.querySelector(rule.contentElement) || elt
      else if (typeof rule.contentElement == "function") content = rule.contentElement(elt)
      if (content != elt) this.scanAround(elt, content, true)
      this.parseChildren(content, props, endOfSlice)
      if (content != elt) this.scanAround(elt, content, false)
    }
    if (sync && this.sync(startIn)) this.close()
  }

  parseTextNode(dom: Text, props: readonly Prop[]) {
    let text = dom.nodeValue!
    if (!this.top.tag.type.preserveWhitespace && this.options.collapseWhiteSpace !== false) {
      // Ignore entirely blank node
      if (!this.top.tag.inlineContent && !/[^ \t\r\n\u000c]/.test(text)) {
        this.scanInside(dom)
        return
      }
      // Collapse spans of whitespace into a single space
      text = text.replace(/[ \t\r\n\u000c]+/g, " ")
      // If this starts with whitespace, and there is no node before it,
      // or a line break, or a text node that ends with whitespace,
      // strip the leading space.
      if (/^ /.test(text)) {
        let nodeBefore = this.top.children[this.top.children.length - 1]
        if (nodeBefore
            ? nodeBefore.tag == this.schema.lineBreak || nodeBefore.isText && / $/.test(nodeBefore.text!)
            : !(this.top.flags & CxFlag.OpenStart))
          text = text.slice(1)
      }
      if (text) this.insertNode(Node.text(text), props)
    } else if (this.top.tag.type.preserveWhitespace && this.schema.lineBreak) {
      let lines = text.split(/\r?\n|\r/g)
      for (let i = 0; i < lines.length; i++) {
        if (i) this.insertNode(this.schema.lineBreak.create(), props)
        if (lines[i]) this.insertNode(Node.text(lines[i]), props)
      }
    } else {
      text = text.replace(/\r?\n|\r/g, " ")
      if (text) this.insertNode(Node.text(text), props)
    }
    this.scanText(dom, text)
  }

  parseAttributes(elt: HTMLElement, props: readonly Prop[]) {
    let matched = new Set<string>(), hasStyles = elt.style.length > 0
    for (let rule of this.rules.attributeRules) if (!matched.has(rule.attribute)) {
      let isStyle = /^style\//.test(rule.attribute)
      let value = !isStyle ? elt.getAttribute(rule.attribute) :
        hasStyles ? elt.style.getPropertyValue(rule.attribute.slice(6)) : ""
      if (!value) continue
      let hasParam = Object.prototype.hasOwnProperty.call(rule, "param"), param = rule.param
      if (rule.readAttribute) {
        param = rule.readAttribute(value)
        hasParam = true
        if (param == Reject) continue
      } else if (rule.value != null && rule.value != value) {
        continue
      }
      if (rule.ignore) return null
      if (rule.consuming !== false) matched.add(rule.attribute)
      if (rule.clearProp) {
        props = props.filter(p => !rule.clearProp!(p))
      } else {
        let prop = rule.prop instanceof Prop ? rule.prop :
          rule.prop instanceof PropType ? (hasParam ? rule.prop.of(param) : rule.prop.default) : null
        if (!prop) throw new Error(`Parse rule for ${rule.attribute} does not produce a prop (or have ignore/clearProp properties)`)
        props = props.concat(prop)
      }
    }
    return props
  }

  insertNode(node: Node, props: readonly Prop[]) {
    let innerProps = this.findPlace(node.tag, props, false)
    if (innerProps) {
      let top = this.top, tag = node.tag
      for (let p of innerProps) if (p.type.canTarget(tag.type)) tag = tag.addProp(p)
      for (let p of node.tag.props) tag = tag.addProp(p)
      tag.create(node.children).pushTo(top.children)
      return true
    }
    return false
  }

  // Try to find a way to fit the given node type into the current
  // context. May add intermediate wrappers and/or leave non-solid
  // nodes that we're in. Returns null if no place could be created, a
  // set of prop values not applied to wrappers otherwise.
  findPlace(tag: Tag<any>, props: readonly Prop[], endOfSlice: boolean): readonly Prop[] | null {
    let route, under: NodeContext | undefined
    for (let cx: NodeContext = this.top;; cx = cx.parent!) {
      let found = this.schema.findWrapping(cx.tag.type, tag.type)
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
      props = this.enterInner(route[i], props, endOfSlice, null)
    return props
  }

  enter(tag: Tag<unknown>, props: readonly Prop[], endOfSlice: boolean, elt: HTMLElement) {
    let innerProps = this.findPlace(tag, props, endOfSlice)
    if (innerProps) innerProps = this.enterInner(tag, props, endOfSlice, elt)
    return innerProps
  }

  // Open a node of the given type. Return the set of marks not
  // assigned to that node.
  enterInner(tag: Tag<any>, props: readonly Prop[], endOfSlice: boolean, element: HTMLElement | null) {
    props = props.filter(p => {
      if (!p.type.canTarget(tag.type)) return true
      tag = tag.addProp(p)
      return false
    })
    let open = (this.top.children.length ? 0 : this.top.flags & CxFlag.OpenStart) |
      (endOfSlice ? this.top.flags & CxFlag.OpenEnd : 0)
    if (open && element && this.options.isOpen) {
      let test = this.options.isOpen(element)
      if (!(test & OpenSide.Start)) open &= ~CxFlag.OpenStart
      if (!(test & OpenSide.End)) open &= ~CxFlag.OpenEnd
    }
    this.top = new NodeContext(tag, (element ? CxFlag.Solid : CxFlag.None) | open, this.top)
    return props
  }

  sync(to: NodeContext) {
    if (!this.top.isIn(to)) return false
    while (this.top != to) this.close()
    return true
  }

  close() {
    let parent = this.top.parent!
    parent.children.push(this.finishNode(this.top))
    this.top = parent
  }

  finishNode(cx: NodeContext) {
    if (!(cx.flags & CxFlag.OpenEnd) && cx.children.length && !cx.tag.type.preserveWhitespace &&
        this.options.collapseWhiteSpace !== false) {
      let last = cx.children[cx.children.length - 1], m
      if (last.isText && (m = /[ \t\r\n\u000c]+$/.exec(last.text!))) {
        let len = last.text!.length - m[0].length
        if (!len) cx.children.pop()
        else cx.children[cx.children.length - 1] = last.sliceText(0, len)
      }
    }
    let open = cx.flags & (CxFlag.OpenEnd | CxFlag.OpenStart)
    if (!open && !cx.tag.inlineContent && !cx.tag.isLeaf && !cx.children.length)
      cx.children.push(this.schema.createDefault(cx.tag.type))
    let node = cx.tag.isDoc ? this.schema.doc(cx.children) : cx.tag.create(cx.children)
    if (open) this.open.set(node, open)
    return node
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

  constructor(readonly tag: Tag<any>,
              readonly flags: CxFlag,
              readonly parent: NodeContext | null) {}

  isIn(parent: NodeContext) {
    for (let cx: NodeContext | null = this; cx; cx = cx.parent) if (cx == parent) return true
    return false
  }
}

// Kludge to work around directly nested list nodes produced by some
// tools and allowed by browsers to mean that the nested list is
// actually part of the list item above it.
function normalizeList(dom: HTMLElement) {
  for (let child = dom.firstChild, prevItem: ChildNode | null = null; child; child = child.nextSibling) {
    if (child.nodeType != 1) continue
    let name = child.nodeName.toLowerCase()
    if (prevItem && (name == "ol" || name == "ul")) {
      prevItem.appendChild(child)
      child = prevItem
    } else {
      prevItem = name == "li" ? child : null
    }
  }
}

const normalizers: Record<string, (dom: HTMLElement) => void> = {ol: normalizeList, ul: normalizeList}
  
const ignoreTags = new Set(["head", "noscript", "object", "script", "style", "title"])

const blockTags = new Set(["address", "article", "aside", "blockquote", "canvas", "dd", "div", "dl",
                           "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
                           "h6", "header", "hgroup", "hr", "li", "noscript", "ol", "output", "p", "pre",
                           "section", "table", "tfoot", "ul"])

function guessParent(content: DocumentFragment | HTMLElement, schema: Schema) {
  let rules = RuleSet.fromSchema(schema) // FIXME avoid recomputing these
  let tags: TagType<any>[] = []
  let explore = (node: DOMNode) => {
    if (node.nodeType == 3) {
      tags.push(Text)
    } else if (node.nodeType == 1) {
      let match = rules.matchElement(node as HTMLElement)
      if (match && match.rule.tag) {
        tags.push(match.rule.tag instanceof Tag ? match.rule.tag.type : match.rule.tag)
      } else if (!(match && match.rule.ignore)) {
        for (let ch = node.firstChild; ch; ch = ch.nextSibling) explore(ch)
      }
    }
  }
  explore(content)
  let best: Tag | undefined, bestCost = 0
  scan: for (let parent of schema.tags) if (parent.default) {
    let cost = parent.isDoc ? -1 : 0
    for (let child of tags) {
      let fit = schema.findWrapping(parent, child)
      cost += fit ? fit.length * 2 : 1000
    }
    if (!best || bestCost > cost) {
      best = parent.default
      bestCost = cost
    }
  }
  return best!
}
