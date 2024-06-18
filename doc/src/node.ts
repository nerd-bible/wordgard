const enum NodeFlag {
  None = 0,
  Inline = 1,
  InlineContent = 2, // FIXME determine, somehow
  Text = 4,
  Leaf = 8,
}

const none: readonly any[] = []

export type NodeSpec<Attrs> = {
  attrs?: {[name in keyof Attrs]: AttrSpec<Attrs[name]>}
  content?: string
  group?: string
  tag: string
}

type ChildSpec = Node | string | readonly ChildSpec[]

export class NodeType<Attrs extends {} = {}> {
  attrs: {[name in keyof Attrs]: Attribute<Attrs[name]>}
  private groups: readonly string[]
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
    this.attrs = Object.create(null)
    let defaultAttrs: Attrs | null = Object.create(null)
    if (spec.attrs) for (let name in spec.attrs) {
      let attr = this.attrs[name] = new Attribute(name, spec.attrs[name])
      if (defaultAttrs) {
        if (attr.hasDefault) defaultAttrs[name] = attr.default as any
        else defaultAttrs = null
      }
    }
    let groups = this.groups = [name, flags & NodeFlag.Inline ? "inline" : "block"]
    if (spec.group) for (let g of spec.group.split(" ")) groups.push(g)
    this.defaultAttrs = defaultAttrs
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
        attrs = this.makeAttrs(attrsOrChild as Partial<Attrs>)
    }
    createChildren(children, childList)
    if (!attrs) throw new Error(`Must specify attrs when creating a node with some attributes that have no default value`)
    return new Node(this, attrs, childList)
  }

  private makeAttrs(attrs: Partial<Attrs>): Attrs {
    let fullAttrs: Attrs = Object.create(null)
    for (let name in this.attrs) {
      if (name in attrs) fullAttrs[name] = attrs[name]!
      else if (this.attrs[name].hasDefault) fullAttrs[name] = this.attrs[name].default
      else throw new Error(`Must provide attribute ${name}, which has no default value`)
    }
    return fullAttrs
  }

  isInGroup(group: string) {
    return this.groups.includes(group)
  }

  get isInline() { return (this.flags & NodeFlag.Inline) > 0 }
  get isText() { return (this.flags & NodeFlag.Text) > 0 }
  get isBlock() { return (this.flags & NodeFlag.Inline) == 0 }
  get inlineContent() { return (this.flags & NodeFlag.InlineContent) > 0 }
  get isLeaf() { return (this.flags & NodeFlag.Leaf) > 0 }
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

export class Node {
  constructor(
    readonly type: NodeType,
    readonly attrs: {[name: string]: any},
    readonly children: readonly Node[],
  ) {}

  get name() { return this.type.name }

  toString() {
    return this.name + (this.type.isLeaf ? `` : `(${this.children.join()})`)
  }
}

export class TextNode extends Node {
  constructor(readonly text: string) {
    super(Text, none, none)
  }

  toString() { return JSON.stringify(this.text) }
}

export type AttrSpec<T> = {
  default?: T
  parse?: (input: string) => T,
  serialize?: (value: T) => string,
  attribute?: string
}

export class Attribute<T = any> {
  hasDefault: boolean
  default: T

  constructor(readonly name: string, readonly spec: AttrSpec<T>) {
    this.hasDefault = "default" in spec
    this.default = spec.default!
  }
}

export type SchemaElement = {schemaElement: SchemaElement} | readonly SchemaElement[]

export class Schema {
  private constructor(
    nodes: readonly NodeType[]
  ) {}

  static define(spec: SchemaElement) {
    let nodes: NodeType[] = []
    function scan(spec: SchemaElement) {
      if (Array.isArray(spec)) {
        spec.forEach(scan)
      } else if (spec instanceof NodeType) {
        if (nodes.some(n => n.name == spec.name))
          throw new Error(`Duplicate use of node name ${spec.name} in schema`)
        nodes.push(spec)
      } else {
        scan((spec as any).schemaElement)
      }
    }
    scan(spec)
    return new Schema(nodes)
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
