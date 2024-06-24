const enum NodeFlag {
  None = 0,
  Inline = 1,
  InlineContent = 2, // FIXME determine, somehow
  Text = 4,
  Leaf = 8,
  Doc = 16,
}

const none: readonly any[] = []
const noAttrs: {[name: string]: any} = Object.create(null)

// FIXME find another word for 'Attr'?

export type NodeSpec<Attrs extends {}> = {
  attrs?: {[name in keyof Attrs]: AttrSpec<Attrs[name]>}
  content?: string
  group?: string
  tag: string
}

type ChildSpec = Node | string | readonly ChildSpec[]

const docTypes = new Map<string, NodeType<{}>>()

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

  static inline<Attrs extends {}>(name: string, spec: NodeSpec<Attrs>) {
    checkReserved(name)
    return new NodeType<Attrs>(name, NodeFlag.Inline, spec)
  }

  static doc(content: string) {
    let cached = docTypes.get(content)
    if (cached) return cached
    let type = new NodeType("doc", NodeFlag.Doc, {content, tag: ""})
    docTypes.set(content, type)
    return type
  }

  get schemaElement(): SchemaElement { return this }

  create(attrs: Partial<Attrs>, ...children: ChildSpec[]): Node
  create(...children: ChildSpec[]): Node
  create(attrsOrChild?: Partial<Attrs> | ChildSpec, ...children: ChildSpec[]): Node {
    if (this.isText) throw new Error("Text nodes cannot be created with .create()")
    let attrs = this.defaultAttrs, childList: Node[] = []
    if (attrsOrChild) {
      if (Array.isArray(attrsOrChild) || typeof attrsOrChild == "string" || attrsOrChild instanceof Node)
        createChildren(attrsOrChild, childList)
      else
        attrs = fillAttrs(this.attrs, attrsOrChild as Partial<Attrs>)
    }
    createChildren(children, childList)
    if (!attrs) throw new Error(`Must specify attrs when creating a node with some attributes that have no default value`)
    return new Node(this, attrs, none, this.checkChildren(childList))
  }

  isInGroup(group: string) {
    return this.groups.includes(group)
  }

  canBeChild(parent: NodeType) {
    return this.flags & NodeFlag.Doc ? false : parent.contentGroups.some(g => this.isInGroup(g))
  }

  checkChildren(children: readonly Node[]) {
    for (let child of children)
      if (!child.type.canBeChild(this)) {
        console.log(this.contentGroups, child.type.groups, this.contentGroups.some(g => child.type.isInGroup(g)))
        throw new Error(`${child.name} is not a valid child of ${this.name}`)
      }
    return children
  }

  checkMarks(marks: readonly Mark[]) {
    for (let mark of marks) if (!mark.type.canTarget(this))
      throw new Error(`Mark ${mark.name} cannot be applied to node ${this.name}`)
    return marks
  }

  get isInline() { return (this.flags & NodeFlag.Inline) > 0 }
  get isText() { return (this.flags & NodeFlag.Text) > 0 }
  get isBlock() { return (this.flags & NodeFlag.Inline) == 0 }
  get inlineContent() { return (this.flags & NodeFlag.InlineContent) > 0 }
  get isLeaf() { return (this.flags & NodeFlag.Leaf) > 0 }

  getAttr<Name extends keyof Attrs>(attr: Name, node: Node): Attrs[Name] {
    if (node.type != this) throw new Error(`Accessing attr on the wrong type of node`)
    return node.attrs[attr as any]
  }
}

function checkReserved(name: string) {
  if (name == "Inline" || name == "Block" || name == "Text" || name == "Doc")
    throw new Error(`Node name ${name} is reserved`)
}

function createChildren(children: ChildSpec, result: Node[] = []) {
  if (typeof children == "string") result.push(Node.text(children))
  else if (Array.isArray(children)) for (let child of children) createChildren(child, result)
  else result.push(children as Node)
  return result
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

  get length() { return this.type.isLeaf ? 1 : 2 + this.contentLength }

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

  isText(): this is TextNode { // FIXME interface consistency
    return this.type.isText
  }

  toString() {
    return marksToString(this.marks, this.name + (this.type.isLeaf ? `` : `(${this.children.join()})`))
  }

  toJSON(): NodeJSON {
    let result: NodeJSON = {type: this.name}
    if (this.marks.length) result.marks = this.marks.map(m => m.toJSON())
    if (this.attrs != this.type.defaultAttrs) result.attrs = this.attrs
    if (this.isText()) result.text = this.text
    if (this.children.length) result.children = this.children.map(c => c.toJSON())
    return result
  }

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
}

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

  slice(from: number, to = this.length) {
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
    this.attrs = Object.create(null)
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
}

export type SchemaElement = {schemaElement: SchemaElement} | readonly SchemaElement[]

export class Schema {
  private nodeSet: Set<NodeType>
  private markSet: Set<MarkType>
  private nodesByName: {[name: string]: NodeType} = Object.create(null)
  private marksByName: {[name: string]: MarkType} = Object.create(null)

