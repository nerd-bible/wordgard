import {Node, TextNode, NodeType, Mark, Schema} from "./node"

export class OpenToken {
  constructor(readonly node: Node) {}
}

export class CloseToken {
  constructor(readonly type: NodeType) {}
}

type Slice = readonly (Node | OpenToken | CloseToken)[]

interface Tracker {
  skip(node: Node): void
  enter(node: Node): void
  leave(type: NodeType): void
}

function resolvePos(distance: number, node: Node, index: number, parent: Pos | null, track?: Tracker) {
  for (;;) {
    if (!distance) return new Pos(node, index, parent)
    if (node.isText()) {
      if (track) track.skip(node.slice(index, Math.min(node.length, index + distance)))
      if (node.length > index + distance)
        return new Pos(node, index + distance, parent)
      distance -= node.length - index
      ;({node, index, parent} = parent!)
    } else if (index == node.children.length) {
      if (!parent) throw new Error("Moving past end of document")
      if (track) track.leave(node.type)
      ;({node, index, parent} = parent)
      distance--
    } else {
      let next = node.children[index++]
      if (next.length <= distance) {
        distance -= next.length
        if (track) track.skip(next)
      } else {
        if (!next.type.isText) {
          distance--
          if (track) track.enter(next)
        }
        parent = new Pos(node, index, parent)
        node = next
        index = 0
      }
    }
  }
}
class Pos {
  constructor(readonly node: Node, readonly index: number, readonly parent: Pos | null) {}

  advance(distance: number, track?: Tracker) {
    return resolvePos(distance, this.node, this.index, this.parent, track)
  }

  static resolve(doc: Node, pos: number) {
    return resolvePos(pos, doc, 0, null)
  }
}

function runSlice(slice: Slice, track: Tracker) {
  for (let elt of slice) {
    if (elt instanceof OpenToken) track.enter(elt.node)
    else if (elt instanceof CloseToken) track.leave(elt.type)
    else track.skip(elt)
  }
}

class BuildContext {
  children: Node[] = []
  constructor(readonly node: Node) {}
}

class Builder implements Tracker {
  stack: BuildContext[]

  constructor(doc: Node) {
    this.stack = [new BuildContext(doc)]
  }

  add(node: Node) {
    let top = this.stack[this.stack.length - 1]
    if (node.isText()) {
      let last = top.children.length - 1
      if (last >= 0 && top.children[last].sameMarkup(node)) {
        top.children[last] = node.withText((top.children[last] as TextNode).text + node.text)
        return
      }
    }
    top.children.push(node)
  }    

  enter(node: Node) {
    this.stack.push(new BuildContext(node))
  }

  leave(type: NodeType) {
    // FIXME check/finish current top
    let top = this.stack.pop()!
    this.add(top.node.copy(top.children))
  }

  skip(node: Node) {
    this.add(node)
  }

  finish() {
    if (this.stack.length != 1) throw new Error("Invalid change")
    return this.stack[0].node.copy(this.stack[0].children)
  }
}

export class ChangeSet {
  constructor(
    // Pairs of integers, first one representing the length of the
    // section in A, the second either -1 for a preserved or marked
    // range, or an insertion length for a replacement.
    readonly sections: readonly number[],
    readonly data: readonly (null | Slice | readonly Mark[])[]
  ) {}

  apply(schema: Schema, doc: Node) {
    let builder = new Builder(doc)
    let cursor = new Pos(doc, 0, null)
    for (let i = 0, iS = 0; i < this.data.length; i++) {
      let lenA = this.sections[iS++], lenB = this.sections[iS++]
      if (lenB < 0) {
        cursor = cursor.advance(lenA, builder)
      } else {
        cursor = cursor.advance(lenA)
        runSlice(this.data[i] as Slice, builder)
      }
    }
    if (cursor.parent || cursor.index != (cursor.node.isText() ? cursor.node.text.length : cursor.node.children.length))
      throw new Error("Change doesn't cover the entire document")
    return builder.finish()
  }
}
