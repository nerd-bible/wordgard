import {Schema} from "./schema"
import {Plot, Node, Leaf} from "./node"
import {Mark} from "./mark"
import {Slice, Token} from "./slice"

type DOMNode = InstanceType<typeof window.Node>
type DOMElement = Element

export function parse(schema: Schema, doc: Element | DocumentFragment, options: parse.Options = {}) {
  let top = new NodeContext(schema.docTag, CxFlag.Solid, null)
  let cx = new ParseContext(schema, options, top)
  cx.parseChildren(doc, [], false)
  cx.sync(top)
  return cx.finishNode(cx.top) as Plot.Doc
}

export namespace parse {
  export type Options = {
    /// Controls whether HTML-style whitespace collapsing is used
    /// (outside nodes that don't enable `preserveWhitespace`). Defaults
    /// to true.
    collapseWhiteSpace?: boolean
    /// Function used in in {@link Parse.slice} to determine
    /// whether a given element is open (on either side).
    isOpen?: (elt: Element) => null | "start" | "end" | "start end"
    /// The rule set to use. Defaults to the rule set derived from the
    /// schema.
    ruleSet?: parse.Rule.Set
  }

  export function slice(schema: Schema, doc: Element | DocumentFragment, options: parse.Options = {}) {
    let top = new NodeContext(guessParent(doc, schema), CxFlag.Solid | CxFlag.OpenStart | CxFlag.OpenEnd, null)
    let cx = new ParseContext(schema, options, top)
    cx.parseChildren(doc, [], true)
    cx.sync(top)
    let tokens: Token[] = [], context: Plot.Tag.Any[] = []
    let emitTokens = (children: readonly Node[], openStart: boolean, openEnd: boolean) => {
      for (let i = 0; i < children.length; i++) {
        let child = children[i]
        if (openStart && i == 0 && child.isPlot && ((cx.open.get(child) || 0) & CxFlag.OpenStart)) {
          if (children.length == 1 && openEnd && ((cx.open.get(child) || 0) & CxFlag.OpenEnd)) {
            emitTokens(child.content, true, true)
          } else {
            emitTokens(child.content, true, false)
            tokens.push(Plot.End)
          }
          context.push(child.tag)
        } else if (openEnd && i == children.length - 1 && child.isPlot && ((cx.open.get(child) || 0) & CxFlag.OpenEnd)) {
          tokens.push(child.tag)
          emitTokens((child as Plot).content, false, true)
        } else {
          tokens.push(child)
        }
      }
    }
    emitTokens(top.children, true, true)
    return {slice: Slice.of(tokens), context}
  }

  export type Rule<Param = any> = Rule.Element<Param> | Rule.Attribute<Param>

  export namespace Rule {
    export interface Element<Param> {
      selector: string
      plot?: Plot.Tag<Param> | Plot.Type<Param>
        leaf?: Leaf<Param> | Leaf.Type<Param>
        mark?: Mark.Type<Param> | Mark<Param>
        ignore?: boolean | "skip"
      param?: Param
      readElement?: (element: DOMElement) => Param | Rule.Reject
      marksFrom?: string
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
      readAttribute?: (value: string) => Param | Rule.Reject
      consuming?: boolean
      /// A number between -10 and 10 (inclusive) that specifies the
      /// relative precedence of this rule. Defaults to 0.
      precedence?: number
    }

    export const Reject: unique symbol = Symbol("reject")
    export type Reject = typeof Rule.Reject

    const schemaCache = new WeakMap<Schema, Rule.Set>()

    function addByPrec<T extends {precedence?: number}>(array: T[], value: T) {
      let prec = value.precedence ?? 0, i = array.length
      while (i > 0 && prec > (array[i - 1].precedence ?? 0)) i--
      array.splice(i, 0, value)
    }

    /// A collection of parse rules. Usually derived from a schema.
    export class Set {
      /// @internal
      elementRules: Rule.Element<unknown>[] = []
      /// @internal
      attributeRules: Rule.Attribute<unknown>[] = []

      private constructor(readonly rules: readonly Rule[]) {
        for (let rule of rules) addByPrec("selector" in rule ? this.elementRules : this.attributeRules, rule)
      }

      /// Create a rule set with the given parse rules.
      static of(rules: readonly Rule[]) { return new Set(rules) }

