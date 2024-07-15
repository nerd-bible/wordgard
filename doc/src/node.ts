import {Slice, OpenToken, Token, CloseToken} from "./slice"
import {Schema, SchemaElement} from "./schema"
import {Context} from "./context"
import {ElementRepresentation, AttributeRepresentation, StyleRepresentation} from "./to_dom"

export const enum TokenType { Open, Close, Node }

const enum NodeFlag {
  None = 0,
  Inline = 1,
  InlineContent = 2,
  Text = 4,
  Leaf = 8,
  Doc = 16,
}

export const none: readonly any[] = []

export type NodeSpec<Props extends {}> = {
  props?: {[name in keyof Props]: PropSpec<Props[name]>}
  content?: string
  group?: string
  toText?: (node: Node) => string
  dom: ElementRepresentation
}

function splitGroups(groups: string) {
  let result = []
  for (let pos = 0; pos < groups.length;) {
    let space = groups.indexOf(" ", pos)
    if (space < 0) space = groups.length
    if (space > pos) result.push(groups.slice(pos, space))
    pos = space + 1
  }
  return result
}

function remove<T>(arr: readonly T[], index: number) {
  return arr.length == 1 ? none : arr.filter((_, i) => i != index)
}

export class NodeType<Props extends {} = {}> {
  props: {[name in keyof Props]: Prop<Props[name]>}
  private groups: readonly string[]
  private contentGroups: readonly string[]
  private childCache: Map<NodeType, boolean> = new Map
  readonly requiredProps: Prop<any>[] = []
  flags: NodeFlag

  constructor(
    readonly name: string,
    flags: NodeFlag,
    readonly spec: NodeSpec<Props>
  ) {
    this.flags = flags | (spec.content ? NodeFlag.None : NodeFlag.Leaf)
    this.props = Object.create(null)
    if (spec.props) for (let propName in spec.props) {
      let prop = new Prop(name + "/" + propName, {...spec.props[propName], nodes: name}, true)
      this.props[propName] = prop as any
      if (prop.isRequired()) this.requiredProps.push(prop)
    }
    let groups = this.groups = [name]
    if (flags & NodeFlag.Inline) groups.push("Inline")
    if (spec.group) for (let g of splitGroups(spec.group)) groups.push(g)
    this.contentGroups = spec.content ? splitGroups(spec.content) : none
  }

  static block<Props extends {}>(name: string, spec: NodeSpec<Props>) {
    checkReserved(name)
    return new NodeType<Props>(name, NodeFlag.None, spec)
  }

  static textblock<Props extends {}>(name: string, spec: NodeSpec<Props>) {
    checkReserved(name)
    return new NodeType<Props>(name, NodeFlag.InlineContent, spec)
  }

  static inline<Props extends {}>(name: string, spec: NodeSpec<Props>) {
    checkReserved(name)
    return new NodeType<Props>(name, NodeFlag.Inline | (spec.content ? NodeFlag.InlineContent : NodeFlag.None), spec)
  }

  static inlineblock<Props extends {}>(name: string, spec: NodeSpec<Props>) {
    checkReserved(name)
    return new NodeType<Props>(name, NodeFlag.Inline, spec)
  }

  static doc(content: string, inlineContent = false) {
    return new NodeType("Doc", NodeFlag.Doc | (inlineContent ? NodeFlag.InlineContent : NodeFlag.None), {content} as any as NodeSpec<{}>)
  }

  get schemaElement(): SchemaElement { return this }

  // FIXME should this join text nodes?
  create(props: PropSet, children?: readonly Node[]): Node
  create(children?: readonly Node[]): Node
  create(propsOrChildren?: PropSet | readonly Node[], children?: readonly Node[]): Node {
    if (this.isDoc()) throw new Error("Document nodes must be created with schema.doc()")
    if (this.isText()) throw new Error("Text nodes must be created with Node.text()")
    let props = PropSet.empty
    if (propsOrChildren) {
      if (Array.isArray(propsOrChildren)) children = propsOrChildren
      else if (propsOrChildren instanceof Node) children = [propsOrChildren]
      else props = propsOrChildren as PropSet
    }
    return new Node(this, this.checkProps(props), this.checkChildren(children || none))
  }

