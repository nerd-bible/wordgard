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
  never

export function builder<Source extends Prop<any> | Tag<any> | PropType<any> | TagType<any>>(
  source: Source
): NodeBuilder<Source> {
  return (source instanceof Tag
    ? (...children: ContentSpec[]) => source.create(collectChildren(children))
    : source instanceof Prop
    ? (...children: ContentSpec[]) => fragment(children, source)
    : source instanceof TagType
    ? (param: any, ...children: ContentSpec[]) => source.of(param).create(collectChildren(children))
    : (value: any, ...children: ContentSpec[]) => fragment(children, source.of(value))
  ) as any
}

// FIXME possibly per-builder constructor functions are easier to type
// and understand?
export function builders<T extends {[name: string]: Parameters<typeof builder>[0]}>(spec: T, schema?: Schema): {
  [name in keyof T]: NodeBuilder<T[name]>
} & {doc(...children: ContentSpec[]): DocNode} {
  let result = Object.create(null)
  for (let name in spec) result[name] = builder(spec[name])
  result.doc = (...children: ContentSpec[]) => {
    if (!schema) throw new Error("This builder does not have a schema")
    return schema.doc(collectChildren(children))
  }
  return result
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

export const basicBuilder = builders({
  p: Paragraph,
  h1: Heading.of(1),
  h2: Heading.of(2),
  h3: Heading.of(3),
  h4: Heading.of(4),
  pre: CodeBlock,
  preLang: CodeBlockLanguage,
  img: Image,
  $img: Image.of("test.png"),
  imgAlt: ImageAlt,
  br: LineBreak,
  blockquote: Blockquote,
  ol: OrderedList.default!,
  olOrder: OrderedList,
  ul: BulletList,
  li: ListItem,
  hr: HorizontalRule,
  em: Emphasis,
  strong: Strong,
  code: Code,
  a: Link,
  $a: Link.of("/")
}, basicSchema)
