import {Node, TextNode, DocNode} from "./node"

export interface Walker {
  skip(node: Node): void
  enter(node: Node): void
  leave(): void
}

export class Context {
  constructor(
    readonly node: Node,
    readonly index: number,
    readonly pos: number,
    readonly inText: number,
    readonly parent: Context | null
  ) {}

  advance(distance: number, walk?: Walker) {
    return distance ? advanceContext(distance, this.node, this.index, this.pos, this.inText, this.parent, walk) : this
  }

  get start() {
    return this.parent ? this.parent.pos + 1 : 0
  }

  get end() {
    return this.start + this.node.contentLength
  }

  get before() {
    if (!this.parent) throw new Error("Reading Context.before on a top-level context")
    return this.parent.pos
  }

  get after() {
    if (!this.parent) throw new Error("Reading Context.after on a top-level context")
    return this.parent.pos + this.node.length
  }

  get depth() {
    let d = 0
    for (let c = this.parent; c; c = c.parent) d++
    return d
  }

  static atStart(doc: DocNode) {
    return new Context(doc, 0, 0, 0, null)
  }

  static resolve(doc: DocNode, pos: number) {
    let cache = contextCache.get(doc)
    if (!cache) contextCache.set(doc, cache = [])
    else for (let i = 0; i < cache.length; i++) if (cache[i].pos == pos) return cache[i]
    return cache[cache.length < cacheSize ? cache.length : cachePos = (cachePos + 1) % cacheSize] =
      advanceContext(pos, doc, 0, 0, 0, null)
  }
}

let contextCache = new Map<DocNode, Context[]>(), cacheSize = 8, cachePos = 0

function advanceContext(distance: number, node: Node, index: number,
                    pos: number, inText: number, parent: Context | null,
                    walk?: Walker) {
  let target = pos + distance
  if (inText) {
    let text = node.children[index] as TextNode
    let textStart = pos - inText, textEnd = textStart + text.length
    if (walk) walk.skip(text.cut(inText, Math.min(node.length, target - textStart)))
    if (target < textEnd)
      return new Context(node, index, target, target - textStart, parent)
    pos = textEnd
    index++
  }
  while (pos < target) {
    if (index == node.children.length) {
      if (!parent) throw new Error("Moving past end of document")
      if (walk) walk.leave()
      ;({node, index, parent} = parent)
      index++
      pos++
    } else {
      let next = node.children[index], end = pos + next.length
      if (target >= end) {
        if (walk) walk.skip(next)
        pos = end
        index++
      } else if (next.isText()) {
        if (walk) walk.skip(next.cut(0, target - pos))
        return new Context(node, index, target, target - pos, parent)
      } else {
        if (walk) walk.enter(next)
        parent = new Context(node, index, pos, 0, parent)
        pos++
        node = next
        index = 0
      }
    }
  }
  return new Context(node, index, pos, 0, parent)
}
