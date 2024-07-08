import {Node, DocNode, NodeType, Mark, MarkType} from "./node"
import {pushNode} from "./slice"
import {Schema, basicSchema} from "./schema"
import {Paragraph, Heading, CodeBlock, Image, LineBreak,
        Blockquote, OrderedList, BulletList, ListItem, HorizontalRule,
        Emphasis, Strong, Code, Link} from "./schema"

type ContentSpec = Node | string | number | null | readonly ContentSpec[]

export type NodeBuilder<Attrs> = {
  (attrs: Partial<Attrs>, ...children: ContentSpec[]): Node
  (...children: ContentSpec[]): Node
}

export type BuilderAttrs<T> = T extends NodeType<infer Attrs> | MarkType<infer Attrs> ? Attrs : {}

export function builder<T extends {[name: string]: NodeType | Node | Mark | MarkType}>(spec: T, schema?: Schema): {
  [name in keyof T]: NodeBuilder<BuilderAttrs<T[name]>>
} & {doc(...children: ContentSpec[]): DocNode} {
  let result = Object.create(null)
  for (let name in spec) {
    let val = spec[name]
    result[name] = val instanceof Mark ? markBuilder(val.type, val.params)
      : val instanceof MarkType ? markBuilder(val, {})
      : val instanceof Node ? nodeBuilder(val.type, val.params)
      : nodeBuilder(val, {})
  }
  result.doc = (...children: ContentSpec[]) => {
    if (!schema) throw new Error("This builder does not have a schema")
    return schema.doc(collectChildren(children))
  }
  return result
}

function nodeBuilder<Params extends {}>(type: NodeType<Params>, given: Partial<Params>): NodeBuilder<Params> {
  return (paramsOrChild?: ContentSpec | Partial<Params>, ...children: ContentSpec[]) => {
    let params = given
    if (paramsOrChild != null) {
      if (Array.isArray(paramsOrChild) || typeof paramsOrChild != "object" || paramsOrChild instanceof Node)
        children.unshift(paramsOrChild)
      else
        params = {...params, ...paramsOrChild as Partial<Params>}
    }
    return type.create(params, collectChildren(children))
  }
}

const Fragment = NodeType.inline("Fragment", {
  tag: "span",
  content: "Inline"
})

function markBuilder<Params extends {}>(type: MarkType, given: Partial<Params>): NodeBuilder<Params> {
  return (paramsOrChild?: ContentSpec | Partial<Params>, ...children: ContentSpec[]) => {
    let params = given
    if (paramsOrChild) {
      if (Array.isArray(paramsOrChild) || typeof paramsOrChild != "object" || paramsOrChild instanceof Node)
        children.unshift(paramsOrChild as ContentSpec)
      else
        params = {...params, ...paramsOrChild as Partial<Params>}
    }
    return Fragment.create(collectChildren(children, type.create(params)))
  }
}

const tagMap = new WeakMap<readonly Node[], {[label: number]: number}>()

function addMark(node: Node, mark?: Mark) {
  return mark ? node.mark(mark.addToSet(node.marks)) : node
}

function collectChildren(spec: ContentSpec, mark?: Mark, list: Node[] = []) {
  if (Array.isArray(spec)) {
    for (let elt of spec) collectChildren(elt, mark, list)
  } else if (typeof spec == "string") {
    pushNode(list, addMark(Node.text(spec), mark))
  } else if (spec instanceof Node) {
    if (spec.type == Fragment) {
      copyTags(spec.children, list, 0)
      for (let ch of spec.children) collectChildren(ch, mark, list)
    } else {
      copyTags(spec.children, list, 1)
      pushNode(list, addMark(spec, mark))
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

export const basicBuilder = builder({
  p: Paragraph,
  h1: Heading.create({level: 1}),
  h2: Heading.create({level: 2}),
  h3: Heading.create({level: 3}),
  h4: Heading.create({level: 4}),
  pre: CodeBlock,
  img: Image,
  $img: Image.create({src: "test.png"}),
  br: LineBreak,
  blockquote: Blockquote,
  ol: OrderedList,
  ul: BulletList,
  li: ListItem,
  hr: HorizontalRule,
  em: Emphasis,
  strong: Strong,
  code: Code,
  a: Link,
  $a: Link.create({href: "/"})
}, basicSchema)
