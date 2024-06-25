import {Node, NodeType, Mark, MarkType} from "./node"

type ContentSpec = Node | string | number | null | readonly ContentSpec[]

export type NodeBuilder<Attrs> = {
  (attrs: Partial<Attrs>, ...children: ContentSpec[]): Node
  (...children: ContentSpec[]): Node
}

export function builder<T extends {[name: string]: NodeType | Node | Mark | MarkType}>(spec: T): {
  [name in keyof T]: NodeBuilder<T[name] extends NodeType<infer Attrs> | MarkType<infer Attrs> ? Attrs : {}>
} {
  let result = Object.create(null)
  for (let name in spec) {
    let val = spec[name]
    result[name] = val instanceof Mark ? markBuilder(val.type, val.attrs)
      : val instanceof MarkType ? markBuilder(val, {})
      : val instanceof Node ? nodeBuilder(val.type, val.attrs)
      : nodeBuilder(val, {})
  }
  return result
}

function nodeBuilder<Attrs extends {}>(type: NodeType<Attrs>, given: Partial<Attrs>): NodeBuilder<Attrs> {
  return (attrsOrChild?: ContentSpec | Partial<Attrs>, ...children: ContentSpec[]) => {
    let attrs = given
    if (attrsOrChild) {
      if (Array.isArray(attrsOrChild) || typeof attrsOrChild != "object" || attrsOrChild instanceof Node)
        children.unshift(attrsOrChild)
      else
        attrs = {...attrs, ...attrsOrChild as Partial<Attrs>}
    }
    return type.create(attrs, collectChildren(children))
  }
}

const Fragment = NodeType.inline("Fragment", {
  tag: "span",
  content: "Inline"
})

function markBuilder<Attrs extends {}>(type: MarkType, given: Partial<Attrs>): NodeBuilder<Attrs> {
  return (attrsOrChild?: ContentSpec | Partial<Attrs>, ...children: ContentSpec[]) => {
    let attrs = given
    if (attrsOrChild) {
      if (Array.isArray(attrsOrChild) || typeof attrsOrChild != "object" || attrsOrChild instanceof Node)
        children.unshift(attrsOrChild as ContentSpec)
      else
        attrs = {...attrs, ...attrsOrChild as Partial<Attrs>}
    }
    return Fragment.create(collectChildren(children, type.create(attrs)))
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
    list.push(addMark(Node.text(spec), mark))
  } else if (spec instanceof Node) {
    if (spec.type == Fragment) {
      copyTags(spec.children, list, 0)
      for (let ch of spec.children) collectChildren(ch, undefined, list)
    } else {
      copyTags(spec.children, list, 1)
      list.push(addMark(spec, mark))
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
