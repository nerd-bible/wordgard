import {Node, DocNode, Tag, TagType} from "./node"
import {PropType, Prop} from "./prop"
import {Schema, basicSchema} from "./schema"
import {Paragraph, Heading, CodeBlock, CodeBlockLanguage, Image, ImageAlt, LineBreak,
        Blockquote, OrderedList, BulletList, ListItem, HorizontalRule,
        Emphasis, Strong, Code, Link} from "./schema"

type ContentSpec = Node | string | number | null | readonly ContentSpec[]

export type NodeBuilder<Source> =
  Source extends Prop<any> | Tag<any> ? (...children: ContentSpec[]) => Node :
  Source extends PropType<infer Value> ? (value: Value, ...children: ContentSpec[]) => Node :
  Source extends TagType<infer Param> ? (param: Param, ...children: ContentSpec[]) => Node :
  Source extends Schema ? (...children: ContentSpec[]) => DocNode :
  never

export function builder<Source extends Prop<any> | Tag<any> | PropType<any> | TagType<any> | Schema>(
  source: Source
): NodeBuilder<Source> {
  return (source instanceof Tag
    ? (...children: ContentSpec[]) => source.create(collectChildren(children))
    : source instanceof Prop
    ? (...children: ContentSpec[]) => fragment(children, source)
    : source instanceof TagType
    ? (param: any, ...children: ContentSpec[]) => source.of(param).create(collectChildren(children))
    : source instanceof Schema
    ? (...children: ContentSpec[]) => source.doc(collectChildren(children))
    : (value: any, ...children: ContentSpec[]) => fragment(children, source.of(value))
  ) as any
}

const InlineFragment = Tag.defineInline("Fragment", {
  dom: {element: "span"},
  inlineContent: true
})
const BlockFragment = Tag.defineBlock("Fragment", {
  dom: {element: "div"},
  blockContent: "_"
})

function fragment(children: ContentSpec[], prop: Prop) {
  let chs = collectChildren(children, prop)
  return (chs.length && chs[0].isBlock() ? BlockFragment : InlineFragment).create(chs)
}
  
const tagMap = new WeakMap<readonly Node[], {[label: number]: number}>()

function addProp(node: Node, prop?: Prop) {
  return prop ? node.tag.addProp(prop).create(node.children) : node
}

function collectChildren(spec: ContentSpec, prop?: Prop, list: Node[] = []) {
  if (Array.isArray(spec)) {
    for (let elt of spec) collectChildren(elt, prop, list)
  } else if (typeof spec == "string") {
    addProp(Node.text(spec), prop).pushTo(list)
  } else if (spec instanceof Node) {
    if (spec.tag == InlineFragment || spec.tag == BlockFragment) {
      copyTags(spec.children, list, 0)
      for (let ch of spec.children) collectChildren(ch, prop, list)
    } else {
      copyTags(spec.children, list, 1)
      addProp(spec, prop).pushTo(list)
    }
  } else if (typeof spec == "number") {
    let tags = tagMap.get(list)
    if (!tags) tagMap.set(list, tags = Object.create(null))
    tags![spec] = contentLength(list)
  }
  return list
}

function copyTags(source: readonly Node[], dest: readonly Node[], extraOffset: number) {
  let srcTags = tagMap.get(source)
  if (srcTags) {
    let destTags = tagMap.get(dest)
    if (!destTags) tagMap.set(dest, destTags = Object.create(null))
    let off = contentLength(dest) + extraOffset
    for (let id in srcTags) destTags![id] = srcTags[id] + off
  }
}

function contentLength(nodes: readonly Node[]) {
  return nodes.reduce((l, n) => l + n.length, 0)
}

export function maybeTag(node: Node, id: number): number | undefined {
  let tags = tagMap.get(node.children)
  return tags && tags[id]
}

export function tag(node: Node, id: number): number {
  let value = maybeTag(node, id)
  if (value == null) throw new Error(`Undefined tag ${id}`)
  return value
}

export const basicBuilders = {
  doc: builder(basicSchema),
  p: builder(Paragraph),
  h1: builder(Heading.of(1)),
  h2: builder(Heading.of(2)),
  h3: builder(Heading.of(3)),
  h4: builder(Heading.of(4)),
  pre: builder(CodeBlock),
  preLang: builder(CodeBlockLanguage),
  img: builder(Image),
  $img: builder(Image.of("test.png")),
  imgAlt: builder(ImageAlt),
  br: builder(LineBreak),
  blockquote: builder(Blockquote),
  ol: builder(OrderedList.default!),
  olOrder: builder(OrderedList),
  ul: builder(BulletList),
  li: builder(ListItem),
  hr: builder(HorizontalRule),
  em: builder(Emphasis),
  strong: builder(Strong),
  code: builder(Code),
  a: builder(Link),
  $a: builder(Link.of("/")),
}
