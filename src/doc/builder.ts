import {Plot, Leaf, Part} from "./node"
import {Prop} from "./prop"
import {Schema, basicSchema} from "./schema"
import {Paragraph, Heading, CodeBlock, CodeBlockLanguage, Image, ImageAlt, LineBreak,
        Blockquote, OrderedList, BulletList, ListItem, HorizontalRule,
        Emphasis, Strong, Code, Link} from "./schema"

type ContentSpec = Part | string | number | null | readonly ContentSpec[]

export type NodeBuilder<Source> =
  Source extends Prop<any> | Plot.Label.Any ? (...children: ContentSpec[]) => Plot :
  Source extends Prop.Type<infer Value> ? (value: Value, ...children: ContentSpec[]) => Plot :
  Source extends Plot.Type<infer Param> ? (param: Param, ...children: ContentSpec[]) => Plot :
  Source extends Leaf.Any ? () => Leaf.Any : // FIXME make these values, not functions?
  Source extends Leaf.Type<infer Param> ? (param: Param) => Leaf<Param> :
  Source extends Schema ? (...children: ContentSpec[]) => Plot.Doc :
  never

export function builder<Source extends Prop<any> | Prop.Type<any> | Part.Type<any> | Leaf.Any | Plot.Label.Any | Schema>(
  source: Source
): NodeBuilder<Source> {
  return (source instanceof Plot.Label
    ? (...children: ContentSpec[]) => source.create(collectChildren(children))
    : source instanceof Prop
    ? (...children: ContentSpec[]) => fragment(children, source)
    : source instanceof Plot.Type
    ? (param: any, ...children: ContentSpec[]) => source.of(param).create(collectChildren(children))
    : source instanceof Leaf.Type
    ? (param: any) => source.of(param)
    : source instanceof Leaf
    ? (param: any) => source
    : source instanceof Schema
    ? (...children: ContentSpec[]) => source.doc(collectChildren(children))
    : (value: any, ...children: ContentSpec[]) => fragment(children, (source as any as Prop.Type<any>).of(value))
  ) as any
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
  
const tagMap = new WeakMap<readonly Part[], {[label: number]: number}>()

function addProp(part: Part, prop?: Prop) {
  return prop ? part.withProps(prop.addToSet(part.label.props)) : part
}

function collectChildren(spec: ContentSpec, prop?: Prop, list: Plot[] = []) {
  if (Array.isArray(spec)) {
    for (let elt of spec) collectChildren(elt, prop, list)
  } else if (typeof spec == "string") {
    addProp(Leaf.text(spec), prop).pushTo(list)
  } else if (spec instanceof Plot) {
    if (spec.label == InlineFragment || spec.label == BlockFragment) {
      copyTags(spec.content, list, 0)
      for (let ch of spec.content) collectChildren(ch, prop, list)
    } else {
      copyTags(spec.content, list, 1)
      addProp(spec, prop).pushTo(list)
    }
  } else if (typeof spec == "number") {
    let tags = tagMap.get(list)
    if (!tags) tagMap.set(list, tags = Object.create(null))
    tags![spec] = contentLength(list)
  }
  return list
}

function copyTags(source: readonly Part[], dest: readonly Plot[], extraOffset: number) {
  let srcTags = tagMap.get(source)
  if (srcTags) {
    let destTags = tagMap.get(dest)
    if (!destTags) tagMap.set(dest, destTags = Object.create(null))
    let off = contentLength(dest) + extraOffset
    for (let id in srcTags) destTags![id] = srcTags[id] + off
  }
}

function contentLength(nodes: readonly Plot[]) {
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