      /// Create a rule set containing all the parse rules attached to
      /// nodes and marks in the given schema, as well as the rules that
      /// can be derived from the node and mark shape declarations.
      static fromSchema(schema: Schema) {
        let cached = schemaCache.get(schema)
        if (cached) return cached

        let rules: Rule[] = []
        for (let tag of schema.tags) {
          let {spec: {shape, parseRules}} = tag
          if ("element" in shape && shape.element && (shape.readElement || tag.default)) rules.push({
            selector: shape.selector || shape.element,
            readElement: shape.readElement,
            leaf: tag.isLeaf ? tag : undefined,
            plot: tag.isLeaf ? undefined : tag
          })
          if (parseRules) for (let rule of parseRules) rules.push({
            ...rule,
            leaf: rule.leaf || (tag.isLeaf ? tag : undefined),
            plot: rule.plot || (tag.isLeaf ? undefined : tag)
          })
        }
        for (let mark of schema.marks) {
          let {shape, parseRules} = mark.spec
          if (parseRules) for (let rule of parseRules) rules.push({...rule, mark: rule.mark || mark})
          if ("element" in shape && (shape.readElement || mark.default)) {
            rules.push({
              selector: shape.selector || shape.element,
              readElement: shape.readElement,
              mark
            })
          } else if ("attribute" in shape) {
            if (shape.readAttribute) {
              rules.push({
                attribute: shape.attribute,
                readAttribute: shape.readAttribute,
                mark
              })
            } else if (typeof shape.value == "string") {
              rules.push({
                attribute: shape.attribute,
                value: shape.value,
                mark
              })
            } else if (shape.value === 0) {
              rules.push({
                attribute: shape.attribute,
                readAttribute: param => param,
                mark
              })
            }
          }
        }
        let result = new Rule.Set(rules)
        schemaCache.set(schema, result)
        return result
      }

      /// @internal
      matchElement(elt: DOMElement): {rule: Rule.Element<unknown>, value?: unknown} | null {
        for (let rule of this.elementRules) {
          if (elt.matches(rule.selector)) {
            if (!rule.readElement) return Object.prototype.hasOwnProperty.call(rule, "param") ? {rule, value: rule.param} : {rule}
            let result = rule.readElement(elt)
            if (result === Rule.Reject) continue
            return {rule, value: result}
          }
        }
        return null
      }
    }
  }
}

const enum CxFlag {
  None = 0,
  OpenStart = 1,
  OpenEnd = 2,
  Solid = 4,
}

class ParseContext {
  rules: parse.Rule.Set
  open: Map<Plot, CxFlag> = new Map

  constructor(readonly schema: Schema, readonly options: parse.Options, public top: NodeContext) {
    this.rules = options.ruleSet || parse.Rule.Set.fromSchema(schema)
  }

  parseChildren(parent: Element | DocumentFragment, marks: readonly Mark[], endOfSlice: boolean,
                ignore?: string | ((elt: Element) => boolean)) {
    for (let ch = parent.firstChild; ch; ch = ch.nextSibling) {
      if (ch.nodeType == 1)
        this.parseElement(ch as Element, marks, endOfSlice && !ch.nextSibling)
      else if (ch.nodeType == 3 &&
               !(ignore && (typeof ignore == "string" ? (ch as Element).matches(ignore) : ignore(ch as Element))))
        this.parseTextNode(ch as Text, marks)
    }
  }

  ignoreElement(elt: Element, marks: readonly Mark[]) {
    if (elt.nodeName == "BR" && !this.top.tag.inlineContent)
      this.findPlace(Leaf.Text.of("-"), marks, false)
  }

  parseElement(elt: Element, marks: readonly Mark[], endOfSlice: boolean) {
    let name = elt.nodeName.toLowerCase()
    if (name in normalizers) normalizers[name](elt)
    let match = this.rules.matchElement(elt)
    if (match ? match.rule.ignore === true : ignoreTags.has(name)) {
      this.ignoreElement(elt, marks)
    } else if (!match || match.rule.ignore === "skip") {
      let sync, top = this.top
      if (blockTags.has(name)) {
        if (top.children.length && top.children[0].type.isInline) this.close()
        sync = true
      }
      let innerMarks = match && match.rule.ignore ? marks : this.parseAttributes(elt, marks)
      if (innerMarks) this.parseChildren(elt, innerMarks, endOfSlice)
      if (sync) this.sync(top)
    } else {
      let innerMarks = this.parseAttributes(elt, marks)
      if (innerMarks && match.rule.marksFrom) {
        let inner = elt.querySelector(match.rule.marksFrom)
        if (inner) innerMarks = this.parseAttributes(inner, innerMarks)
      }
      if (innerMarks)
        this.parseElementByRule(elt, match, innerMarks, endOfSlice)
    }
  }