  createWith(props: Partial<Props>, children: readonly Node[] = none): Node {
    let set = PropSet.empty
    for (let name in props) {
      let prop = this.props[name]
      set = set.add(prop.of(props[name]!))
    }
    return this.create(set, children)
  }

  isInGroup(group: string) {
    return group == "_" || this.groups.includes(group)
  }

  canContain(child: NodeType) {
    let result = this.childCache.get(child)
    if (result == null) {
      result = (child.flags & NodeFlag.Doc) ? false : this.contentGroups.some(g => child.isInGroup(g))
      this.childCache.set(child, result)
    }
    return result
  }

  sharesContent(other: NodeType) {
    return other.contentGroups.some(g => this.contentGroups.includes(g))
  }

  checkChildren(children: readonly Node[]) {
    for (let child of children)
      if (!this.canContain(child.type))
        throw new Error(`${child.name} is not a valid child of ${this.name}`)
    return children
  }

  checkProps(props: PropSet) {
    for (let prop of props.set) if (!prop.prop.canTarget(this))
      throw new Error(`Prop ${prop.name} cannot be applied to node ${this.name}`)
    for (let prop of this.requiredProps) if (!props.has(prop))
      throw new Error(`Required prop ${prop.name} missing`)
    return props
  }

  isInline() { return (this.flags & NodeFlag.Inline) > 0 }
  isText() { return (this.flags & NodeFlag.Text) > 0 }
  isBlock() { return (this.flags & NodeFlag.Inline) == 0 }
  inlineContent() { return (this.flags & NodeFlag.InlineContent) > 0 }
  isTextblock() { return this.isBlock() && this.inlineContent() }
  isLeaf() { return (this.flags & NodeFlag.Leaf) > 0 }
  isDoc() { return (this.flags & NodeFlag.Doc) > 0 }
}

function checkReserved(name: string) {
  if (name == "Inline" || name == "Block" || name == "Text" || name == "Doc")
    throw new Error(`Node name ${name} is reserved`)
}

export class Node {
  contentLength: number

  constructor(
    readonly type: NodeType,
    readonly props: PropSet,
    readonly children: readonly Node[],
  ) {
    this.contentLength = children.reduce((s, c) => s + c.length, 0)
  }

  get name() { return this.type.name }

  get length() { return this.isLeaf() ? 1 : 2 + this.contentLength }

  withProps(props: PropSet) {
    return props.eq(this.props) ? this : new Node(this.type, this.type.checkProps(props), this.children)
  }

  sameMarkup(other: Node) {
    return this.type == other.type && this.props.eq(other.props)
  }

  eq(other: Node): boolean {
    return this == other || this.sameMarkup(other) && eqArray(this.children, other.children)
  }

  copy(children: readonly Node[]) {
    return new Node(this.type, this.props, this.type.checkChildren(children))
  }

  slice(from: number, to = this.length) {
    if (from == to) return Slice.empty
    let content: Token[] = []
    this.sliceNode(content, from, to)
    return new Slice(content)
  }

  /// @internal
  sliceNode(content: Token[], from: number, to: number) {
    if (from <= 0) {
      if (to >= this.length) {
        content.push(this)
        return
      }
      content.push(new OpenToken(this.copy(none)))
    }
    sliceContent(content, this.children, from - 1, to - 1)
    if (to >= this.length) content.push(CloseToken)
  }

  isInline() { return this.type.isInline() }
  isText(): this is TextNode { return this.type.isText() }
  isBlock() { return this.type.isBlock() }
  inlineContent() { return this.type.inlineContent() }
  isTextblock() { return this.type.isTextblock() }
  isLeaf() { return this.type.isLeaf() }
  isDoc() { return this.type.isDoc() }

