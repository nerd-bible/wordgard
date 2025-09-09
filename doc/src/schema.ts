import {Node, Tag, TagType, TagJSON, NodeJSON, Text, DocNode} from "./node"
import {Prop, PropType} from "./prop"
import {none, validate} from "./helper"
import {elt, Reject} from "./shape"

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
    docType: TagType<Schema>,
    readonly lineBreak: Tag<unknown> | null
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

  validate(node: Node) {
    this.validateTag(node.tag)
    for (let ch of node.children) this.validate(ch)
  }

  /// @internal
  validateTag(tag: Tag<any>) {
    if (!this.tagSet.has(tag.type))
      throw new Error(`Tag type ${tag.name} not in schema`)
    for (let prop of tag.props) this.validateProp(prop)
  }

  /// @internal
  validateProp(prop: Prop<any>) {
    if (!this.propSet.has(prop.type))
      throw new Error(`Prop type ${prop.name} not in schema`)
  }

  defaultContentType(parent: TagType<any>) {
    for (let tag of this.tags) if (parent.canContain(tag) && tag.default) return tag.default
    return null
  }

  createDefault(parent: TagType<any>): Node {
    let child = this.defaultContentType(parent)
    if (!child) throw new Error(`No defaultable child node for ${parent.name}`)
    if (child.isLeaf() || child.inlineContent()) return child.create()
    return child.create([this.createDefault(child.type)])
  }

  findWrapping(parent: TagType<any>, child: TagType<any>): readonly Tag[] | null {
    let key = `${parent.name}-${child.name}`, cached = this.wrappingCache[key]
    if (cached !== undefined) return cached
    return this.wrappingCache[key] = this.findWrappingInner(parent, child)
  }

  private findWrappingInner(parent: TagType<any>, child: TagType<any>): readonly Tag[] | null {
    let seen: Set<TagType<unknown>> = new Set, work: Tag[][] = [[]]
    for (let i = 0; i < work.length; i++) {
      let path = work[i], at = path.length ? path[path.length - 1].type : parent
      for (let tag of this.tags) if (at.canContain(tag)) {
        if (tag == child) return path
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
    let defaultI = 0
    let tagNames: Set<string> = new Set, propNames: Set<string> = new Set
    for (let elt of spec) {
      if (elt instanceof Tag || elt instanceof Prop) elt = elt.type
      if (elt instanceof TagType) {
        if (tags.includes(elt)) continue
        if (tagNames.has(elt.name)) throw new Error(`Duplicate use of tag name ${elt.name} in schema`)
        tagNames.add(elt.name)
        if (elt.spec.defaultBlock) tags.splice(defaultI++, 0, elt)
        else tags.push(elt)
      } else if (elt instanceof PropType) {
        if (props.includes(elt)) continue
        if (propNames.has(elt.name)) throw new Error(`Duplicate use of prop name ${elt.name} in schema`)
        propNames.add(elt.name)
        props.push(elt as any)
      } else {
        throw new Error("Unexpected schema element type. You may have multiple versions of @wordgard/doc loaded")
      }
    }
    let docTag: TagType<Schema> | null = null
    let lineBreak: Tag<any> | null = null
    for (let tag of tags) {
      if (tag.isDoc()) docTag = tag
      if (tag.spec.isLineBreak) {
        if (tag.isBlock() || !tag.isLeaf() || !tag.default)
          throw new Error("Line break tags must be inline leaves with a default param")
        if (lineBreak) throw new Error("Multiple line break tags provided")
        lineBreak = tag.default
      }
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
    return new Schema(tags, props, docTag, lineBreak as Tag<unknown> | null)
  }

  nodeFromJSON(json: NodeJSON) {
    let tag = this.tagFromJSON(json), children = none
    if (json.children && Array.isArray(json.children))
      children = json.children.map(c => this.nodeFromJSON(c))
    if (tag.type.isDoc()) return this.doc(children)
    return tag.create(children)
  }

  tagFromJSON(json: TagJSON) {
    if (!json || typeof json != "object" || !(json.type in this.tagsByName))
      throw new Error("Invalid tag JSON")
    let type = this.tagsByName[json.type]
    let props = json.props ? this.propsFromJSON(json.props) : none
    let tag = "param" in json ? new Tag(type, validate(type.spec.validateParam, json.param), props)
      : !type.default ? null
      : props.length ? new Tag(type, type.default.param, props) : type.default
    if (!tag) throw new Error(`Missing param for tag type ${type.name}`)
    return tag
  }

  propsFromJSON(json: Record<string, any>): readonly Prop<undefined>[] {
    if (!json || typeof json != "object") throw new Error("Invalid prop JSON")
    let props = none
    for (let name in json) {
      let prop = this.propsByName[name]
      if (!prop) throw new Error(`Unrecognized prop ${name} in JSON`)
      props = prop.of(validate(prop.spec.validate, json[name])).addToSet(props)
    }
    return props
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
  defaultBlock: true,
  dom: {element: "p"}
})

export const Heading = TagType.defineBlock("Heading", {
  defaultParam: 1,
  validateParam: "number",
  inlineContent: true,
  group: "Block",
  dom: {structure: level => elt("h" + level, 0)},
  defining: true,
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
  validate: "string",
  dom: {attribute: "data-language", readAttribute: x => x}
})

export const Blockquote = Tag.defineBlock("Blockquote", {
  blockContent: "Block",
  group: "Block",
  dom: {element: "blockquote"}
})

export const OrderedList = TagType.defineBlock("OrderedList", {
  defaultParam: 1,
  validateParam: "number",
  blockContent: "ListItem",
  group: "Block",
  dom: {
    element: "ol",
    attributes: order => order == 1 ? {} as Record<string, string> : {order: String(order)},
    readElement: elt => Number(elt.getAttribute("order") || "1")
  },
  autoJoin: (a, b) => b.param == 1
})

export const BulletList = Tag.defineBlock("BulletList", {
  blockContent: "ListItem",
  group: "Block",
  dom: {element: "ul"},
  autoJoin: true
})

export const ListItem = Tag.defineBlock("ListItem", {
  blockContent: "Block",
  dom: {element: "li"},
  defining: true,
})

export const HorizontalRule = Tag.defineBlock("HorizontalRule", {
  group: "Block",
  dom: {element: "hr"},
  toText: () => "---"
})

export const Image = TagType.defineInline<string>("Image", {
  validateParam: "string",
  dom: {element: "img", attributes: src => ({src}), readElement: elt => (elt as HTMLImageElement).src || Reject}
})

export const ImageAlt = PropType.define<string>("ImageAlt", {
  tags: "Image",
  validate: "string",
  dom: {attribute: "alt", readAttribute: x => x}
})

export const LineBreak = Tag.defineInline("LineBreak", {
  isLineBreak: true,
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
  validate: "string",
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
  LineBreak,
  HorizontalRule,
  BulletList,
  OrderedList,
  ListItem,
  Emphasis,
  Strong,
  Link,
  Code
])