  parseElementByRule(elt: Element, match: {rule: parse.Rule.Element<unknown>, value?: unknown},
                     marks: readonly Mark[], endOfSlice: boolean) {
    let sync, isLeaf = false, {rule} = match, hasValue = Object.prototype.hasOwnProperty.call(match, "value")
    if (rule.plot) {
      let plot = rule.plot instanceof Plot.Tag ? rule.plot :
        rule.plot instanceof Plot.Type ? (hasValue ? rule.plot.of(match.value) : rule.plot.default) : null
      if (!plot) throw new Error(`Parse rule for ${rule.selector} is missing a parameter`)
      let innerMarks = this.enter(plot, marks, endOfSlice, elt)
      if (innerMarks) {
        sync = true
        marks = innerMarks
      }
    } else if (rule.leaf) {
      let leaf = rule.leaf instanceof Leaf ? rule.leaf :
        rule.leaf instanceof Leaf.Type ? (hasValue ? rule.leaf.of(match.value) : rule.leaf.default) : null
      if (!leaf) throw new Error(`Parse rule for ${rule.selector} is missing a parameter`)
      this.insertNode(leaf, marks)
      isLeaf = true
    } else {
      let mark = rule.mark instanceof Mark ? rule.mark :
        rule.mark instanceof Mark.Type ? (hasValue ? rule.mark.of(match.value) : rule.mark.default) : null
      if (!mark) throw new Error(`Parse rule for ${rule.selector} does not produce a mark`)
      marks = marks.concat(mark)
    }
    let startIn = this.top

    if (!isLeaf) {
      let content = elt
      if (typeof rule.contentElement == "string") content = elt.querySelector(rule.contentElement) || elt
      else if (typeof rule.contentElement == "function") content = rule.contentElement(elt)
      this.parseChildren(content, marks, endOfSlice, rule.ignoreContent)
    }
    if (sync && this.sync(startIn)) this.close()
  }

  parseTextNode(dom: Text, marks: readonly Mark[]) {
    let text = dom.nodeValue!
    if (!this.top.tag.type.preserveWhitespace && this.options.collapseWhiteSpace !== false) {
      // Ignore entirely blank node
      if (!this.top.tag.inlineContent && !/[^ \t\r\n\u000c]/.test(text)) return
      // Collapse spans of whitespace into a single space
      text = text.replace(/[ \t\r\n\u000c]+/g, " ")
      // If this starts with whitespace, and there is no node before it,
      // or a line break, or a text node that ends with whitespace,
      // strip the leading space.
      if (/^ /.test(text)) {
        let nodeBefore = this.top.children[this.top.children.length - 1]
        if (nodeBefore
            ? nodeBefore == this.schema.lineBreak || nodeBefore.is(Leaf.Text) && / $/.test(nodeBefore.param!)
            : !(this.top.flags & CxFlag.OpenStart))
          text = text.slice(1)
      }
      if (text) this.insertNode(Leaf.text(text), marks)
    } else if (this.top.tag.type.preserveWhitespace && this.schema.lineBreak) {
      let lines = text.split(/\r?\n|\r/g)
      for (let i = 0; i < lines.length; i++) {
        if (i) this.insertNode(this.schema.lineBreak, marks)
        if (lines[i]) this.insertNode(Leaf.text(lines[i]), marks)
      }
    } else {
      text = text.replace(/\r?\n|\r/g, " ")
      if (text) this.insertNode(Leaf.text(text), marks)
    }
  }

  parseAttributes(elt: Element, marks: readonly Mark[]) {
    let matched = new Set<string>(), style = (elt as HTMLElement).style, hasStyles = style && style.length > 0
    for (let rule of this.rules.attributeRules) if (!matched.has(rule.attribute)) {
      let isStyle = /^style\//.test(rule.attribute)
      let value = !isStyle ? elt.getAttribute(rule.attribute) :
        hasStyles ? style.getPropertyValue(rule.attribute.slice(6)) : ""
      if (!value) continue
      let hasParam = Object.prototype.hasOwnProperty.call(rule, "param"), param = rule.param
      if (rule.readAttribute) {
        param = rule.readAttribute(value)
        hasParam = true
        if (param == parse.Rule.Reject) continue
      } else if (rule.value != null && rule.value != value) {
        continue
      }
      if (rule.ignore) return null
      if (rule.consuming !== false) matched.add(rule.attribute)
      if (rule.clearMark) {
        marks = marks.filter(p => !rule.clearMark!(p))
      } else {
        let mark = rule.mark instanceof Mark ? rule.mark :
          rule.mark instanceof Mark.Type ? (hasParam ? rule.mark.of(param) : rule.mark.default) : null
        if (!mark) throw new Error(`Parse rule for ${rule.attribute} does not produce a mark (or have ignore/clearMark properties)`)
        marks = marks.concat(mark)
      }
    }
    return marks
  }