  private constructor(
    readonly nodes: readonly NodeType[],
    readonly marks: readonly MarkType[],
    private inlineContent: Set<NodeType>,
  ) {
    this.nodeSet = new Set(nodes)
    this.markSet = new Set(marks)
    for (let node of nodes) this.nodesByName[node.name] = node
    for (let mark of marks) this.marksByName[mark.name] = mark
  }

  validate(node: Node) {
    if (!this.nodeSet.has(node.type))
      throw new Error(`Node type ${node.name} not in schema`)
    for (let mark of node.marks) if (!this.markSet.has(mark.type))
      throw new Error(`Mark type ${mark.name} not in schema`)
    for (let ch of node.children) this.validate(ch)
  }

  hasInlineContent(type: NodeType) {
    return this.inlineContent.has(type)
  }

  defaultContentType(parent: NodeType) {
    for (let node of this.nodes) if (node.canBeChild(parent) && node.defaultAttrs) return node
    return null
  }

  createDefault(parent: NodeType): Node {
    let child = this.defaultContentType(parent)
    if (!child) throw new Error(`No defaultable child node for ${parent.name}`)
    if (child.isLeaf || this.hasInlineContent(child)) return child.create()
    return child.create(this.createDefault(child))
  }

  static define(spec: SchemaElement) {
    let nodes: NodeType[] = [Text], marks: MarkType[] = []
    let names: Set<string> = new Set
    let inlineContent: Set<NodeType> = new Set
    function scan(spec: SchemaElement) {
      if (Array.isArray(spec)) {
        spec.forEach(scan)
      } else if (spec instanceof NodeType || spec instanceof MarkType) {
        if (names.has(spec.name))
          throw new Error(`Duplicate use of node/mark name ${spec.name} in schema`)
        names.add(spec.name)
        ;(spec instanceof NodeType ? nodes : marks).push(spec as any)
      } else {
        scan((spec as any).schemaElement)
      }
    }
    scan(spec)
    for (let node of nodes) if (!node.isLeaf) {
      let inline: boolean | null = null, sawDefaultable = false
      for (let child of nodes) if (child.canBeChild(node)) {
        if (child.defaultAttrs) sawDefaultable = true
        let childInline = child.isInline
        if (inline == null) inline = childInline
        else if (inline != childInline) throw new Error(`Node type ${node.name} allows both inline and block children`)
      }
      if (inline) inlineContent.add(node)
      else if (!sawDefaultable) throw new Error(`Node ${node.name} has block content, but all possible children require non-default attributes`)
    }
    return new Schema(nodes, marks, inlineContent)
  }

  nodeFromJSON(json: NodeJSON) {
    if (!json || typeof json != "object" || !(json.type in this.nodesByName))
      throw new Error("Invalid node JSON")
    let type = this.nodesByName[json.type]
    let marks = none, attrs = type.defaultAttrs, children = none
    if (json.marks && Array.isArray(json.marks))
      marks = json.marks.map(m => this.markFromJSON(m))
    if (type.isText && typeof json.text == "string")
      return Node.text(json.text, marks)
    if (!attrs || json.attrs && typeof json.attrs == "object")
      attrs = json.attrs || {}
    if (json.children && Array.isArray(json.children))
      children = json.children.map(c => this.nodeFromJSON(c))
    return type.create(attrs!, children).mark(marks)
  }

  markFromJSON(json: MarkJSON) {
    if (!json || typeof json != "object" || !(json.type in this.marksByName))
      throw new Error("Invalid mark JSON")
    let type = this.marksByName[json.type]
    if (!json.attrs && type.defaultInstance) return type.defaultInstance
    return type.create(json.attrs || {})
  }
}

export const Text = new NodeType("Text", NodeFlag.Text | NodeFlag.Inline, {tag: ""})

export const Paragraph = NodeType.block("Paragraph", {
  content: "Inline",
  tag: "p"
})

export const Blockquote = NodeType.block("Blockquote", {
  content: "Block",
  tag: "blockquote"
})

export const Image = NodeType.inline<{src: string, alt: string}>("Image", {
  tag: "img",
  attrs: {
    src: {attribute: "src"},
    alt: {default: "", attribute: "alt"}
  }
})

export const Emphasis = MarkType.define("Emphasis", {
  rank: 40,
  tag: "em"
})

export const Strong = MarkType.define("Strong", {
  rank: 60,
  tag: "strong",
})

export const Link = MarkType.define("Link", {
  rank: 20,
  tag: "a",
  attrs: {
    href: {attribute: "href"}
  }   
})

export const Code = MarkType.define("Code", {
  rank: 80,
  tag: "code"
})

export const schema = Schema.define([
  Paragraph,
  Blockquote,
  Image,
  Emphasis,
  Strong,
  Link,
  Code
])

export const Doc = NodeType.doc("Block")
