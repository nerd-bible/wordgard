import {Slice, OpenToken, Token, CloseToken} from "./slice"
import {SchemaElement} from "./schema"

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
const noAttrs: {[name: string]: any} = Object.create(null)

// FIXME find another word for 'Attr'? Param?

export type NodeSpec<Attrs extends {}> = {
  attrs?: {[name in keyof Attrs]: AttrSpec<Attrs[name]>}
  content?: string
  group?: string
  tag: string
  toText?: (node: Node) => string
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

export class NodeType<Attrs extends {} = {}> {
  attrs: readonly Attribute<any>[]
  private groups: readonly string[]
  private contentGroups: readonly string[]
  defaultAttrs: Attrs | null
  flags: NodeFlag

  constructor(
    readonly name: string,
    flags: NodeFlag,
    readonly spec: NodeSpec<Attrs>
  ) {
    this.flags = flags | (spec.content ? NodeFlag.None : NodeFlag.Leaf)
    let attrs: Attribute<any>[] = this.attrs = []
    let defaultAttrs: Attrs | null = Object.create(null)
    if (spec.attrs) for (let name in spec.attrs) {
      let attr = new Attribute(name, spec.attrs[name])
      attrs.push(attr)
      if (defaultAttrs) {
        if (attr.hasDefault) defaultAttrs[name] = attr.default as any
        else defaultAttrs = null
      }
    }
    this.defaultAttrs = defaultAttrs
    let groups = this.groups = [name, flags & NodeFlag.Inline ? "Inline" : "Block"]
    if (spec.group) for (let g of splitGroups(spec.group)) groups.push(g)
    this.contentGroups = spec.content ? splitGroups(spec.content) : none
  }

  static block<Attrs extends {}>(name: string, spec: NodeSpec<Attrs>) {
    checkReserved(name)
    return new NodeType<Attrs>(name, NodeFlag.None, spec)
  }

  static textblock<Attrs extends {}>(name: string, spec: NodeSpec<Attrs>) {
    checkReserved(name)
    return new NodeType<Attrs>(name, NodeFlag.InlineContent, spec)
  }

  static inline<Attrs extends {}>(name: string, spec: NodeSpec<Attrs>) {
    checkReserved(name)
    return new NodeType<Attrs>(name, NodeFlag.Inline | (spec.content ? NodeFlag.InlineContent : NodeFlag.None), spec)
  }

  static inlineblock<Attrs extends {}>(name: string, spec: NodeSpec<Attrs>) {
    checkReserved(name)
    return new NodeType<Attrs>(name, NodeFlag.Inline, spec)
  }

  static doc(content: string, inlineContent = false) {
    return new NodeType("Doc", NodeFlag.Doc | (inlineContent ? NodeFlag.InlineContent : NodeFlag.None), {content, tag: ""})
  }

  get schemaElement(): SchemaElement { return this }

  create(attrs: Partial<Attrs>, children?: readonly Node[]): Node
  create(children?: readonly Node[]): Node
  create(attrsOrChildren?: Partial<Attrs> | readonly Node[], children?: readonly Node[]): Node {
    if (this.isText()) throw new Error("Text nodes cannot be created with .create()")
    let attrs = this.defaultAttrs
    if (attrsOrChildren) {
      if (Array.isArray(attrsOrChildren)) children = attrsOrChildren
      else attrs = fillAttrs(this.attrs, attrsOrChildren as Partial<Attrs>)
    }
    if (!attrs) throw new Error(`Must specify attrs when creating a node with some attributes that have no default value`)
    if (this.flags & NodeFlag.Doc)
      return new DocNode(this, this.checkChildren(children || none))
    else
      return new Node(this, attrs, none, this.checkChildren(children || none))
  }

  isInGroup(group: string) {
    return this.groups.includes(group)
  }

  canBeChild(parent: NodeType) {
    return (this.flags & NodeFlag.Doc) ? false : parent.contentGroups.some(g => this.isInGroup(g))
  }

  checkChildren(children: readonly Node[]) {
    for (let child of children)
      if (!child.type.canBeChild(this))
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

  getAttr<Name extends keyof Attrs>(attr: Name, node: Node): Attrs[Name] {
    if (node.type != this) throw new Error(`Accessing attr on the wrong type of node`)
    return node.attrs[attr as any]
  }
}

function checkReserved(name: string) {
  if (name == "Inline" || name == "Block" || name == "Text" || name == "Doc")
    throw new Error(`Node name ${name} is reserved`)
}

function fillAttrs<Attrs extends {}>(attrs: readonly Attribute<any>[], input: Partial<Attrs>): Attrs {
  let result: Attrs = Object.create(null)
  for (let attr of attrs) {
    let name = attr.name as keyof Attrs
    if (attr.name in input) result[name] = input[name]!
    else if (attr.hasDefault) result[name] = attr.default
    else throw new Error(`Must provide attribute ${attr.name}, which has no default value`)
  }
  return result
}

export class Node {
  contentLength: number

  constructor(
    readonly type: NodeType,
    readonly attrs: {[name: string]: any},
    readonly marks: readonly Mark[],
    readonly children: readonly Node[],
  ) {
    this.contentLength = children.reduce((s, c) => s + c.length, 0)
  }

  get name() { return this.type.name }

  get length() { return this.isLeaf() ? 1 : 2 + this.contentLength }

  mark(marks: readonly Mark[]) {
    return marks == this.marks ? this : new Node(this.type, this.attrs, this.type.checkMarks(marks), this.children)
  }

  sameMarkup(other: Node) {
    return this.type == other.type &&
      compareAttrs(this.type.attrs, this.attrs, other.attrs) &&
      eqArray(this.marks, other.marks)
  }

  eq(other: Node): boolean {
    return this.sameMarkup(other) && eqArray(this.children, other.children)
  }

  copy(children: readonly Node[]) {
    return new Node(this.type, this.attrs, this.marks, this.type.checkChildren(children))
  }

  slice(from: number, to = this.length) {
    if (from == to) return Slice.empty
    let content: Token[] = []
    this.sliceNode(content, from, to)
    return new Slice(content)
  }

  sliceNode(content: Token[], from: number, to: number) {
    if (from == 0) {
      if (to == this.length) {
        content.push(this)
        return
      }
      content.push(new OpenToken(this.copy(none)))
    }
    sliceContent(content, this.children, from + 1, to - 1)
    if (to == this.length) content.push(CloseToken)
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
    if (this.attrs != this.type.defaultAttrs) result.attrs = this.attrs
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
  attrs?: any,
  text?: string,
  children?: readonly NodeJSON[]
}

export type MarkJSON = {
  type: string,
  attrs?: any
}

export class DocNode extends Node {
  constructor(type: NodeType, children: readonly Node[]) {
    super(type, noAttrs, none, children)
  }

  get length() { return this.contentLength }

  sliceNode(content: Token[], from: number, to: number) {
    sliceContent(content, this.children, from, to)
  }
}

function sliceContent(content: Token[], nodes: readonly Node[], from: number, to: number) {
  let off = 0
  for (let child of nodes) {
    if (off >= to) break
    let start = off
    off += child.length
    if (off <= from) continue
    child.sliceNode(content, Math.max(0, from - start), Math.min(child.length, to - start))
  }
}

export const Text = new NodeType("Text", NodeFlag.Text | NodeFlag.Inline, {tag: ""})

export class TextNode extends Node {
  constructor(readonly text: string, marks: readonly Mark[]) {
    super(Text, noAttrs, marks, none)
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
    return !from && to == this.length ? this : new TextNode(this.text.slice(from, to), this.marks)
  }

  toString() { return marksToString(this.marks, JSON.stringify(this.text)) }
}

function marksToString(marks: readonly Mark[], inner: string) {
  for (let i = marks.length - 1; i >= 0; i--)
    inner = marks[i].name + "(" + inner + ")"
  return inner
}

export type AttrSpec<T> = {
  default?: T
  compare?: (a: T, b: T) => boolean
  attribute: string
}

export class Attribute<T = any> {
  hasDefault: boolean
  default: T
  compare: (a: T, b: T) => boolean

  constructor(readonly name: string, readonly spec: AttrSpec<T>) {
    this.hasDefault = "default" in spec
    this.default = spec.default!
    this.compare = spec.compare || ((a, b) => a === b)
  }
}

function compareAttrs(attrs: readonly Attribute[], a: {[name: string]: any}, b: {[name: string]: any}) {
  for (let attr of attrs) if (!attr.compare(a[attr.name], b[attr.name])) return false
  return true
}

export function eqArray<T extends {eq: (other: T) => boolean}>(a: readonly T[], b: readonly T[]) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

export type MarkSpec<Attrs extends {}> = {
  attrs?: {[name in keyof Attrs]: AttrSpec<Attrs[name]>}
  group?: string
  nodes?: string
  excludes?: string
  rank: number
  tag: string
}

export class MarkType<Attrs extends {} = {}> {
  attrs: readonly Attribute<any>[]
  defaultInstance: Mark | null
  groups: readonly string[]
  targetGroups: readonly string[]
  excludedGroups: readonly string[]
  rank: number

  private constructor(
    readonly name: string,
    readonly spec: MarkSpec<Attrs>
  ) {
    this.groups = (spec.group ? splitGroups(spec.group) : none).concat(name)
    this.targetGroups = spec.nodes == null ? ["Inline"] : splitGroups(spec.nodes)
    this.excludedGroups = spec.excludes == null ? [name] : splitGroups(spec.excludes)
    this.rank = spec.rank
    let attrs: Attribute<any>[] = this.attrs = []
    let defaultAttrs: Attrs | null = Object.create(null)
    if (spec.attrs) for (let name in spec.attrs) {
      let attr = new Attribute(name, spec.attrs[name])
      attrs.push(attr)
      if (defaultAttrs) {
        if (attr.hasDefault) defaultAttrs[name] = attr.default as any
        else defaultAttrs = null
      }
    }
    this.defaultInstance = defaultAttrs ? new Mark(this, defaultAttrs) : null
  }

  get schemaElement(): SchemaElement { return this }

  create(attrs?: Partial<Attrs>) {
    if (!attrs) {
      if (this.defaultInstance) return this.defaultInstance
      attrs = {}
    }
    return new Mark(this, fillAttrs(this.attrs, attrs))
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

  getAttr<Name extends keyof Attrs>(attr: Name, mark: Mark): Attrs[Name] {
    if (mark.type != this) throw new Error(`Accessing attr on the wrong type of mark`)
    return mark.attrs[attr as any]
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

  static define<Attrs extends {}>(name: string, spec: MarkSpec<Attrs>) {
    return new MarkType<Attrs>(name, spec)
  }
}

export class Mark {
  constructor(
    readonly type: MarkType,
    readonly attrs: {[name: string]: any}
  ) {}

  get name() {
    return this.type.name
  }

  eq(other: Mark) {
    return this.type == other.type && compareAttrs(this.type.attrs, this.attrs, other.attrs)
  }

  toJSON(): MarkJSON {
    let result: MarkJSON = {type: this.name}
    if (this != this.type.defaultInstance) result.attrs = this.attrs
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
}

