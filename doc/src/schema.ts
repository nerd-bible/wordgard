import {Node, Tag, TagType, NodeJSON, Text, DocNode} from "./node"
import {Prop, PropType, PropSet} from "./prop"
import {none} from "./helper"
import {Reject} from "./spec"

export type SchemaElement = Tag<any> | TagType<any> | Prop<any> | PropType<any>

export class Schema {
  private tagSet: Set<TagType<unknown>>
  private propSet: Set<PropType<any>>
  private tagsByName: {[name: string]: TagType<unknown>} = Object.create(null)
  private propsByName: {[name: string]: PropType<any>} = Object.create(null)
  private wrappingCache: {[key: string]: readonly Tag[] | null} = Object.create(null)
  readonly docTag: Tag<Schema>

  private constructor(
    readonly tags: readonly TagType<unknown>[],
    readonly props: readonly PropType<any>[],
    docType: TagType<Schema>
  ) {
    this.tagSet = new Set(tags)
    this.propSet = new Set(props)
    this.docTag = docType.of(this)
    for (let tag of tags) this.tagsByName[tag.name] = tag
    for (let prop of props) this.propsByName[prop.name] = prop
  }

  doc(children: readonly Node[]) {
    return new DocNode(this.docTag, this.docTag.type.checkChildren(children))
  }

  // FIXME probably don't want to integrate this in document
  // construction, but rather in the editor state.
  validate(node: Node) {
    if (!this.tagSet.has(node.tag.type))
      throw new Error(`Node type ${node.name} not in schema`)
    for (let prop of node.props.set) if (!this.propSet.has(prop.type))
      throw new Error(`Prop type ${prop.name} not in schema`)
    for (let ch of node.children) this.validate(ch)
  }

  defaultContentType(parent: TagType<any>) {
    // FIXME provide less obscure control over order
    for (let tag of this.tags) if (parent.canContain(tag) && tag.default) return tag.default
    return null
  }

  createDefault(parent: TagType<any>): Node {
    let child = this.defaultContentType(parent)
    if (!child) throw new Error(`No defaultable child node for ${parent.name}`)
    if (child.isLeaf() || child.inlineContent()) return child.create()
    return child.create([this.createDefault(child.type)])
  }

  findWrapping(parent: Tag, child: Tag): readonly Tag[] | null {
    let key = `${parent.name}-${child.name}`, cached = this.wrappingCache[key]
    if (cached !== undefined) return cached
    return this.wrappingCache[key] = this.findWrappingInner(parent, child)
  }

  private findWrappingInner(parent: Tag<any>, child: Tag): readonly Tag[] | null {
    let seen: Set<TagType<unknown>> = new Set, work: Tag[][] = [[]]
    for (let i = 0; i < work.length; i++) {
      let path = work[i], at = path.length ? path[path.length - 1] : parent
      for (let tag of this.tags) if (at.type.canContain(tag)) {
        if (tag == child.type) return path
        if (!seen.has(tag) && !tag.isLeaf() && tag.default) {
          seen.add(tag)
          work.push(path.concat(tag.default))
        }
      }
    }
    return null
  }

  getProp(name: string): PropType<any> | undefined { return this.propsByName[name] }

  getTag(name: string): TagType<unknown> | undefined { return this.tagsByName[name] }

  static define(spec: readonly SchemaElement[]) {
    let tags: TagType<any>[] = [Text], props: PropType<unknown>[] = []
    let tagNames: Set<string> = new Set, propNames: Set<string> = new Set
    for (let elt of spec) {
      if (elt instanceof Tag || elt instanceof Prop) elt = elt.type
      if (elt instanceof TagType) {
        if (tags.includes(elt)) continue
        if (tagNames.has(elt.name)) throw new Error(`Duplicate use of node name ${elt.name} in schema`)
        tagNames.add(elt.name)
        tags.push(elt)
      } else if (elt instanceof PropType) {
        if (props.includes(elt)) continue
        if (propNames.has(elt.name)) throw new Error(`Duplicate use of prop name ${elt.name} in schema`)
        propNames.add(elt.name)
        props.push(elt as any)
      } else {
        throw new Error("Unexpected schema element type. You may have multiple versions of @willows/doc loaded")
      }
    }
    let docTag: TagType<Schema> | null = null
    for (let tag of tags) {
      if (tag.isDoc()) docTag = tag
      if (!tag.isLeaf()) {
        let sawDefaultable = false
        for (let child of tags) if (tag.canContain(child)) {
          if (child.default) sawDefaultable = true
          if (child.isInline() != tag.inlineContent())
            throw new Error(`Node type ${tag.name} has ${tag.inlineContent() ? "block" : "inline"
                              } content, but allows ${child.name} as a child`)
        }
        if (!tag.inlineContent() && !sawDefaultable)
          throw new Error(`Node ${tag.name} has block content, but all possible children require non-default props`)
      }
    }
    if (!docTag) throw new Error("A schema must define a document tag")
    return new Schema(tags, props, docTag)
  }

