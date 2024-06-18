const enum NodeFlag {
  None = 0,
  Inline = 1,
  InlineContent = 2, // FIXME determine, somehow
  Text = 4,
  Leaf = 8,
}

const none: readonly any[] = []

export type NodeSpec<Attrs extends {}> = {
  attrs?: {[name in keyof Attrs]: AttrSpec<Attrs[name]>}
  content?: string
  group?: string
  tag: string
}

type ChildSpec = Node | string | readonly ChildSpec[]

export class NodeType<Attrs extends {} = {}> {
  attrs: readonly Attribute<any>[]
  private groups: readonly string[]
  private contentGroups: readonly string[]
  private defaultAttrs: Attrs | null
  schemaElement: NodeType
  flags: NodeFlag

  constructor(
    readonly name: string,
    flags: NodeFlag,
    readonly spec: NodeSpec<Attrs>
  ) {
    this.schemaElement = this
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
    let groups = this.groups = [name, flags & NodeFlag.Inline ? "inline" : "block"]
    if (spec.group) for (let g of spec.group.split(" ")) groups.push(g)
    this.contentGroups = spec.content ? spec.content.split(" ") : none
  }

  static block<Attrs extends {}>(name: string, spec: NodeSpec<Attrs>) {
    checkReserved(name)
    return new NodeType<Attrs>(name, NodeFlag.None, spec)
  }

  static inline<Attrs extends {}>(name: string, spec: NodeSpec<Attrs>) {
    checkReserved(name)
    return new NodeType<Attrs>(name, NodeFlag.Inline, spec)
  }

  create(attrs: Partial<Attrs>, ...children: ChildSpec[]): Node
  create(...children: ChildSpec[]): Node
  create(attrsOrChild?: Partial<Attrs> | ChildSpec, ...children: ChildSpec[]): Node {
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
    return parent.contentGroups.some(g => this.isInGroup(g))
  }

  checkChildren(children: readonly Node[]) {
    for (let child of children)
      if (child.type.canBeChild(this)) throw new Error(`${child.name} is not a valid child of ${this.name}`)
    return children
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
  if (name == "inline" || name == "block" || name == "text")
    throw new Error(`Node name ${name} is reserved`)
}

function createChildren(children: ChildSpec, result: Node[] = []) {
  if (typeof children == "string") result.push(new TextNode(children))
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
  constructor(
    readonly type: NodeType,
    readonly attrs: {[name: string]: any},
    readonly marks: readonly Mark[],
    readonly children: readonly Node[],
  ) {}

  get name() { return this.type.name }

  mark(marks: readonly Mark[]) {
    return new Node(this.type, this.attrs, marks, this.children)
  }

  copy(children: readonly Node[]) {
    return new Node(this.type, this.attrs, this.marks, this.type.checkChildren(children))
  }

  toString() {
    return this.name + (this.type.isLeaf ? `` : `(${this.children.join()})`)
  }
}

export class TextNode extends Node {
  constructor(readonly text: string, marks: readonly Mark[] = none) {
    super(Text, none, marks, none)
  }

  toString() { return JSON.stringify(this.text) }
}

export type AttrSpec<T> = {
  default?: T
  parse?: (input: string) => T,
  serialize?: (value: T) => string,
  attribute?: string
}

class Attribute<T = any> {
  hasDefault: boolean
  default: T

  constructor(readonly name: string, readonly spec: AttrSpec<T>) {
    this.hasDefault = "default" in spec
    this.default = spec.default!
  }
}

export type MarkSpec<Attrs extends {}> = {
  attrs?: {[name in keyof Attrs]: AttrSpec<Attrs[name]>}
}

export class MarkType<Attrs extends {} = {}> {
  attrs: readonly Attribute<any>[]
  private defaultInstance: Mark | null

  private constructor(
    readonly name: string,
    readonly spec: MarkSpec<Attrs>
  ) {
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

  create(attrs?: Partial<Attrs>) {
    if (!attrs) {
      if (this.defaultInstance) return this.defaultInstance
      attrs = {}
    }
    return new Mark(this, fillAttrs(this.attrs, attrs))
  }

  getAttr<Name extends keyof Attrs>(attr: Name, mark: Mark): Attrs[Name] {
    if (mark.type != this) throw new Error(`Accessing attr on the wrong type of mark`)
    return mark.attrs[attr as any]
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
}

export type SchemaElement = {schemaElement: SchemaElement} | readonly SchemaElement[]

export class Schema {
  private nodeSet: Set<NodeType>
  private markSet: Set<MarkType>

  private constructor(
    nodes: readonly NodeType[],
    marks: readonly MarkType[]
  ) {
    this.nodeSet = new Set(nodes)
    this.markSet = new Set(marks)
  }

  validate(node: Node) {
    if (!this.nodeSet.has(node.type))
      throw new Error(`Node type ${node.name} not in schema`)
    for (let mark of node.marks) if (!this.markSet.has(mark.type))
      throw new Error(`Mark type ${mark.name} not in schema`)
    for (let ch of node.children) this.validate(ch)
  }

  static define(spec: SchemaElement) {
    let nodes: NodeType[] = [], marks: MarkType[] = []
    let names: Set<string> = new Set
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
    return new Schema(nodes, marks)
  }
}

export const Text = new NodeType("Text", NodeFlag.Text | NodeFlag.Inline, {tag: ""})

export const Paragraph = NodeType.block("Paragraph", {
  content: "inline",
  tag: "p"
})

export const Blockquote = NodeType.block("Blockquote", {
  content: "block",
  tag: "blockquote"
})

export const Image = NodeType.inline<{src: string, alt: string}>("Image", {
  tag: "img",
  attrs: {
    src: {},
    alt: {default: ""}
  }
})

export const schema = Schema.define([
  Paragraph,
  Blockquote,
  Image,
])

console.log(Paragraph.create("one") + "")
