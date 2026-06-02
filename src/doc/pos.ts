import type {Node as _Node, Plot as _Plot, Leaf} from "./node"
import {Mark} from "./mark"
import {none} from "./helper"

export class Pos {
  private constructor(
    readonly parent: Pos.Plot,
    readonly pos: number,
    readonly index: number,
    readonly inText: number
  ) {}

  static create(parent: Pos.Plot, pos: number, index: number, inText: number) {
    return new Pos(parent, pos, index, inText)
  }

  matchingParent(pred: (plot: _Plot) => boolean) {
    for (let {parent} = this;;) {
      if (pred(parent.node)) return parent
      if (!parent.parent) return null
      ;({parent} = parent)
    }
  }

  advance(distance: number, walk?: Pos.Walker) {
    return distance ? advancePos(distance, this.parent, this.pos, this.index, this.inText, walk) : this
  }

  walk(distance: number, walk: Pos.Walker) {
    return distance ? advancePos(distance, this.parent, this.pos, this.index, this.inText, walk, true) : this
  }

  get nodeAfter(): _Node | null {
    if (this.index == this.parent.node.content.length) return null
    let node = this.parent.node.content[this.index]
    return this.inText ? (node as Leaf<string>).sliceText(this.inText) : node
  }

  get nodeBefore(): _Node | null {
    if (this.inText) return (this.parent.node.content[this.index] as Leaf<string>).sliceText(0, this.inText)
    return this.index ? this.parent.node.content[this.index - 1] : null
  }

  get textblockParent() {
    for (let p: Pos.Plot | null = this.parent;; p = p.parent) {
      if (!p || !p.node.inlineContent) return null
      if (p.node.isTextblock) return p
    }
  }

  parentAt(depth: number) {
    let d = this.depth
    if (depth > d) throw new RangeError("Asking for parent deeper than position depth")
    for (let d = this.depth, p = this.parent;; p = p.parent!)
      if (d == depth) return p
  }

  isAtStart(parent: Pos.Plot) {
    if (this.inText) return false
    for (let p: Pos.Plot | null = this.parent, index = this.index;; index = p.index, p = p.parent) {
      if (!p || index) return false
      if (p == parent) return true
    }
  }

  isAtEnd(parent: Pos.Plot) {
    if (this.inText) return false
    for (let p: Pos.Plot | null = this.parent, index = this.index;; index = p.index + 1, p = p.parent) {
      if (!p || index < p.node.content.length) return false
      if (p == parent) return true
    }
  }

  get depth() { return this.parent.depth }

  get doc() { return this.parent.doc }

  marks(across?: Pos) {
    if (this.inText && (!across || across.pos == this.pos)) return this.parent.node.content[this.index].tag.marks
    let [from, to] = !across ? [this, this] : across.pos > this.pos ? [this, across] : [across, this]
    let before = from.nodeBefore, after = to.nodeAfter
    let [main, sec]: [readonly Mark[], readonly Mark[]] =
      before ? [before.tag.marks, after ? after.tag.marks : none] : [after ? after.tag.marks : none, none]
    return main.filter(p => p.spanning && (p.type.inclusive || p.isInSet(sec)))
  }

  static atStart(doc: _Plot.Doc) {
    return Pos.create(cacheFor(doc).top, 0, 0, 0)
  }

  static resolve(doc: _Plot.Doc, pos: number): Pos {
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

  static resolveNode(doc: _Plot.Doc, pos: number) {
    let base = this.resolve(doc, pos)
    if (base.inText) return null
    let after = base.nodeAfter
    return !after || after.isText ? null : after.isLeaf ? Pos.Node.create(base.parent, after, pos, base.index)
      : Pos.Plot.create(base.parent, after, pos, base.index)
  }
}

export namespace Pos {
  export interface Walker {
    skip(node: _Node, pos: number, parent: Pos.Plot, index: number): void
    enterPlot(node: _Plot, pos: number, parent: Pos.Plot, index: number): void | boolean
    leavePlot(tag: _Plot.Tag.Any | undefined, pos: number, parent: Pos.Plot | null, index: number): void
  }

