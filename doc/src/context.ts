import {Node, TextNode} from "./node"

const indexObj = {index: 0, remainder: 0}
function retIndex(index: number, remainder: number) {
  indexObj.index = index
  indexObj.remainder = remainder
  return indexObj
}

export function findIndex(nodes: readonly Node[], pos: number): {index: number, remainder: number} {
  for (let i = 0, off = 0;; i++) {
    if (pos == off) return retIndex(i, 0)
    let end = pos + nodes[i].length
    if (end > pos) return retIndex(i, pos - off)
    off = end
  }
}

class ContextLevel {
  constructor(
    readonly parent: Node,
    readonly parentStart: number,
    readonly index: number,
    readonly next: ContextLevel | null
  ) {}

  get parentEnd() {
    return this.parentStart + this.parent.contentLength
  }

  get beforeParent() {
    if (!this.next) throw new Error("Cannot get a position before the document")
    return this.parentStart - 1
  }

  get afterParent() {
    if (!this.next) throw new Error("Cannot get a position after the document")
    return this.parentEnd + 1
  }
}

class Context extends ContextLevel {
  constructor(
    readonly pos: number,
    readonly textOffset: number,
    parent: Node,
    parentStart: number,
    index: number,
    next: ContextLevel | null
  ) {
    super(parent, parentStart, index, next)
  }

  /// Get the node directly after the position, if any. If the position
  /// points into a text node, only the part of that node after the
  /// position is returned.
  get nodeAfter(): Node | null {
    let {parent, index} = this
    if (index == parent.children.length) return null
    let after = parent.children[index]
    return this.textOffset ? Node.text((after as TextNode).text.slice(this.textOffset), after.marks) : after
  }

  /// Get the node directly before the position, if any. If the
  /// position points into a text node, only the part of that node
  /// before the position is returned.
  get nodeBefore(): Node | null {
    let {parent, index, textOffset} = this
    if (textOffset) {
      let node = parent.children[index] as TextNode
      return node.withText(node.text.slice(0, this.textOffset))
    } else if (!index) {
      return null
    } else {
      return parent.children[index - 1]
    }
  }

  static resolve(doc: Node, pos: number) {
    if (pos < 0 || pos > doc.length)
      throw new Error(`Position ${pos} out of range for document of length ${doc.length}`)
    return resolveInner(doc, pos, 0, null)
  }
}

function resolveInner(node: Node, pos: number, start: number, next: ContextLevel | null) {
  let {index, remainder} = findIndex(node.children, pos - start)
  if (!remainder || node.children[index].isText()) return new Context(pos, remainder, node, start, index, next)
  return resolveInner(node.children[index], pos, pos - remainder, new ContextLevel(node, start, index, next))
}