  iterate(from: number, to: number, f: (node: Node, pos: number) => boolean | void) {
    if (f(this, 0) !== false)
      this.iterInner(0, from, to, f)
  }

  nodeAt(pos: number): Node | null {
    for (let child of this.children) {
      if (pos == 0) return child
      if (pos < child.length) return child.nodeAt(pos - 1)
      pos -= child.length
    }
    return null
  }

  /// @internal
  iterInner(contentStart: number, from: number, to: number, f: (node: Node, pos: number) => boolean | void) {
    for (let pos = contentStart, i = 0; i < this.children.length; i++) {
      if (pos >= to) break
      let child = this.children[i], start = pos
      pos += child.length
      if (pos <= from) continue
      if (f(child, start) !== false) child.iterInner(start + 1, from, to, f)
    }
  }

  /// @internal
  toString() {
    return propsToString(this.props, this.name + (this.isLeaf() ? `` : `(${this.children.join()})`))
  }

  toJSON(): NodeJSON {
    let result: NodeJSON = {type: this.name}
    if (!this.props.empty) {
      result.props = Object.create(null)
      for (let {name, value} of this.props.set) result.props![name] = value
    }
    if (this.isText()) result.text = this.text
    if (this.children.length) result.children = this.children.map(c => c.toJSON())
    return result
  }

  textContent(options: {
    from?: number, to?: number,
    blockSeparator?: string,
    leafText?: string | ((node: Node) => string)
  } = {}) {
    let {from = 0, to = this.length, blockSeparator = "\n", leafText} = options
    let text = "", first = true
    this.iterate(from, to, (node, pos) => {
      let nodeText = node.isText() ? node.text.slice(Math.max(0, from - pos), Math.min(node.length, to - pos))
        : !node.isLeaf() ? ""
        : leafText ? (typeof leafText === "function" ? leafText(node) : leafText)
        : node.type.spec.toText ? node.type.spec.toText(node)
        : ""
      if (node.isBlock() && (node.isLeaf() && nodeText || node.isTextblock())) {
        if (first) first = false
        else text += blockSeparator
      }
      text += nodeText
    })
    return text
  }

  prop<Value>(prop: Prop<Value>, required: true): Value
  prop<Value>(prop: Prop<Value>): Value | undefined
  prop<Value>(prop: Prop<Value>, required = false): Value | undefined {
    return (this.props.get as any)(prop, required)
  }

  get tokenType(): TokenType.Node { return TokenType.Node }

  static text(text: string, props: PropSet = PropSet.empty) {
    return new TextNode(text, Text.checkProps(props))
  }
}

export type NodeJSON = {
  type: string,
  props?: {[name: string]: any}
  text?: string,
  children?: readonly NodeJSON[]
}

export type MarkJSON = {
  type: string,
  params?: any
}

export class DocNode extends Node {
  constructor(type: NodeType, children: readonly Node[], readonly schema: Schema) {
    super(type, PropSet.empty, children)
  }

  get length() { return this.contentLength }

  copy(children: readonly Node[]) {
    return new DocNode(this.type, this.type.checkChildren(children), this.schema)
  }

  withProps(props: PropSet) {
    if (props.empty) throw new Error("Document nodes cannot have props")
    return this
  }

  sliceNode(content: Token[], from: number, to: number) {
    sliceContent(content, this.children, from, to)
  }

  resolve(pos: number) {
    return Context.resolve(this, pos)
  }
}

function sliceContent(content: Token[], nodes: readonly Node[], from: number, to: number) {
  let off = 0
  for (let child of nodes) {
    if (off >= to) break
    let start = off
    off += child.length
    if (off <= from) continue
    child.sliceNode(content, from - start, to - start)
  }
}