  nodeFromJSON(json: NodeJSON) {
    if (!json || typeof json != "object" || !(json.type in this.tagsByName))
      throw new Error("Invalid node JSON")
    let type = this.tagsByName[json.type]
    let tag = "param" in json ? new Tag(type, json.param) : type.default
    if (!tag) throw new Error(`Missing param for tag type ${type.name}`)
    let props = PropSet.empty, children = none
    if (json.props && typeof json.props == "object") {
      for (let name in json.props) {
        let prop = this.propsByName[name]
        if (prop) props = props.add(prop.of(json.props[name]))
      }
    }
    if (type.isText() && typeof json.text == "string")
      return Node.text(json.text, props)
    if (json.children && Array.isArray(json.children))
      children = json.children.map(c => this.nodeFromJSON(c))
    if (type.isDoc()) return this.doc(children)
    return tag.create(props, children)
  }

  docFromJSON(json: NodeJSON) {
    if (!json || json.type != this.docTag.name)
      throw new Error("Invalid document JSON")
    return this.nodeFromJSON(json) as DocNode
  }
}

export const Paragraph = Tag.defineBlock("Paragraph", {
  inlineContent: true,
  group: "Block",
  dom: {element: "p"}
})

export const Heading = TagType.defineBlock("Heading", {
  defaultParam: 1,
  inlineContent: true,
  group: "Block",
  dom: level => document.createElement("h" + level),
  parseRules: [
    {selector: "h1", param: 1},
    {selector: "h2", param: 2},
    {selector: "h3", param: 3},
    {selector: "h4", param: 4},
    {selector: "h5", param: 5},
    {selector: "h6", param: 6},
  ]
})

export const CodeBlock = Tag.defineBlock("CodeBlock", {
  inlineContent: true,
  group: "Block",
  dom: {element: "pre"},
  preserveWhitespace: true
})

export const CodeBlockLanguage = PropType.define("CodeBlockLanguage", {
  tags: "CodeBlock",
  dom: {attribute: "data-language", readAttribute: x => x}
})

export const Blockquote = Tag.defineBlock("Blockquote", {
  blockContent: "Block",
  group: "Block",
  dom: {element: "blockquote"}
})

export const OrderedList = TagType.defineBlock("OrderedList", {
  defaultParam: 1,
  blockContent: "ListItem",
  group: "Block",
  dom: {
    element: "ol",
    attributes: order => order == 1 ? {} : {order},
    readElement: elt => Number(elt.getAttribute("order") || "1")
  },
})

export const BulletList = Tag.defineBlock("BulletList", {
  blockContent: "ListItem",
  group: "Block",
  dom: {element: "ul"}
})

export const ListItem = Tag.defineBlock("ListItem", {
  blockContent: "Block",
  dom: {element: "li"}
})

export const HorizontalRule = Tag.defineBlock("HorizontalRule", {
  group: "Block",
  dom: {element: "hr"},
  toText: () => "---"
})

export const Image = TagType.defineInline<string>("Image", {
  dom: {element: "img", attributes: src => ({src}), readElement: elt => (elt as HTMLImageElement).src || Reject}
})

export const ImageAlt = PropType.define<string>("ImageAlt", {
  tags: "Image",
  dom: {attribute: "alt", readAttribute: x => x}
})

export const LineBreak = Tag.defineInline("LineBreak", {
  dom: {element: "br"}
})

export const Emphasis = Prop.define("Emphasis", {
  rank: 40,
  dom: {element: "em"},
  parseRules: [
    {attribute: "style/font-style", value: "italic"},
    {attribute: "style/font-style", value: "normal", clearProp: p => p.name == "Emphasis"}
  ]
})

export const Strong = Prop.define("Strong", {
  rank: 60,
  dom: {element: "strong"},
  parseRules: [
    {attribute: "style/font-weight",
     readAttribute: value => /^(bold(er)?|[5-9]\d{2,})$/.test(value) ? null : Reject},
    {attribute: "style/font-weight",
     readAttribute: value => /^(normal|lighter|[1-4]\d{2})$/.test(value) ? null : Reject,
     clearProp: p => p.name == "Strong"},
  ]
})

export const Link = PropType.define<string>("Link", {
  rank: 20,
  dom: {
    element: "a",
    selector: "a[href]",
    attributes: href => ({href}),
    readElement: dom => (dom as HTMLLinkElement).href
  },
})

export const Code = Prop.define("Code", {
  rank: 80,
  dom: {element: "code"}
})

export const Doc = Tag.defineDoc({
  blockContent: "Block"
})

export const basicSchema = Schema.define([
  Doc,
  Paragraph,
  Heading,
  CodeBlock,
  CodeBlockLanguage,
  Blockquote,
  Image,
  ImageAlt,
  HorizontalRule,
  BulletList,
  OrderedList,
  ListItem,
  Emphasis,
  Strong,
  Link,
  Code
])
