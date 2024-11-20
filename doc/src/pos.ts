import {Tag, Node, TextNode, DocNode} from "./node"
import {Prop} from "./prop"
import {none} from "./helper"

export interface Walker {
  skip(node: Node): void
  enter(tag: Tag): void | boolean
  leave(): void
}

export class Pos {
  constructor(
    readonly parent: NodePos,
    readonly pos: number,
    readonly index: number,
    readonly inText: number
  ) {}

  advance(distance: number, walk?: Walker) {
    return distance ? advancePos(distance, this.parent, this.pos, this.index, this.inText, walk) : this
  }

  walk(distance: number, walk?: Walker) {
    return distance ? advancePos(distance, this.parent, this.pos, this.index, this.inText, walk, true) : this
  }

  get nodeAfter() {
    if (this.index == this.parent.node.children.length) return null
    let node = this.parent.node.children[this.index]
    return this.inText && node.isText() ? node.cutText(this.inText) : node
  }

  get nodeBefore() {
    if (this.inText) return (this.parent.node.children[this.index] as TextNode).cutText(0, this.inText)
    return this.index ? this.parent.node.children[this.index - 1] : null
  }

  get textblockParent() {
    for (let p: NodePos | null = this.parent;; p = p.parent) {
      if (!p || !p.node.inlineContent()) return null
      if (p.node.isTextblock()) return p
    }
  }

  isAtStart(parent: NodePos) {
    if (this.inText) return false
    for (let p: NodePos | null = this.parent, index = this.index;; index = p.index, p = p.parent) {
      if (!p || index) return false
      if (p == parent) return true
    }
  }

  isAtEnd(parent: NodePos) {
    if (this.inText) return false
    for (let p: NodePos | null = this.parent, index = this.index;; index = p.index + 1, p = p.parent) {
      if (!p || index < p.node.children.length) return false
      if (p == parent) return true
    }
  }

  get depth() { return this.parent.depth }

  get doc() { return this.parent.doc }

  props(across?: Pos) {
    if (this.inText && !across) return this.parent.node.children[this.index].tag.props
    let [from, to] = !across ? [this, this] : across.pos > this.pos ? [this, across] : [across, this]
    let before = from.nodeBefore, after = to.nodeAfter
    let [main, sec]: [readonly Prop[], readonly Prop[]] =
      before ? [before.tag.props, after ? after.tag.props : none] : [after ? after.tag.props : none, none]
    return main.filter(p => p.type.spanning && (p.type.inclusive || p.isInSet(sec)))
  }

  static atStart(doc: DocNode) {
    return new Pos(cacheFor(doc).top, 0, 0, 0)
  }

  static resolve(doc: DocNode, pos: number): Pos {
    if (pos < 0 || pos > doc.length) throw new RangeError(`Resolving invalid position ${pos}`)
    let {top, cache} = cacheFor(doc), nearest: Pos | undefined, nearestDist = 0, result
    for (let elt of cache) {
      if (elt.pos == pos) return elt
      let dist = Math.abs(elt.pos - pos)
      if (!nearest || dist < nearestDist) {
        nearest = elt
        nearestDist = dist
      }
    }
    if (nearest) {
      let {parent} = nearest
      while (parent.start > pos || parent.end < pos) parent = parent.parent!
      result = advancePos(pos - parent.start, parent, parent.start, 0, 0)
    } else {
      result = advancePos(pos, top, 0, 0, 0)
    }
    return cache[cache.length < cacheSize ? cache.length : cachePos = (cachePos + 1) % cacheSize] = result
  }

  static resolveNode(doc: DocNode, pos: number) {
    let base = this.resolve(doc, pos)
    if (base.inText) return null
    let after = base.nodeAfter
    return after && !after.isText() ? new NodePos(base.parent, after, pos + 1, base.index) : null
  }
}

const posCache = new Map<DocNode, {top: NodePos, cache: Pos[]}>(), cacheSize = 8
let cachePos = 0

function cacheFor(doc: DocNode) {
  let found = posCache.get(doc)
  if (!found) posCache.set(doc, found = {top: new NodePos(null, doc, 0, 0), cache: []})
  return found
}

export class NodePos {
  private readonly _start: number

  constructor(
    readonly parent: NodePos | null,
    readonly node: Node,
    start: number,
    readonly index: number
  ) {
    this._start = start
  }

  get before() {
    if (!this.parent) throw new Error("Accessing `before` on the top level node")
    return this._start - 1
  }

  get after() {
    if (!this.parent) throw new Error("Accessing `after` on the top level node")
    return this._start - 1 + this.node.length
  }

  get start() {
    if (this.node.isLeaf()) throw new Error("Accessing `start` on a leaf node")
    return this._start
  }

  get end() {
    if (this.node.isLeaf()) throw new Error("Accessing `end` on a leaf node")
    return this._start + this.node.contentLength
  }

  get depth() {
    let d = 0
    for (let n: NodePos = this; n.parent; n = n.parent) d++
    return d
  }

  get doc(): DocNode {
    let n: NodePos = this
    while (n.parent) n = n.parent
    if (!(n.node.isDoc())) throw new Error("Outer parent node a document")
    return n.node as DocNode
  }

  get nextSibling() {
    return !this.parent || this.index == this.parent.node.children.length - 1 ? null
      : this.parent.node.children[this.index + 1]
  }

  get previousSibling() {
    return !this.parent || !this.index ? null : this.parent.node.children[this.index - 1]
  }
}

function advancePos(distance: number, parent: NodePos, pos: number, index: number, inText: number,
                    walk?: Walker, full = false) {
  let target = pos + distance, {node} = parent
  if (inText) {
    let text = node.children[index] as TextNode
    let textStart = pos - inText, textEnd = textStart + text.length
    if (walk) walk.skip(text.cutText(inText, Math.min(text.length, target - textStart)))
    if (target < textEnd)
      return new Pos(parent, target, index, target - textStart)
    pos = textEnd
    index++
  }
  while (pos < target) {
    if (index == node.children.length) {
      if (!parent.parent) throw new Error("Moving past end of document")
      if (walk) walk.leave()
      ;({index, parent} = parent)
      node = parent.node
      index++
      pos++
    } else {
      let next = node.children[index], end = pos + next.length
      if (target >= end && (!full || next.isLeaf())) {
        if (walk) walk.skip(next)
        pos = end
        index++
      } else if (next.isText()) {
        if (walk) walk.skip(next.cutText(0, target - pos))
        return new Pos(parent, target, index, target - pos)
      } else if (walk && walk.enter(next.tag) == false) {
        pos = end
        index++
      } else {
        pos++
        parent = new NodePos(parent, next, pos, index)
        node = next
        index = 0
      }
    }
  }
  return new Pos(parent, pos, index, 0)
}
