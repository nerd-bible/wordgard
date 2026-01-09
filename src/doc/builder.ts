import {Plot, Leaf, Node} from "./node"
import {Prop} from "./prop"
import {Schema, basicSchema} from "./schema"
import {Paragraph, Heading, CodeBlock, CodeBlockLanguage, Image, ImageAlt, LineBreak,
        Blockquote, OrderedList, BulletList, ListItem, HorizontalRule,
        Emphasis, Strong, Code, Link} from "./schema"

export type ContentSpec = Node | string | number | null | readonly ContentSpec[]

export function builder<Param>(from: Leaf<Param>): Leaf<Param>
export function builder<Param>(from: Leaf.Type<Param>): (param: Param) => Leaf.Any
export function builder(from: Plot.Tag.Any): (...children: ContentSpec[]) => Plot
export function builder<Param>(from: Plot.Type<Param>): (param: Param, ...children: ContentSpec[]) => Plot
export function builder<Param>(from: Prop<Param>): (...children: ContentSpec[]) => Plot
export function builder<Param>(from: Prop.Type<Param>): (param: Param, ...children: ContentSpec[]) => Plot
export function builder(from: Schema): (...children: ContentSpec[]) => Plot.Doc
export function builder(
  from: Prop<any> | Prop.Type<any> | Node.Type<any> | Leaf.Any | Plot.Tag.Any | Schema
): any {
  return (from instanceof Plot.Tag
    ? (...children: ContentSpec[]) => from.create(collectChildren(children))
    : from instanceof Prop
    ? (...children: ContentSpec[]) => fragment(children, from)
    : from instanceof Plot.Type
    ? (param: any, ...children: ContentSpec[]) => from.of(param).create(collectChildren(children))
    : from instanceof Leaf.Type
    ? (param: any) => from.of(param)
    : from instanceof Leaf
    ? from
    : from instanceof Schema
    ? (...children: ContentSpec[]) => from.doc(collectChildren(children))
    : (value: any, ...children: ContentSpec[]) => fragment(children, (from as any as Prop.Type<any>).of(value))
  )
}

const InlineFragment = Plot.defineInline("Fragment", {
  shape: {element: "span"},
  inlineContent: true
})
const BlockFragment = Plot.defineBlock("Fragment", {
  shape: {element: "div"},
  blockContent: "_"
})

function fragment(children: ContentSpec[], prop: Prop) {
  let chs = collectChildren(children, prop)
  return (chs.length && chs[0].isBlock ? BlockFragment : InlineFragment).create(chs)
}
  
const tagMap = new WeakMap<readonly Node[], {[label: number]: number}>()

function addProp(node: Node, prop?: Prop) {
  return prop ? node.withProps(prop.addToSet(node.props)) : node
}

function collectChildren(spec: ContentSpec, prop?: Prop, list: Node[] = []) {
  if (Array.isArray(spec)) {
    for (let elt of spec) collectChildren(elt, prop, list)
  } else if (typeof spec == "string") {
    addProp(Leaf.text(spec), prop).pushTo(list)
  } else if (spec instanceof Plot) {
    if (spec.tag == InlineFragment || spec.tag == BlockFragment) {
      copyTags(spec.content, list, 0)
      for (let ch of spec.content) collectChildren(ch, prop, list)
    } else {
      copyTags(spec.content, list, 1)
      addProp(spec, prop).pushTo(list)
    }
  } else if (spec instanceof Leaf) {
    addProp(spec, prop).pushTo(list)
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

export function maybeTag(node: Plot, id: number): number | undefined {
  let tags = tagMap.get(node.content)
  return tags && tags[id]
}

export function tag(node: Plot, id: number): number {
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
