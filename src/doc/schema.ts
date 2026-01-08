import {Plot, Node, Leaf} from "./node"
import {Prop} from "./prop"
import {none, validate} from "./helper"
import {elt, Reject} from "./shape"

export type SchemaElement = Leaf.Any | Plot.Tag.Any | Node.Type<any> | Prop<any> | Prop.Type<any>

// FIXME maybe don't store these forever
const schemaCache = new Set<Schema>()

export class Schema {
  private tagsByName: {[name: string]: Node.Type<unknown>} = Object.create(null)
  private propsByName: {[name: string]: Prop.Type<any>} = Object.create(null)
  private wrappingCache: {[key: string]: readonly Plot.Tag.Any[] | null} = Object.create(null)
  readonly docTag: Plot.Tag<Schema>
  /// All the schema elements that make up this schema. Useful if you
  /// want to include the schema as a whole in an editor configuration.
  elements: readonly SchemaElement[]

  private constructor(
    readonly tags: readonly Node.Type<unknown>[],
    readonly props: readonly Prop.Type<any>[],
    docType: Plot.Type<Schema>,
    readonly lineBreak: Leaf<unknown> | null
  ) {
    this.docTag = docType.of(this)
    for (let tag of tags) this.tagsByName[tag.name] = tag
    for (let prop of props) this.propsByName[prop.name] = prop
    this.elements = (tags as SchemaElement[]).concat(props)
  }

  doc(children: readonly Node[]) {
    return new Plot.Doc(this.docTag, this.docTag.type.checkChildren(children))
  }

  validate(node: Node) {
    if (node.isLeaf) {
      this.validateTag(node)
    } else {
      this.validateTag(node.tag)
      for (let ch of node.content) this.validate(ch)
    }
  }

  /// @internal
  validateTag(tag: Node | Plot.Tag.Any) {
    if (this.tagsByName[tag.name] != tag.type)
      throw new Error(`Tag type ${tag.name} not in schema`)
    for (let prop of tag.props) this.validateProp(prop)
  }

  /// @internal
  validateProp(prop: Prop<any>) {
    if (this.propsByName[prop.name] != prop.type)
      throw new Error(`Prop type ${prop.name} not in schema`)
  }

  // FIXME maybe have a different one for plot types
  defaultContentType(parent: Plot.Type<any>) {
    for (let tag of this.tags) if (parent.canContain(tag) && tag.default) return tag.default
    return null
  }

  createDefault(parent: Plot.Type<any>): Node {
    let child = this.defaultContentType(parent)
    if (!child) throw new Error(`No defaultable child node for ${parent.name}`)
    if (child.isLeaf) return child
    return child.create(child.inlineContent ? [] : [this.createDefault(child.type)])
  }

  findWrapping(parent: Plot.Type<any>, child: Node.Type<any>): readonly Plot.Tag.Any[] | null {
    let key = `${parent.name}-${child.name}`, cached = this.wrappingCache[key]
    if (cached !== undefined) return cached
    return this.wrappingCache[key] = this.findWrappingInner(parent, child)
  }

  private findWrappingInner(parent: Plot.Type<any>, child: Node.Type<any>): readonly Plot.Tag.Any[] | null {
    let seen: Set<Node.Type<unknown>> = new Set, work: Plot.Tag.Any[][] = [[]]
    for (let i = 0; i < work.length; i++) {
      let path = work[i], at = path.length ? path[path.length - 1].type : parent
      for (let tag of this.tags) if (at.canContain(tag)) {
        if (tag == child) return path
        if (!seen.has(tag) && !tag.isLeaf && tag.default) {
          seen.add(tag)
          work.push(path.concat(tag.default))
        }
      }
    }
    return null
  }

  getProp(name: string): Prop.Type<any> | undefined { return this.propsByName[name] }

  static define(spec: readonly SchemaElement[]) {
    for (let cached of schemaCache)
      if (cached.elements.length == spec.length && cached.elements.every((e, i) => e == spec[i]))
        return cached

    let tags: Node.Type<any>[] = [Leaf.Text], props: Prop.Type<unknown>[] = []
    let defaultI = 0
    let tagNames: Set<string> = new Set, propNames: Set<string> = new Set
    for (let elt of spec) {
      if (elt instanceof Plot.Tag || elt instanceof Leaf || elt instanceof Prop) elt = elt.type
      if (elt instanceof Plot.Type || elt instanceof Leaf.Type) {
        if (tags.includes(elt)) continue
        if (tagNames.has(elt.name)) throw new Error(`Duplicate use of tag name ${elt.name} in schema`)
        tagNames.add(elt.name)
        if (!elt.isLeaf && elt.spec.defaultBlock) tags.splice(defaultI++, 0, elt)
        else tags.push(elt)
      } else if (elt instanceof Prop.Type) {
        if (props.includes(elt)) continue
        if (propNames.has(elt.name)) throw new Error(`Duplicate use of prop name ${elt.name} in schema`)
        propNames.add(elt.name)
        props.push(elt as any)
      } else {
        throw new Error("Unexpected schema element type. You may have multiple versions of @wordgard/doc loaded")
      }
    }
    let docTag: Plot.Type<Schema> | null = null
    let lineBreak: Leaf<any> | null = null
    for (let tag of tags) {
      if (tag.isLeaf) {
        if (tag.spec.isLineBreak) {
          if (tag.isBlock || !tag.default)
            throw new Error("Line break tags must be inline leaves with a default param")
          if (lineBreak) throw new Error("Multiple line break tags provided")
          lineBreak = tag.default
        }
      } else {
        if (tag.isDoc) docTag = tag
        let sawDefaultable = false
        for (let child of tags) if (tag.canContain(child)) {
          if (child.default) sawDefaultable = true
          if (child.isInline != tag.inlineContent)
            throw new Error(`Node type ${tag.name} has ${tag.inlineContent ? "block" : "inline"
                              } content, but allows ${child.name} as a child`)
        }
        if (!tag.inlineContent && !sawDefaultable)
          throw new Error(`Node ${tag.name} has block content, but all possible children require non-default props`)
      }
    }
    if (!docTag) throw new Error("A schema must define a document tag")
    let schema = new Schema(tags, props, docTag, lineBreak as Leaf<unknown> | null)
    schemaCache.add(schema)
    return schema
  }

