import {Node, TextNode, NodeType, Mark, Attribute, Schema, eqArray} from "./node"

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

function validateSlice(schema: Schema, slice: Slice) {
  for (let elt of slice) {
    if (elt instanceof OpenToken) schema.validate(elt.node)
    else if (elt instanceof Node) schema.validate(elt)
  }
  return slice
}

class BuildContext {
  children: Node[] = []
  constructor(readonly node: Node) {}
}

class Builder implements Tracker {
  stack: BuildContext[]
  modifications: readonly Modification[] | null = null

  constructor(readonly schema: Schema, doc: Node) {
    this.stack = [new BuildContext(doc)]
  }

  add(node: Node) {
    if (this.modifications) {
      if (!node.type.isLeaf) throw new Error("Invalid modification on non-leaf node")
      node = applyModifications(this.modifications, node)
    }
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
    if (this.modifications) node = applyModifications(this.modifications, node)
    this.stack.push(new BuildContext(node))
  }

  leave(type: NodeType) {
    if (this.modifications) throw new Error("Invalid modification on close token")
    let top = this.stack.pop()!
    if (!top.children.length && !top.node.type.isLeaf && !this.schema.hasInlineContent(top.node.type))
      throw new Error(`Invalid change creating an empty block-child node`)
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

type Modification =
  {type: "addMark", mark: Mark} |
  {type: "removeMark", mark: Mark} |
  {type: "setAttr", attr: Attribute<any>, value: any}

function applyModifications(modifications: readonly Modification[], node: Node) {
  for (let m of modifications) {
    if (m.type == "addMark") {
      if (!m.mark.type.canTarget(node.type))
        throw new Error(`Trying to add mark ${m.mark.name} to a node of type ${node.name}`)
      node = node.mark(m.mark.addToSet(node.marks))
    } else if (m.type == "removeMark") {
      node = node.mark(m.mark.removeFromSet(node.marks))
    } else {
      if (!node.type.attrs.includes(m.attr))
        throw new Error(`Setting non-existant attribute ${m.attr.name} on node ${node.name}`)
      node = new Node(node.type, {...node.attrs, [m.attr.name]: m.value}, node.marks, node.children)
    }
  }
  return node
}

function compareModifications(a: readonly Modification[], b: readonly Modification[]) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!compareModification(a[i], b[i])) return false
  return true
}

function compareModification(a: Modification, b: Modification) {
  if (a.type != b.type) return false
  if (a.type == "setAttr") return a.attr == (b as typeof a).attr && a.attr.compare(a.value, (b as typeof a).value)
  return a.mark.eq((b as typeof a).mark)
}

export class ChangeSet {
  constructor(
    // Pairs of integers, first one representing the length of the
    // section in A, the second either -1 for a preserved or marked
    // range, or an insertion length for a replacement.
    readonly sections: readonly number[],
    readonly data: readonly (null | Slice | readonly Modification[])[]
  ) {}

  apply(schema: Schema, doc: Node) {
    let builder = new Builder(schema, doc)
    let cursor = new Pos(doc, 0, null)
    for (let i = 0, iS = 0; i < this.data.length; i++) {
      let lenA = this.sections[iS++], lenB = this.sections[iS++]
      if (lenB < 0) {
        builder.modifications = this.data[i] as (null | readonly Modification[])
        cursor = cursor.advance(lenA, builder)
        builder.modifications = null
      } else {
        cursor = cursor.advance(lenA)
        runSlice(validateSlice(schema, this.data[i] as Slice), builder)
      }
    }
    if (cursor.parent || cursor.index != (cursor.node.isText() ? cursor.node.text.length : cursor.node.children.length))
      throw new Error("Change doesn't cover the entire document")
    return builder.finish()
  }

  eq(other: ChangeSet) {
    if (other.data.length != this.data.length) return false
    for (let i = 0; i < this.sections.length; i++)
      if (this.sections[i] != other.sections[i]) return false
    for (let i = 0; i < this.data.length; i++) {
      let a = this.data[i] as any, b = other.data[i] as any
      if (a && !(this.sections[(i << 1) + 1] < 0 ? compareModifications(a, b) : eqArray(a, b))) return false
    }
  }
}
