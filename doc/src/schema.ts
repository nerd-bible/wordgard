import {Node, NodeType, MarkType, NodeJSON, MarkJSON, Text, DocNode, none} from "./node"

export type SchemaElement = {schemaElement: SchemaElement} | readonly SchemaElement[]

export class Schema {
  private nodeSet: Set<NodeType>
  private markSet: Set<MarkType>
  private nodesByName: {[name: string]: NodeType} = Object.create(null)
  private marksByName: {[name: string]: MarkType} = Object.create(null)
  private wrappingCache: {[key: string]: readonly Node[] | null} = Object.create(null)

  private constructor(
    readonly nodes: readonly NodeType[],
    readonly marks: readonly MarkType[],
    readonly docType: NodeType
  ) {
    this.nodeSet = new Set(nodes)
    this.markSet = new Set(marks)
    for (let node of nodes) this.nodesByName[node.name] = node
    for (let mark of marks) this.marksByName[mark.name] = mark
  }

  doc(children: readonly Node[]) {
    return new DocNode(this.docType, this.docType.checkChildren(children), this)
  }

  get schemaElement() { return this }

  // FIXME probably don't want to integrate this in document
  // construction, but rather in the editor state.
  validate(node: Node) {
    if (!this.nodeSet.has(node.type))
      throw new Error(`Node type ${node.name} not in schema`)
    for (let mark of node.marks) if (!this.markSet.has(mark.type))
      throw new Error(`Mark type ${mark.name} not in schema`)
    for (let ch of node.children) this.validate(ch)
  }

  defaultContentType(parent: NodeType) {
    for (let node of this.nodes) if (node.canBeChild(parent) && node.defaultAttrs) return node
    return null
  }

  createDefault(parent: NodeType): Node {
    let child = this.defaultContentType(parent)
    if (!child) throw new Error(`No defaultable child node for ${parent.name}`)
    if (child.isLeaf() || child.inlineContent()) return child.create()
    return child.create([this.createDefault(child)])
  }

  findWrapping(parent: NodeType, child: NodeType): readonly Node[] | null {
    let key = `${parent.name}-${child.name}`, cached = this.wrappingCache[key]
    if (cached !== undefined) return cached
    return this.wrappingCache[key] = this.findWrappingInner(parent, child)
  }

  private findWrappingInner(parent: NodeType, child: NodeType): readonly Node[] | null {
    let seen: Set<NodeType> = new Set, work: Node[][] = [[]]
    for (let i = 0; i < work.length; i++) {
      let path = work[i], at = path.length ? path[path.length - 1].type : parent
      for (let node of this.nodes) if (node.canBeChild(at)) {
        if (node == child) return path
        if (!seen.has(node) && !node.isLeaf()) {
          seen.add(node)
          work.push(path.concat(node.create()))
        }
      }
    }
    return null
  }

  static define(spec: SchemaElement) {
    let nodes: NodeType[] = [Text], marks: MarkType[] = []
    let names: Set<string> = new Set
    function scan(spec: SchemaElement) {
      if (Array.isArray(spec)) {
        spec.forEach(scan)
      } else if (spec instanceof NodeType || spec instanceof MarkType) {
        let array = spec instanceof NodeType ? nodes : marks
        if (array.includes(spec as any)) return
        if (names.has(spec.name))
          throw new Error(`Duplicate use of node/mark name ${spec.name} in schema`)
        names.add(spec.name)
        array.push(spec as any)
      } else if (spec instanceof Schema) {
        scan(spec.nodes)
        scan(spec.marks)
      } else if ((spec as any).schemaElement == spec) {
        throw new Error("Unexpected schema element type. You may have multiple versions of @willow/doc loaded")
      } else {
        scan((spec as any).schemaElement)
      }
    }
    scan(spec)
    let docType: NodeType | null = null
    for (let node of nodes) {
      if (node.isDoc()) docType = node
      if (!node.isLeaf()) {
        let sawDefaultable = false
        for (let child of nodes) if (child.canBeChild(node)) {
          if (child.defaultAttrs) sawDefaultable = true
          if (child.isInline() != node.inlineContent())
            throw new Error(`Node type ${node.name} has ${node.inlineContent() ? "block" : "inline"
                              } content, but allows ${child.name} as a child`)
        }
        if (!node.inlineContent() && !sawDefaultable)
          throw new Error(`Node ${node.name} has block content, but all possible children require non-default attributes`)
      }
    }
    if (!docType) throw new Error("A schema must define a document node type (Node.doc)")
    return new Schema(nodes, marks, docType)
  }

  nodeFromJSON(json: NodeJSON) {
    if (!json || typeof json != "object" || !(json.type in this.nodesByName))
      throw new Error("Invalid node JSON")
    let type = this.nodesByName[json.type]
    let marks = none, attrs = type.defaultAttrs, children = none
    if (json.marks && Array.isArray(json.marks))
      marks = json.marks.map(m => this.markFromJSON(m))
    if (type.isText() && typeof json.text == "string")
      return Node.text(json.text, marks)
    if (json.children && Array.isArray(json.children))
      children = json.children.map(c => this.nodeFromJSON(c))
    if (type.isDoc()) return this.doc(children)
    if (!attrs || json.attrs && typeof json.attrs == "object")
      attrs = json.attrs || {}
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

export const Paragraph = NodeType.textblock("Paragraph", {
  content: "Inline",
  tag: "p"
})

export const Heading = NodeType.textblock("Heading", {
  attrs: {
    level: {default: 1, attribute: "level"}
  },
  content: "Inline",
  tag: "h1" // FIXME
})

export const CodeBlock = NodeType.textblock("CodeBlock", {
  attrs: {
    language: {default: "", attribute: "data-language"}
  },
  content: "Inline",
  tag: "pre"
})

export const Blockquote = NodeType.block("Blockquote", {
  content: "Block",
  tag: "blockquote"
})

export const OrderedList = NodeType.block("OrderedList", {
  content: "ListItem",
  tag: "ol",
  attrs: {
    start: {default: 1, attribute: "start"}
  }
})

export const BulletList = NodeType.block("BulletList", {
  content: "ListItem",
  tag: "ul"
})

export const ListItem = NodeType.block("ListItem", {
  content: "Block",
  tag: "li"
})

export const HorizontalRule = NodeType.block("HorizontalRule", {
  tag: "hr",
  toText: () => "---"
})

export const Image = NodeType.inline<{src: string, alt: string}>("Image", {
  tag: "img",
  attrs: {
    src: {attribute: "src"},
    alt: {default: "", attribute: "alt"}
  }
})

export const LineBreak = NodeType.inline("LineBreak", {
  tag: "br"
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

export const Doc = NodeType.doc("Block")

export const basicSchema = Schema.define([
  Doc,
  Paragraph,
  Heading,
  CodeBlock,
  Blockquote,
  Image,
  HorizontalRule,
  BulletList,
  OrderedList,
  ListItem,
  Emphasis,
  Strong,
  Link,
  Code
])