  export class Node {
    protected constructor(
      readonly parent: Pos.Plot | null,
      readonly node: _Node,
      /// @internal
      readonly pos: number,
      readonly index: number
    ) {}

    static create(parent: Pos.Plot | null, node: _Node, pos: number, index: number) {
      return new Node(parent, node, pos, index)
    }

    get before() {
      if (this.pos < 0) throw new RangeError("Accessing `before` on the top level node")
      return this.pos
    }

    get after() {
      if (this.pos < 0) throw new RangeError("Accessing `after` on the top level node")
      return this.pos + this.node.length
    }

    get depth() {
      let d = 0
      for (let n: Pos.Node = this; n.parent; n = n.parent) d++
      return d
    }

    get doc(): _Plot.Doc {
      let n: Pos.Node = this
      while (n.parent) n = n.parent
      if (!((n as Pos.Plot).node.isDoc)) throw new Error("Outer parent not a document")
      return n.node as _Plot.Doc
    }

    get isFirst() { return !this.parent || this.index == 0 }
    get isLast() { return !this.parent || this.index == this.parent.node.content.length - 1 }

    get nextSibling() { return this.isLast ? null : this.parent!.node.content[this.index + 1] }
    get previousSibling() { return this.isFirst ? null : this.parent!.node.content[this.index - 1] }
  }

  export class Plot extends Pos.Node {
    declare node: _Plot
    
    private constructor(
      parent: Pos.Plot | null,
      node: _Plot,
      pos: number,
      index: number
    ) {
      super(parent, node, pos, index)
    }

    static create(parent: Pos.Plot | null, node: _Plot, pos: number, index: number) {
      return new Plot(parent, node, pos, index)
    }
    
    get start() { return this.pos + 1 }

    get end() { return this.pos + 1 + this.node.contentLength }
  }

}

const posCache = new Map<_Plot.Doc, {top: Pos.Plot, cache: Pos[]}>(), cacheSize = 8
let cachePos = 0

function cacheFor(doc: _Plot.Doc) {
  let found = posCache.get(doc)
  if (!found) posCache.set(doc, found = {top: Pos.Plot.create(null, doc, -1, 0), cache: []})
  return found
}

function advancePos(distance: number, parent: Pos.Plot, pos: number, index: number, inText: number,
                    walk?: Pos.Walker, full = false) {
  let target = pos + distance, {node} = parent
  if (inText) {
    let text = node.content[index] as Leaf<string>
    let textStart = pos - inText, textEnd = textStart + text.length
    if (walk) walk.skip(text.sliceText(inText, Math.min(text.length, target - textStart)), pos, parent, index)
    if (target < textEnd)
      return Pos.create(parent, target, index, target - textStart)
    pos = textEnd
    index++
  }
  while (pos < target) {
    if (index == node.content.length) {
      if (!parent.parent) throw new Error("Moving past end of document")
      if (walk) walk.leavePlot(node.tag, pos, parent.parent, parent.index)
      ;({index, parent} = parent)
      node = parent.node
      index++
      pos++
    } else {
      let next = node.content[index], end = pos + next.length
      if (next.isLeaf) {
        if (next.isText && target < end) {
          if (walk) walk.skip(next.sliceText(0, target - pos), pos, parent, index)
          return Pos.create(parent, target, index, target - pos)
        } else {
          if (walk) walk.skip(next, pos, parent, index)
          pos = end
          index++
        }
      } else {
        let enter = full || target < end
        if (walk) {
          if (!enter) walk.skip(next, pos, parent, index)
          else if (walk.enterPlot(next, pos, parent, index) === false && target >= end) enter = false
        }
        if (enter) {
          parent = Pos.Plot.create(parent, next, pos, index)
          pos++
          node = next
          index = 0
        } else {
          pos = end
          index++
        }
      }
    }
  }
  return Pos.create(parent, pos, index, 0)
}