  append(other: Schema | readonly SchemaElement[]) {
    let add: SchemaElement[] = []
    for (let elt of (other instanceof Schema ? other.elements : other)) {
      if (elt instanceof Leaf || elt instanceof Plot.Tag || elt instanceof Prop) elt = elt.type
      if ((elt instanceof Prop.Type ? this.propsByName : this.tagsByName)[elt.name] != elt) add.push(elt)
    }
    return add.length ? Schema.define(this.elements.concat(add)) : this
  }

  nodeFromJSON(json: Node.JSON): Node {
    let tag = this.tagFromJSON(json), children = none
    if (tag.isLeaf) return tag
    if (json.content && Array.isArray(json.content))
      children = json.content.map(c => this.nodeFromJSON(c))
    if (tag.type.isDoc) return this.doc(children)
    return tag.create(children)
  }

  tagFromJSON(json: Node.JSON) {
    if (!json || typeof json != "object" || !(json.type in this.tagsByName))
      throw new Error("Invalid tag JSON")
    let type = this.tagsByName[json.type]
    let props = json.props ? this.propsFromJSON(json.props) : none
    let tag = "param" in json ? type.of(validate(type.spec.validateParam, json.param), props)
      : !type.default ? null
      : props.length ? type.of(type.default.param, props) : type.default
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

  docFromJSON(json: Node.JSON) {
    if (!json || json.type != this.docTag.name)
      throw new Error("Invalid document JSON")
    return this.nodeFromJSON(json) as Plot.Doc
  }
}

export const Paragraph = Plot.defineBlock("Paragraph", {
  inlineContent: true,
  group: "Block",
  defaultBlock: true,
  shape: {element: "p"}
})

export const Heading = Plot.Type.defineBlock("Heading", {
  defaultParam: 1,
  validateParam: "number",
  inlineContent: true,
  group: "Block",
  shape: {structure: level => elt("h" + level, 0), atom: false},
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

export const CodeBlock = Plot.defineBlock("CodeBlock", {
  inlineContent: true,
  group: "Block",
  shape: {element: "pre"},
  preserveWhitespace: true
})

export const CodeBlockLanguage = Prop.Type.define("CodeBlockLanguage", {
  tags: "CodeBlock",
  validate: "string",
  shape: {attribute: "data-language", readAttribute: x => x}
})

export const Blockquote = Plot.defineBlock("Blockquote", {
  blockContent: "Block",
  group: "Block",
  shape: {element: "blockquote"},
  autoJoin: true
})

export const OrderedList = Plot.Type.defineBlock("OrderedList", {
  defaultParam: 1,
  validateParam: "number",
  blockContent: "ListItem",
  group: "Block",
  isList: true,
  shape: {
    element: "ol",
    attributes: order => order == 1 ? {} as Record<string, string> : {order: String(order)},
    readElement: elt => Number(elt.getAttribute("order") || "1")
  },
  autoJoin: (a, b) => b.param == 1
})

export const BulletList = Plot.defineBlock("BulletList", {
  blockContent: "ListItem",
  group: "Block",
  isList: true,
  shape: {element: "ul"},
  autoJoin: true
})

export const ListItem = Plot.defineBlock("ListItem", {
  blockContent: "Block",
  shape: {element: "li"},
  defining: true,
})

export const HorizontalRule = Leaf.defineBlock("HorizontalRule", {
  group: "Block",
  shape: {element: "hr"},
  toText: () => "---"
})

export const Image = Leaf.Type.defineInline<string>("Image", {
  validateParam: "string",
  shape: {element: "img", attributes: src => ({src}), readElement: elt => (elt as HTMLImageElement).src || Reject}
})

export const ImageAlt = Prop.Type.define<string>("ImageAlt", {
  tags: "Image",
  validate: "string",
  shape: {attribute: "alt", readAttribute: x => x}
})

export const LineBreak = Leaf.defineInline("LineBreak", {
  isLineBreak: true,
  toText: () => "\n",
  shape: {element: "br"}
})

export const Emphasis = Prop.define("Emphasis", {
  rank: 40,
  shape: {element: "em"},
  parseRules: [
    {attribute: "style/font-style", value: "italic"},
    {attribute: "style/font-style", value: "normal", clearProp: p => p.name == "Emphasis"}
  ]
})

export const Strong = Prop.define("Strong", {
  rank: 60,
  shape: {element: "strong"},
  parseRules: [
    {attribute: "style/font-weight",
     readAttribute: value => /^(bold(er)?|[5-9]\d{2,})$/.test(value) ? null : Reject},
    {attribute: "style/font-weight",
     readAttribute: value => /^(normal|lighter|[1-4]\d{2})$/.test(value) ? null : Reject,
     clearProp: p => p.name == "Strong"},
  ]
})

export const Link = Prop.Type.define<string>("Link", {
  rank: 20,
  validate: "string",
  shape: {
    element: "a",
    selector: "a[href]",
    attributes: href => ({href}),
    readElement: dom => (dom as HTMLLinkElement).href
  },
})

export const Code = Prop.define("Code", {
  rank: 80,
  shape: {element: "code"}
})

export const Doc = Plot.defineDoc({
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
