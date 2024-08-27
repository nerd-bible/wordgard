import {Node, DocNode, Tag, PropType, Prop, PropSet} from "./node"
import {pushNode} from "./slice"
import {Schema, basicSchema} from "./schema"
import {Paragraph, Heading, CodeBlock, Image, LineBreak,
        Blockquote, OrderedList, BulletList, ListItem, HorizontalRule,
        Emphasis, Strong, Code, Link} from "./schema"

type ContentSpec = Node | string | number | null | readonly ContentSpec[]

export type NodeBuilder<Source> =
  Source extends Node | Prop | Tag<null> ? (...children: ContentSpec[]) => Node :
  Source extends PropType<infer Value> ? (value: Value, ...children: ContentSpec[]) => Node :
  Source extends Tag<infer Param> ? (param: Param, ...children: ContentSpec[]) => Node :
  never

export function builder<T extends {[name: string]: Tag<any> | Node | PropType<any> | Prop}>(spec: T, schema?: Schema): {
  [name in keyof T]: NodeBuilder<T[name]>
} & {doc(...children: ContentSpec[]): DocNode} {
  let result = Object.create(null)
  for (let name in spec) {
    let val = spec[name]
    result[name] = val instanceof Prop ? propInstanceBuilder(val)
      : val instanceof PropType ? propBuilder(val)
      : val instanceof Node ? nodeBuilder(val.tag, val.props)
      : nodeBuilder(val, PropSet.empty)
  }
  result.doc = (...children: ContentSpec[]) => {
    if (!schema) throw new Error("This builder does not have a schema")
    return schema.doc(collectChildren(children))
  }
  return result
}

function nodeBuilder<Param>(type: Tag<Param>, props: PropSet): any {
  if (type.needsParam())
    return (param: Param, ...children: ContentSpec[]) => type.withParam(param).create(props, collectChildren(children))
  return (...children: ContentSpec[]) => type.create(props, collectChildren(children))
}

const Fragment = Tag.inline("Fragment", {
  dom: {tag: "span"},
  content: "_"
})

function propBuilder<Value>(type: PropType<Value>): NodeBuilder<PropType<Value>> {
  return (value: Value, ...children: ContentSpec[]) =>
    Fragment.create(collectChildren(children, type.of(value)))
}

function propInstanceBuilder(prop: Prop): NodeBuilder<Prop> {
  return (...children: ContentSpec[]) => Fragment.create(collectChildren(children, prop))
}

const tagMap = new WeakMap<readonly Node[], {[label: number]: number}>()

function addProp(node: Node, prop?: Prop) {
  return prop ? node.withProps(node.props.add(prop)) : node
}

function collectChildren(spec: ContentSpec, prop?: Prop, list: Node[] = []) {
  if (Array.isArray(spec)) {
    for (let elt of spec) collectChildren(elt, prop, list)
  } else if (typeof spec == "string") {
    pushNode(list, addProp(Node.text(spec), prop))
  } else if (spec instanceof Node) {
    if (spec.tag == Fragment) {
      copyTags(spec.children, list, 0)
      for (let ch of spec.children) collectChildren(ch, prop, list)
    } else {
      copyTags(spec.children, list, 1)
      pushNode(list, addProp(spec, prop))
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
  h1: Heading.createWith({level: 1}),
  h2: Heading.createWith({level: 2}),
  h3: Heading.createWith({level: 3}),
  h4: Heading.createWith({level: 4}),
  pre: CodeBlock,
  img: Image,
  $img: Image.createWith({src: "test.png"}),
  br: LineBreak,
  blockquote: Blockquote,
  ol: OrderedList.createWith({start: 1}),
  ul: BulletList,
  li: ListItem,
  hr: HorizontalRule,
  em: Emphasis,
  strong: Strong,
  code: Code,
  a: Link,
  $a: Link.of({href: "/"})
}, basicSchema)