  insertNode(node: Node, marks: readonly Mark[]) {
    let innerMarks = this.findPlace(node.tag, marks, false)
    if (innerMarks) {
      let top = this.top
      for (let p of innerMarks) if (this.schema.markAllowed(p.type, node.type)) node = node.withMarks(p.addToSet(node.marks))
      for (let p of node.tag.marks) node = node.withMarks(p.addToSet(node.marks))
      node.pushTo(top.children)
      return true
    }
    return false
  }

  // Try to find a way to fit the given node type into the current
  // context. May add intermediate wrappers and/or leave non-solid
  // nodes that we're in. Returns null if no place could be created, a
  // set of mark values not applied to wrappers otherwise.
  findPlace(tag: Node.Tag, marks: readonly Mark[], endOfSlice: boolean): readonly Mark[] | null {
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
      marks = this.enterInner(route[i], marks, endOfSlice, null)
    return marks
  }

  enter(tag: Plot.Tag.Any, marks: readonly Mark[], endOfSlice: boolean, elt: Element) {
    let innerMarks = this.findPlace(tag, marks, endOfSlice)
    if (innerMarks) innerMarks = this.enterInner(tag, marks, endOfSlice, elt)
    return innerMarks
  }

  // Open a node of the given type. Return the set of marks not
  // assigned to that node.
  enterInner(tag: Plot.Tag.Any, marks: readonly Mark[], endOfSlice: boolean, element: Element | null) {
    marks = marks.filter(p => {
      if (!this.schema.markAllowed(p.type, tag.type)) return true
      tag = tag.withMarks(p.addToSet(tag.marks))
      return false
    })
    let test, open = (this.top.children.length ? 0 : this.top.flags & CxFlag.OpenStart) |
      (endOfSlice ? this.top.flags & CxFlag.OpenEnd : 0)
    if ((open && element && this.options.isOpen) && (test = this.options.isOpen(element))) {
      open &= ~(CxFlag.OpenStart | CxFlag.OpenEnd)
      if (test == "start") open |= CxFlag.OpenStart
      else if (test == "end") open |= CxFlag.OpenEnd
      else if (test == "start end") open |= CxFlag.OpenStart | CxFlag.OpenEnd
    }
    this.top = new NodeContext(tag, (element ? CxFlag.Solid : CxFlag.None) | open, this.top)
    return marks
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
      let last = cx.children[cx.children.length - 1].tag, m
      if (last.is(Leaf.Text) && (m = /[ \t\r\n\u000c]+$/.exec(last.param))) {
        let len = last.length - m[0].length
        if (!len) cx.children.pop()
        else cx.children[cx.children.length - 1] = last.sliceText(0, len)
      }
    }
    let open = cx.flags & (CxFlag.OpenEnd | CxFlag.OpenStart)
    if (!open && !cx.tag.type.canBeEmpty && cx.tag.isPlot && !cx.children.length)
      cx.children.push(this.schema.createDefault(cx.tag.type))
    let node = cx.tag.isDoc ? this.schema.doc(cx.children) : cx.tag.create(cx.children)
    if (open) this.open.set(node, open)
    return node
  }
}

class NodeContext {
  children: Node[] = []

  constructor(readonly tag: Plot.Tag.Any,
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
function normalizeList(dom: Element) {
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

const normalizers: Record<string, (dom: Element) => void> = {ol: normalizeList, ul: normalizeList}
  
const ignoreTags = new Set(["head", "noscript", "object", "script", "style", "title"])

const blockTags = new Set(["address", "article", "aside", "blockquote", "canvas", "dd", "div", "dl",
                           "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
                           "h6", "header", "hgroup", "hr", "li", "noscript", "ol", "output", "p", "pre",
                           "section", "table", "tfoot", "ul"])

function guessParent(content: DocumentFragment | Element, schema: Schema) {
  let rules = parse.Rule.Set.fromSchema(schema)
  let tags: Node.Type<any>[] = []
  let explore = (node: DOMNode) => {
    if (node.nodeType == 3) {
      tags.push(Leaf.Text)
    } else if (node.nodeType == 1) {
      let match = rules.matchElement(node as Element)
      if (match && match.rule.leaf) {
        tags.push(match.rule.leaf instanceof Leaf ? match.rule.leaf.type : match.rule.leaf)
      } else if (match && match.rule.plot) {
        tags.push(match.rule.plot instanceof Plot.Tag ? match.rule.plot.type : match.rule.plot)
      } else if (!(match && match.rule.ignore)) {
        for (let ch = node.firstChild; ch; ch = ch.nextSibling) explore(ch)
      }
    }
  }
  explore(content)
  let best: Plot.Tag.Any | undefined, bestCost = 0
  for (let parent of schema.tags) if (parent.isPlot && parent.default) {
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