export const Text = new NodeType("Text", NodeFlag.Text | NodeFlag.Inline, {dom: {tag: ""}})

export class TextNode extends Node {
  constructor(readonly text: string, props: PropSet) {
    if (!text.length) throw new Error("Text nodes must not be empty")
    super(Text, props, none)
  }

  get length() { return this.text.length }

  withText(text: string) {
    return text == this.text ? this : new TextNode(text, this.props)
  }

  withProps(props: PropSet) {
    return props.eq(this.props) ? this : new TextNode(this.text, props)
  }

  sliceNode(content: Token[], from: number, to: number) {
    content.push(this.cut(from, to))
  }

  cut(from: number, to = this.length) {
    return !from && to == this.length ? this : new TextNode(this.text.slice(Math.max(from, 0), Math.max(0, to)), this.props)
  }

  eq(other: Node) {
    return this.sameMarkup(other) && this.text == (other as TextNode).text
  }

  /// @internal
  toString() { return propsToString(this.props, JSON.stringify(this.text)) }
}

// FIXME show values? display differently?
function propsToString(props: PropSet, inner: string) {
  for (let i = props.set.length - 1; i >= 0; i--) {
    let {name} = props.set[i]
    if (name.indexOf("/") < 0) inner = name + "(" + inner + ")"
  }
  return inner
}

function compareDeep(a: any, b: any) {
  if (a === b) return true
  if (!a || !b || typeof a != "object" || typeof b != "object") return false
  let array = Array.isArray(a)
  if (Array.isArray(b) != array) return false
  if (array) {
    if (a.length != b.length) return false
    for (let i = 0; i < a.length; i++) if (!compareDeep(a[i], b[i])) return false
  } else {
    for (let p in a) if (!(p in b) || !compareDeep(a[p], b[p])) return false
    for (let p in b) if (!(p in a)) return false
  }
  return true
}

export function eqArray<T extends {eq: (other: T) => boolean}>(a: readonly T[], b: readonly T[]) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

export type PropSpec<Value> = {
  group?: string
  nodes?: string
  rank?: number
  spanning?: boolean
  required?: boolean
  multi?: Value extends ReadonlyArray<infer Content> ? {compare: (a: Content, b: Content) => number} : never
  dom: ElementRepresentation<Value> | AttributeRepresentation<Value> | StyleRepresentation<Value>
}

export function addMulti<T>(a: readonly T[], b: readonly T[], compare: (a: T, b: T) => number) {
  let result: T[] = []
  for (let i = 0, j = 0;;) {
    if (i == a.length) {
      if (j == b.length) return result
      result.push(b[j++])
    } else if (j == b.length) {
      result.push(a[i++])
    } else {
      let cmp = compare(a[i], b[j])
      if (cmp == 0) i++
      else if (cmp < 0) result.push(a[i++])
      else result.push(b[j++])
    }
  }
}

export function subMulti<T>(a: readonly T[], b: readonly T[], compare: (a: T, b: T) => number) {
  let result: T[] = []
  for (let i = 0, j = 0;;) {
    if (i == a.length) return result
    if (j == b.length) {
      result.push(a[i++])
    } else {
      let cmp = compare(a[i], b[j])
      if (cmp == 0) i++
      else if (cmp < 0) result.push(a[i++])
      else j++
    }
  }
}

export class Prop<Value> {
  readonly groups: readonly string[]
  readonly targetGroups: readonly string[]
  readonly rank: number
  readonly multi: null | ((a: any, b: any) => number)

  constructor(
    readonly name: string,
    readonly spec: PropSpec<Value>,
    readonly local: boolean
  ) {
    this.groups = (spec.group ? splitGroups(spec.group) : none).concat(name, "_")
    this.targetGroups = spec.nodes == null ? ["Inline"] : splitGroups(spec.nodes)
    this.rank = spec.rank ?? 100
    this.multi = spec.multi ? spec.multi.compare : null
    if (spec.required && !local) throw new Error("Only local props can be required")
  }

