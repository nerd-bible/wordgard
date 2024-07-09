import {Slice, OpenToken, Token, CloseToken} from "./slice"
import {Schema, SchemaElement} from "./schema"
import {Context} from "./context"
import {ElementRepresentation, AttributeRepresentation, StyleRepresentation} from "./to_dom"

export const enum TokenType { Open, Close, Node }

export type Params = {[name: string]: any}

const enum NodeFlag {
  None = 0,
  Inline = 1,
  InlineContent = 2,
  Text = 4,
  Leaf = 8,
  Doc = 16,
}

export const none: readonly any[] = []
const noParams: Params = Object.create(null)

export type NodeSpec<Params extends {}> = {
  params?: {[name in keyof Params]: ParamSpec<Params[name]>}
  content?: string
  group?: string
  toText?: (node: Node) => string
  dom: ElementRepresentation<Params>
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

export class NodeType<Params extends {} = {}> {
  params: readonly Param<any>[]
  private groups: readonly string[]
  private contentGroups: readonly string[]
  private childCache: Map<NodeType, boolean> = new Map
  defaultParams: Params | null
  flags: NodeFlag

  constructor(
    readonly name: string,
    flags: NodeFlag,
    readonly spec: NodeSpec<Params>
  ) {
    this.flags = flags | (spec.content ? NodeFlag.None : NodeFlag.Leaf)
    let params: Param<any>[] = this.params = []
    let defaultParams: Params | null = Object.create(null)
    if (spec.params) for (let name in spec.params) {
      let param = new Param(name, spec.params[name])
      params.push(param)
      if (defaultParams) {
        if (param.hasDefault) defaultParams[name] = param.default as any
        else defaultParams = null
      }
    }
    this.defaultParams = defaultParams
    let groups = this.groups = [name]
    if (flags & NodeFlag.Inline) groups.push("Inline")
    if (spec.group) for (let g of splitGroups(spec.group)) groups.push(g)
    this.contentGroups = spec.content ? splitGroups(spec.content) : none
  }

  static block<Params extends {}>(name: string, spec: NodeSpec<Params>) {
    checkReserved(name)
    return new NodeType<Params>(name, NodeFlag.None, spec)
  }

  static textblock<Params extends {}>(name: string, spec: NodeSpec<Params>) {
    checkReserved(name)
    return new NodeType<Params>(name, NodeFlag.InlineContent, spec)
  }

  static inline<Params extends {}>(name: string, spec: NodeSpec<Params>) {
    checkReserved(name)
    return new NodeType<Params>(name, NodeFlag.Inline | (spec.content ? NodeFlag.InlineContent : NodeFlag.None), spec)
  }

  static inlineblock<Params extends {}>(name: string, spec: NodeSpec<Params>) {
    checkReserved(name)
    return new NodeType<Params>(name, NodeFlag.Inline, spec)
  }

  static doc(content: string, inlineContent = false) {
    return new NodeType("Doc", NodeFlag.Doc | (inlineContent ? NodeFlag.InlineContent : NodeFlag.None), {content, tag: ""})
  }

  get schemaElement(): SchemaElement { return this }

  // FIXME should this join text nodes?
  create(params: Partial<Params>, children?: readonly Node[]): Node
  create(children?: readonly Node[]): Node
  create(paramsOrChildren?: Partial<Params> | readonly Node[], children?: readonly Node[]): Node {
    if (this.isDoc()) throw new Error("Document nodes must be created with schema.doc()")
    if (this.isText()) throw new Error("Text nodes must be created with Node.text()")
    let params = this.defaultParams
    if (paramsOrChildren) {
      if (Array.isArray(paramsOrChildren)) children = paramsOrChildren
      else if (paramsOrChildren instanceof Node) children = [paramsOrChildren]
      else params = fillParams(this.params, paramsOrChildren as Partial<Params>)
    }
    if (!params) throw new Error(`Must specify params when creating a node with some params that have no default value`)
    return new Node(this, params, none, this.checkChildren(children || none))
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

  checkMarks(marks: readonly Mark[]) {
    for (let mark of marks) if (!mark.type.canTarget(this))
      throw new Error(`Mark ${mark.name} cannot be applied to node ${this.name}`)
    return marks
  }

  isInline() { return (this.flags & NodeFlag.Inline) > 0 }
  isText() { return (this.flags & NodeFlag.Text) > 0 }
  isBlock() { return (this.flags & NodeFlag.Inline) == 0 }
  inlineContent() { return (this.flags & NodeFlag.InlineContent) > 0 }
  isTextblock() { return this.isBlock() && this.inlineContent() }
  isLeaf() { return (this.flags & NodeFlag.Leaf) > 0 }
  isDoc() { return (this.flags & NodeFlag.Doc) > 0 }

  getParam<Name extends keyof Params>(param: Name, node: Node): Params[Name] {
    if (node.type != this) throw new Error(`Accessing param on the wrong type of node`)
    return node.params[param as any]
  }
}

function checkReserved(name: string) {
  if (name == "Inline" || name == "Block" || name == "Text" || name == "Doc")
    throw new Error(`Node name ${name} is reserved`)
}

function fillParams<Params extends {}>(params: readonly Param<any>[], input: Partial<Params>): Params {
  let result: Params = Object.create(null)
  for (let param of params) {
    let name = param.name as keyof Params
    if (param.name in input) result[name] = input[name]!
    else if (param.hasDefault) result[name] = param.default
    else throw new Error(`Must provide param ${param.name}, which has no default value`)
  }
  return result
}

export class Node {
  contentLength: number

  constructor(
    readonly type: NodeType,
    readonly params: Params,
    readonly marks: readonly Mark[],
    readonly children: readonly Node[],
  ) {
    this.contentLength = children.reduce((s, c) => s + c.length, 0)
  }

  get name() { return this.type.name }

  get length() { return this.isLeaf() ? 1 : 2 + this.contentLength }

  mark(marks: readonly Mark[]) {
    return marks == this.marks ? this : new Node(this.type, this.params, this.type.checkMarks(marks), this.children)
  }

  sameMarkup(other: Node) {
    return this.type == other.type &&
      compareParams(this.type.params, this.params, other.params) &&
      eqArray(this.marks, other.marks)
  }

  eq(other: Node): boolean {
    return this == other || this.sameMarkup(other) && eqArray(this.children, other.children)
  }

  copy(children: readonly Node[]) {
    return new Node(this.type, this.params, this.marks, this.type.checkChildren(children))
  }

  slice(from: number, to = this.length) {
    if (from == to) return Slice.empty
    let content: Token[] = []
    this.sliceNode(content, from, to)
    return new Slice(content)
  }

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

  toString() {
    return marksToString(this.marks, this.name + (this.isLeaf() ? `` : `(${this.children.join()})`))
  }

  toJSON(): NodeJSON {
    let result: NodeJSON = {type: this.name}
    if (this.marks.length) result.marks = this.marks.map(m => m.toJSON())
    if (this.params != this.type.defaultParams) result.params = this.params
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

  get tokenType(): TokenType.Node { return TokenType.Node }

  static text(text: string, marks: readonly Mark[] = none) {
    return new TextNode(text, marks)
  }
}

export type NodeJSON = {
  type: string,
  marks?: readonly MarkJSON[],
  params?: any,
  text?: string,
  children?: readonly NodeJSON[]
}

export type MarkJSON = {
  type: string,
  params?: any
}

export class DocNode extends Node {
  constructor(type: NodeType, children: readonly Node[], readonly schema: Schema) {
    super(type, noParams, none, children)
  }

  get length() { return this.contentLength }

  copy(children: readonly Node[]) {
    return new DocNode(this.type, this.type.checkChildren(children), this.schema)
  }

  mark(marks: readonly Mark[]) {
    if (marks.length) throw new Error("Document nodes cannot have marks")
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

export const Text = new NodeType("Text", NodeFlag.Text | NodeFlag.Inline, {tag: ""})

export class TextNode extends Node {
  constructor(readonly text: string, marks: readonly Mark[]) {
    super(Text, noParams, marks, none)
    this.type.checkMarks(marks)
    if (!text.length) throw new Error("Text nodes must not be empty")
  }

  get length() { return this.text.length }

  withText(text: string) {
    return text == this.text ? this : new TextNode(text, this.marks)
  }

  mark(marks: readonly Mark[]) {
    return marks == this.marks ? this : new TextNode(this.text, marks)
  }

  sliceNode(content: Token[], from: number, to: number) {
    content.push(this.cut(from, to))
  }

  cut(from: number, to = this.length) {
    return !from && to == this.length ? this : new TextNode(this.text.slice(Math.max(from, 0), Math.max(0, to)), this.marks)
  }

  eq(other: Node) {
    return super.eq(other) && this.text == (other as TextNode).text
  }

  toString() { return marksToString(this.marks, JSON.stringify(this.text)) }
}

function marksToString(marks: readonly Mark[], inner: string) {
  for (let i = marks.length - 1; i >= 0; i--)
    inner = marks[i].name + "(" + inner + ")"
  return inner
}

export type ParamSpec<T> = {
  default?: T
  compare?: (a: T, b: T) => boolean
  attribute?: string
}

export class Param<T = any> {
  hasDefault: boolean
  default: T

  constructor(readonly name: string, readonly spec: ParamSpec<T>) {
    this.hasDefault = "default" in spec
    this.default = spec.default!
  }
}

function compareParamValue(a: any, b: any) {
  if (a === b) return true
  if (!a || !b || typeof a != "object" || typeof b != "object") return false
  let array = Array.isArray(a)
  if (Array.isArray(b) != array) return false
  if (array) {
    if (a.length != b.length) return false
    for (let i = 0; i < a.length; i++) if (!compareParamValue(a[i], b[i])) return false
  } else {
    for (let p in a) if (!(p in b) || !compareParamValue(a[p], b[p])) return false
    for (let p in b) if (!(p in a)) return false
  }
  return true
}

function compareParams(params: readonly Param[], a: Params, b: Params) {
  for (let param of params) if (!compareParamValue(a[param.name], b[param.name])) return false
  return true
}

export function eqArray<T extends {eq: (other: T) => boolean}>(a: readonly T[], b: readonly T[]) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

export type MarkSpec<Params extends {}> = {
  params?: {[name in keyof Params]: ParamSpec<Params[name]>}
  group?: string
  nodes?: string
  excludes?: string
  rank: number
  spanning?: boolean
  dom: ElementRepresentation<Params> | AttributeRepresentation<Params> | StyleRepresentation<Params>
}

export class MarkType<Params extends {} = {}> {
  params: readonly Param<any>[]
  defaultInstance: Mark | null
  groups: readonly string[]
  targetGroups: readonly string[]
  excludedGroups: readonly string[]
  rank: number

  private constructor(
    readonly name: string,
    readonly spec: MarkSpec<Params>
  ) {
    this.groups = (spec.group ? splitGroups(spec.group) : none).concat(name, "_")
    this.targetGroups = spec.nodes == null ? ["Inline"] : splitGroups(spec.nodes)
    this.excludedGroups = spec.excludes == null ? [name] : splitGroups(spec.excludes)
    this.rank = spec.rank
    let params: Param<any>[] = this.params = []
    let defaultParams: Params | null = Object.create(null)
    if (spec.params) for (let name in spec.params) {
      let param = new Param(name, spec.params[name])
      params.push(param)
      if (defaultParams) {
        if (param.hasDefault) defaultParams[name] = param.default as any
        else defaultParams = null
      }
    }
    this.defaultInstance = defaultParams ? new Mark(this, defaultParams) : null
  }

  get schemaElement(): SchemaElement { return this }

  create(params?: Partial<Params>) {
    if (!params) {
      if (this.defaultInstance) return this.defaultInstance
      params = {}
    }
    return new Mark(this, fillParams(this.params, params))
  }

  isInGroup(group: string) {
    return this.groups.includes(group)
  }

  canTarget(node: NodeType) {
    return this.targetGroups.some(g => node.isInGroup(g))
  }

  excludes(other: MarkType) {
    return this.excludedGroups.some(g => other.isInGroup(g))
  }

  getParam<Name extends keyof Params>(param: Name, mark: Mark): Params[Name] {
    if (mark.type != this) throw new Error(`Accessing param on the wrong type of mark`)
    return mark.params[param as any]
  }

  compareRank(other: MarkType) {
    return this.rank - other.rank || (other.name < this.name ? 1 : -1)
  }

  removeFromSet(set: readonly Mark[]): readonly Mark[] {
    for (var i = 0; i < set.length; i++) if (set[i].type == this) set = remove(set, i--)
    return set
  }

  isInSet(set: readonly Mark[]): Mark | undefined {
    for (let i = 0; i < set.length; i++)
      if (set[i].type == this) return set[i]
  }

  static define<Params extends {}>(name: string, spec: MarkSpec<Params>) {
    return new MarkType<Params>(name, spec)
  }
}

export class Mark {
  constructor(
    readonly type: MarkType,
    readonly params: Params
  ) {}

  get name() {
    return this.type.name
  }

  eq(other: Mark) {
    return this.type == other.type && compareParams(this.type.params, this.params, other.params)
  }

  toJSON(): MarkJSON {
    let result: MarkJSON = {type: this.name}
    if (this != this.type.defaultInstance) result.params = this.params
    return result
  }

  addToSet(set: readonly Mark[]) {
    let placed = null, copy: Mark[] = []
    for (let i = 0; i < set.length; i++) {
      let other = set[i]
      if (this.eq(other)) return set
      if (this.type.excludes(other.type)) {
        // Skip
      } else if (other.type.excludes(this.type)) {
        return set
      } else {
        if (!placed && this.type.compareRank(other.type) < 0) copy.push(placed = this)
        copy.push(other)
      }
    }
    if (!placed) copy.push(this)
    return copy
  }

  removeFromSet(set: readonly Mark[]): readonly Mark[] {
    for (var i = 0; i < set.length; i++) if (set[i].eq(this)) return remove(set, i)
    return set
  }

  isInSet(set: readonly Mark[]) {
    return set.some(m => m.eq(this))
  }

  static sameSet(a: readonly Mark[], b: readonly Mark[]) {
    return eqArray(a, b)
  }
}
