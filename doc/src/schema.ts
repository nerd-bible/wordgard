import {Node, NodeType, Prop, PropSet, NodeJSON, Text, DocNode, none} from "./node"

export type SchemaElement = {schemaElement: SchemaElement} | readonly SchemaElement[]

export class Schema {
  private nodeSet: Set<NodeType>
  private propSet: Set<Prop<any>>
  private nodesByName: {[name: string]: NodeType} = Object.create(null)
  private propsByName: {[name: string]: Prop<any>} = Object.create(null)
  private wrappingCache: {[key: string]: readonly Node[] | null} = Object.create(null)

  private constructor(
    readonly nodes: readonly NodeType[],
    readonly props: readonly Prop<any>[],
    readonly docType: NodeType
  ) {
    this.nodeSet = new Set(nodes)
    this.propSet = new Set(props)
    for (let node of nodes) this.nodesByName[node.name] = node
    for (let prop of props) this.propsByName[prop.name] = prop
  }

  doc(children: readonly Node[]) {
    return new DocNode(this.docType, this.docType.checkChildren(children), this)
  }

  get schemaElement() { return this }

  // FIXME minus() method that returns a schema elt with some of the props/nodes gone?

  // FIXME probably don't want to integrate this in document
  // construction, but rather in the editor state.
  validate(node: Node) {
    if (!this.nodeSet.has(node.type))
      throw new Error(`Node type ${node.name} not in schema`)
    for (let prop of node.props.set) if (!this.propSet.has(prop.prop))
      throw new Error(`Prop type ${prop.name} not in schema`)
    for (let ch of node.children) this.validate(ch)
  }

  defaultContentType(parent: NodeType) {
    // FIXME provide less obscure control over order
    for (let node of this.nodes) if (parent.canContain(node) && !node.requiredProps.length) return node
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
      for (let node of this.nodes) if (at.canContain(node)) {
        if (node == child) return path
        if (!seen.has(node) && !node.isLeaf() && !node.requiredProps.length) {
          seen.add(node)
          work.push(path.concat(node.create()))
        }
      }
    }
    return null
  }

  getProp(name: string): Prop<any> | undefined { return this.propsByName[name] }

  getNode(name: string): NodeType<any> | undefined { return this.nodesByName[name] }

  static define(spec: SchemaElement) {
    let nodes: NodeType[] = [Text], props: Prop<any>[] = []
    let nodeNames: Set<string> = new Set, propNames: Set<string> = new Set
    function scan(spec: SchemaElement) {
      if (Array.isArray(spec)) {
        spec.forEach(scan)
      } else if (spec instanceof NodeType) {
        if (nodes.includes(spec)) return
        if (nodeNames.has(spec.name)) throw new Error(`Duplicate use of node name ${spec.name} in schema`)
        nodeNames.add(spec.name)
        nodes.push(spec)
        for (let prop in spec.props) scan(spec.props[prop])
      } else if (spec instanceof Prop) {
        if (props.includes(spec)) return
        if (propNames.has(spec.name)) throw new Error(`Duplicate use of prop name ${spec.name} in schema`)
        propNames.add(spec.name)
        props.push(spec as any)
      } else if (spec instanceof Schema) {
        scan(spec.nodes)
        scan(spec.props)
      } else if ((spec as any).schemaElement == spec) {
        throw new Error("Unexpected schema element type. You may have multiple versions of @willows/doc loaded")
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
        for (let child of nodes) if (node.canContain(child)) {
          if (!child.requiredProps.length) sawDefaultable = true
          if (child.isInline() != node.inlineContent())
            throw new Error(`Node type ${node.name} has ${node.inlineContent() ? "block" : "inline"
                              } content, but allows ${child.name} as a child`)
        }
        if (!node.inlineContent() && !sawDefaultable)
          throw new Error(`Node ${node.name} has block content, but all possible children require non-default params`)
      }
      for (let name in node.props) {
        if (propNames.has(name)) throw new Error(`Local prop ${name} in ${node.name} clashes with a global prop name`)
      }
    }
    if (!docType) throw new Error("A schema must define a document node type (Node.doc)")
    return new Schema(nodes, props, docType)
  }

  nodeFromJSON(json: NodeJSON) {
    if (!json || typeof json != "object" || !(json.type in this.nodesByName))
      throw new Error("Invalid node JSON")
    let type = this.nodesByName[json.type]
    let props = PropSet.empty, children = none
    if (json.props && typeof json.props == "object") {
      for (let name in json.props) {
        let prop = (type.props as any)[name] || this.propsByName[name]
        if (prop) props = props.add(prop.of(json.props[name]))
      }
    }
    if (type.isText() && typeof json.text == "string")
      return Node.text(json.text, props)
    if (json.children && Array.isArray(json.children))
      children = json.children.map(c => this.nodeFromJSON(c))
    if (type.isDoc()) return this.doc(children)
    return type.create(props, children)
  }
}

export const Paragraph = NodeType.textblock("Paragraph", {
  content: "Inline",
  group: "Block",
  dom: {tag: "p"}
})

export const Heading = NodeType.textblock<{level: number}>("Heading", {
  props: {
    level: {required: true, dom: {attribute: "level", read: Number}}
  },
  content: "Inline",
  group: "Block",
  dom: {tag: "h1"} // FIXME
})

export const CodeBlock = NodeType.textblock<{language: string}>("CodeBlock", {
  props: {
    language: {dom: {attribute: "data-language", read: (x: string) => x}}
  },
  content: "Inline",
  group: "Block",
  dom: {tag: "pre"}
})

export const Blockquote = NodeType.block("Blockquote", {
  content: "Block",
  group: "Block",
  dom: {tag: "blockquote"}
})

export const OrderedList = NodeType.block<{start: number}>("OrderedList", {
  content: "ListItem",
  group: "Block",
  dom: {tag: "ol"},
  props: {
    start: {dom: {attribute: "start", read: Number}}
  }
})

export const BulletList = NodeType.block("BulletList", {
  content: "ListItem",
  group: "Block",
  dom: {tag: "ul"}
})

export const ListItem = NodeType.block("ListItem", {
  content: "Block",
  dom: {tag: "li"}
})

export const HorizontalRule = NodeType.block("HorizontalRule", {
  group: "Block",
  dom: {tag: "hr"},
  toText: () => "---"
})

export const Image = NodeType.inline<{src: string, alt: string}>("Image", {
  dom: {tag: "img"},
  props: {
    src: {required: true, dom: {attribute: "src", read: (x: string) => x}},
    alt: {dom: {attribute: "alt", read: (x: string) => x}}
  }
})

export const LineBreak = NodeType.inline("LineBreak", {
  dom: {tag: "br"}
})

export const Emphasis = Prop.flag("Emphasis", {
  rank: 40,
  dom: {tag: "em"}
})

export const Strong = Prop.flag("Strong", {
  rank: 60,
  dom: {tag: "strong"},
})

export const Link = Prop.define<{href: string}>("Link", {
  rank: 20,
  dom: {
    tag: "a",
    selector: "a[href]",
    attrs: attrs => attrs,
    read: (dom: HTMLElement) => ({href: (dom as HTMLLinkElement).href})
  },
})

export const Code = Prop.flag("Code", {
  rank: 80,
  dom: {tag: "code"}
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
  Emphasis.prop,
  Strong.prop,
  Link,
  Code.prop
])