  of(value: Value) { return new PropValue(this, value) }

  get schemaElement(): SchemaElement { return this }

  isRequired() { return !!this.spec.required }

  isInGroup(group: string) {
    return this.groups.includes(group)
  }

  canTarget(node: NodeType) {
    return this.targetGroups.some(g => node.isInGroup(g))
  }

  compareRank(other: Prop<any>) {
    return this.rank - other.rank || (other.name < this.name ? 1 : -1)
  }

  static define<Value>(name: string, spec: PropSpec<Value>) {
    return new Prop<Value>(name, spec, false)
  }

  static flag(name: string, spec: PropSpec<null>): PropValue {
    return new Prop<null>(name, spec, false).of(null)
  }
}

export class PropValue<Value = any> {
  constructor(readonly prop: Prop<Value>, readonly value: Value) {}

  eq(other: PropValue) {
    return this.prop == other.prop && compareDeep(this.value, other.value)
  }

  get name() { return this.prop.name }

  toString() { return this.value == null ? this.name : `${this.name}=${JSON.stringify(this.value)}` }
}

export class PropSet {
  constructor(readonly set: readonly PropValue[]) {}

  eq(other: PropSet) {
    return this == other || eqArray(this.set, other.set)
  }

  add(prop: PropValue) {
    let placed = null, copy: PropValue[] = []
    for (let i = 0; i < this.set.length; i++) {
      let other = this.set[i]
      if (prop.eq(other)) return this
      if (other.prop != prop.prop) {
        if (!placed && prop.prop.compareRank(other.prop) < 0) copy.push(placed = prop)
        copy.push(other)
      } else if (prop.prop.multi) {
        copy.push(placed = new PropValue(prop.prop, addMulti(other.value, prop.value, prop.prop.multi)))
      }
    }
    if (!placed) copy.push(prop)
    return new PropSet(copy)
  }

  join(other: PropSet) {
    let result = this as PropSet
    for (let val of other.set) result = result.add(val)
    return result
  }

  remove(prop: Prop<any> | PropValue): PropSet {
    if (prop instanceof Prop) {
      for (var i = 0; i < this.set.length; i++) if (this.set[i].prop == prop)
        return this.set.length > 1 ? new PropSet(remove(this.set, i)) : PropSet.empty
    } else {
      let type = prop.prop
      for (var i = 0; i < this.set.length; i++) if (this.set[i].prop == type) {
        let val = this.set[i], set: readonly PropValue[]
        if (type.multi) {
          let rest = subMulti(val.value, prop.value, type.multi)
          if (!rest.length) {
            set = remove(this.set, i)
          } else {
            set = this.set.slice()
            ;(set as PropValue[])[i] = new PropValue(type, rest)
          }
        } else if (!val.eq(prop)) {
          continue
        } else {
          set = remove(this.set, i)
        }
        return set.length ? new PropSet(set) : PropSet.empty
      }
    }
    return this
  }

  has(prop: Prop<any> | PropValue): PropValue | null {
    if (prop instanceof Prop) {
      for (let v of this.set) if (v.prop == prop) return v
    } else {
      for (let v of this.set) if (v.eq(prop)) return v
    }
    return null
  }

  get<Value>(prop: Prop<Value>, required: true): Value
  get<Value>(prop: Prop<Value>): Value | undefined
  get<Value>(prop: Prop<Value>, required = false): Value | undefined {
    for (let v of this.set) if (v.prop == prop) return v.value
    if (required) throw new Error(`Missing required prop ${prop.name}`)
    return undefined
  }
  
  get empty() { return this.set.length == 0 }

  toString() { return "{" + this.set.join(",") + "}" }

  static empty = new PropSet(none)

  static of(props: readonly PropValue[]) {
    let result = PropSet.empty
    for (let prop of props) result = result.add(prop)
    return result
  }
}
