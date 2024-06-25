import {Node, TextNode, Mark, Schema, MarkJSON} from "./node"
import {Slice, SliceJSON} from "./slice"

export interface Tracker {
  skip(node: Node): void
  enter(node: Node): void
  leave(): void
}

function resolvePos(distance: number, node: Node, index: number, parent: Pos | null, track?: Tracker) {
  for (;;) {
    if (!distance) return new Pos(node, index, parent)
    if (node.isText()) {
      if (track) track.skip(node.cut(index, Math.min(node.length, index + distance)))
      if (node.length > index + distance)
        return new Pos(node, index + distance, parent)
      distance -= node.length - index
      ;({node, index, parent} = parent!)
    } else if (index == node.children.length) {
      if (!parent) throw new Error("Moving past end of document")
      if (track) track.leave()
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
class Pos { // FIXME merge with Context, somehow
  constructor(readonly node: Node, readonly index: number, readonly parent: Pos | null) {}

  advance(distance: number, track?: Tracker) {
    return resolvePos(distance, this.node, this.index, this.parent, track)
  }

  static resolve(doc: Node, pos: number) {
    return resolvePos(pos, doc, 0, null)
  }
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

  leave() {
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
  {type: "setAttr", attr: string, value: any}

function applyModifications(modifications: readonly Modification[], node: Node) {
  for (const m of modifications) {
    if (m.type == "addMark") {
      if (!m.mark.type.canTarget(node.type))
        throw new Error(`Trying to add mark ${m.mark.name} to a node of type ${node.name}`)
      node = node.mark(m.mark.addToSet(node.marks))
    } else if (m.type == "removeMark") {
      node = node.mark(m.mark.removeFromSet(node.marks))
    } else {
      if (!node.type.attrs.some(a => a.name == m.attr))
        throw new Error(`Setting non-existant attribute ${m.attr} on node ${node.name}`)
      node = new Node(node.type, {...node.attrs, [m.attr]: m.value}, node.marks, node.children)
    }
  }
  return node
}

export type ModificationJSON = {
  type: "addMark" | "removeMark" | "setAttr"
  mark?: MarkJSON
  attr?: string
  value?: any
}

function modificationToJSON(m: Modification): ModificationJSON {
  if (m.type == "setAttr") return {type: m.type, attr: m.attr, value: m.value}
  return {type: m.type, mark: m.mark.toJSON()}
}

function modificationFromJSON(schema: Schema, json: ModificationJSON): Modification {
  if (json.type == "addMark" || json.type == "removeMark") return {type: json.type, mark: schema.markFromJSON(json.mark!)}
  if (json.type == "setAttr" && typeof json.attr == "string") return json as any
  throw new Error("Invalid modification JSON")
}

function compareModifications(a: readonly Modification[], b: readonly Modification[]) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!compareModification(a[i], b[i])) return false
  return true
}

function compareModification(a: Modification, b: Modification) {
  if (a.type != b.type) return false
  if (a.type == "setAttr") return a.attr == (b as typeof a).attr && a.value == (b as typeof a).value
  return a.mark.eq((b as typeof a).mark)
}

export type ChangeSpec = {
  from: number
  to?: number
  insert?: Slice
  addMark?: Mark
  removeMark?: Mark
  setAttr?: {[name: string]: any}
} | ChangeSet | ChangeSpec[]

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
        ;(this.data[i] as Slice).validate(schema).run(builder)
      }
    }
    if (cursor.parent || cursor.index != (cursor.node.isText() ? cursor.node.text.length : cursor.node.children.length))
      throw new Error("Change doesn't cover the entire document")
    return builder.finish()
  }

  get length() {
    let result = 0
    for (let i = 0; i < this.sections.length; i += 2) result += this.sections[i]
    return result
  }

  get newLength() {
    let result = 0
    for (let i = 0; i < this.sections.length; i += 2) {
      let ins = this.sections[i + 1]
      result += ins < 0 ? this.sections[i] : ins
    }
    return result
  }

  get empty() { return this.sections.length == 0 || this.sections.length == 2 && this.sections[1] < 0 }

  eq(other: ChangeSet) {
    if (other.data.length != this.data.length) return false
    for (let i = 0; i < this.sections.length; i++)
      if (this.sections[i] != other.sections[i]) return false
    for (let i = 0; i < this.data.length; i++) {
      let a = this.data[i] as any, b = other.data[i] as any
      if (a && !(this.sections[(i << 1) + 1] < 0 ? compareModifications(a, b) : a.eq(b))) return false
    }
  }

  toJSON(): ChangeSetJSON {
    return this.data.map((data, i) => {
      let length = this.sections[i << 1], type = this.sections[(i << 1) + 1]
      return type >= 0 ? {length, replacement: (data as Slice).toJSON()}
        : data ? {length, modifications: (data as readonly Modification []).map(modificationToJSON)}
        : {length}
    })
  }

  static fromJSON(schema: Schema, json: ChangeSetJSON) {
    if (!Array.isArray(json)) throw new Error("Invalid ChangeSet JSON")
    let sections: number[] = [], data: (null | Slice | readonly Modification[])[] = []
    for (let elt of json) {
      let {length} = elt
      if (typeof length != "number") throw new Error("Invalid ChangeSet JSON")
      if (elt.replacement) {
        let slice = Slice.fromJSON(schema, elt.replacement)
        sections.push(length, slice.length)
        data.push(slice)
      } else {
        sections.push(length, -1)
        data.push(!Array.isArray(elt.modification) ? null :
          elt.modification.map((m: ModificationJSON) => modificationFromJSON(schema, m)))
      }
    }
    return new ChangeSet(sections, data)
  }

  mapPos(pos: number, assoc?: number): number
  mapPos(pos: number, assoc: number, mode: MapMode): number | null
  mapPos(pos: number, assoc = -1, mode: MapMode = MapMode.Simple) {
    let posA = 0, posB = 0
    for (let i = 0; i < this.sections.length;) {
      let len = this.sections[i++], type = this.sections[i++], endA = posA + len
      if (type < 0) {
        if (endA > pos) return posB + (pos - posA)
        posB += len
      } else {
        if (mode != MapMode.Simple && endA >= pos &&
            (mode == MapMode.TrackDel && posA < pos && endA > pos ||
             mode == MapMode.TrackBefore && posA < pos ||
             mode == MapMode.TrackAfter && endA > pos)) return null
        if (endA > pos || endA == pos && assoc < 0 && !len)
          return pos == posA || assoc < 0 ? posB : posB + type
        posB += type
      }
      posA = endA
    }
    if (pos > posA) throw new RangeError(`Position ${pos} is out of range for changeset of length ${posA}`)
    return posB
  }

  map(other: ChangeSet, before: boolean = false): ChangeSet {
    // Produce a copy of setA that applies to the document after setB
    // has been applied. Assumes both start at the same document.
    let sections: number[] = [], data: (Slice | readonly Modification[] | null)[] = []
    let a = new SectionIter(this), b = new SectionIter(other)
    // Iterate over both sets in parallel. inserted tracks, for changes
    // in A that have to be processed piece-by-piece, whether their
    // content has been inserted already, and refers to the section
    // index.
    for (let inserted = -1;;) {
      if (a.done && b.len || b.done && a.len) {
        throw new Error("Mismatched change set lengths")
      } else if (a.ins == -1 && b.ins == -1) {
        // Move across ranges skipped by both sets.
        let len = Math.min(a.len, b.len)
        addSection(sections, data, len, -1, a.mods)
        a.forward(len)
        b.forward(len)
      } else if (b.ins >= 0 && (a.ins < 0 || inserted == a.i || a.off == 0 && (b.len < a.len || b.len == a.len && !before))) {
        // If there's a change in B that comes before the next change in
        // A (ordered by start pos, then len, then before flag), skip
        // that (and process any changes in A it covers).
        let len = b.len
        addSection(sections, data, b.ins, -1, null)
        while (len) {
          let piece = Math.min(a.len, len)
          if (a.ins >= 0 && inserted < a.i && a.len <= piece) {
            addSection(sections, data, 0, a.ins, a.slice)
            inserted = a.i
          }
          a.forward(piece)
          len -= piece
        }
        b.next()
      } else if (a.ins >= 0) {
        // Process the part of a change in A up to the start of the next
        // non-deletion change in B (if overlapping).
        let len = 0, left = a.len
        while (left) {
          if (b.ins == -1) {
            let piece = Math.min(left, b.len)
            len += piece
            left -= piece
            b.forward(piece)
          } else if (b.ins == 0 && b.len < left) {
            left -= b.len
            b.next()
          } else {
            break
          }
        }
        addSection(sections, data, len, inserted < a.i ? a.ins : 0, inserted < a.i ? a.slice : Slice.empty)
        inserted = a.i
        a.forward(a.len - left)
      } else if (a.done && b.done) {
        return new ChangeSet(sections, data)
      } else {
        throw new Error("Mismatched change set lengths")
      }
    }
  }

  compose(other: ChangeSet): ChangeSet {
    let sections: number[] = [], data: (Slice | readonly Modification[] | null)[] = []
    let a = new SectionIter(this), b = new SectionIter(other)
    for (let open = false;;) {
      if (a.done && b.done) {
        return new ChangeSet(sections, data)
      } else if (a.ins == 0) { // Deletion in A
        addSection(sections, data, a.len, 0, a.slice, open)
        a.next()
      } else if (b.len == 0 && !b.done) { // Insertion in B
        addSection(sections, data, 0, b.ins, b.slice, open)
        b.next()
      } else if (a.done || b.done) {
        throw new Error("Mismatched change set lengths")
      } else {
        let len = Math.min(a.len2, b.len), sectionLen = sections.length
        if (a.ins == -1) {
          let insB = b.ins == -1 ? -1 : b.off ? 0 : b.ins
          addSection(sections, data, len, insB, b.slice, open)
        } else if (b.ins == -1) {
          addSection(sections, data, a.off ? 0 : a.len, len, a.slicePart(len), open)
        } else {
          addSection(sections, data, a.off ? 0 : a.len, b.off ? 0 : b.ins, b.slice, open)
        }
        open = (a.ins > len || b.ins >= 0 && b.len > len) && (open || sections.length > sectionLen)
        a.forward2(len)
        b.forward(len)
      }
    }
  }

  static addMark(doc: Node, from: number, to: number, mark: Mark) {
    return createMarkSet(doc, from, to, [{type: "addMark", mark}],
                         n => mark.type.canTarget(n.type) && !mark.isInSet(n.marks))
  }

  static removeMark(doc: Node, from: number, to: number, mark: Mark) {
    return createMarkSet(doc, from, to, [{type: "removeMark", mark}], n => mark.isInSet(n.marks))
  }

  static setAttrs(doc: Node, pos: number, attrs: {[name: string]: any}) {
    let mods: Modification[] = [], node = doc.nodeAt(pos)
    if (!node) throw new Error("No node at position given to ChangeSet.setAttrs")
    for (let attr in attrs) {
      if (!node.type.attrs.some(a => a.name == attr))
        throw new Error(`Nodes of type ${node.name} don't support an attribute ${attr}`)
      mods.push({type: "setAttr", attr, value: attrs[attr]})
    }
    let sections: number[] = [], data: (readonly Modification[] | null)[] = []
    if (pos) { sections.push(pos, -1); data.push(null) }
    sections.push(1, -1); data.push(mods)
    if (pos + 1 < doc.length) { sections.push(doc.length - pos - 1, -1); data.push(null) }
    return new ChangeSet(sections, data)
  }

  static create(doc: Node, spec: ChangeSpec): ChangeSet {
    if (Array.isArray(spec)) {
      let change: ChangeSet | null = null
      for (let elt of spec) {
        let set = ChangeSet.create(doc, elt)
        change = change ? change.compose(set.map(change)) : set
      }
      return change || ChangeSet.empty(doc.length)
    } else if (spec instanceof ChangeSet) {
      if (spec.length != doc.length) throw new Error("Mismatched change set length")
      return spec
    } else {
      let {from} = spec
      let modifies = spec.addMark || spec.removeMark || spec.setAttr
      if (modifies && !spec.insert) {
        let to = spec.to ?? spec.from + 1
        let pieces: ChangeSet[] = []
        if (spec.removeMark) pieces.push(ChangeSet.removeMark(doc, from, to, spec.removeMark))
        if (spec.addMark) pieces.push(ChangeSet.addMark(doc, from, to, spec.addMark))
        if (spec.setAttr) {
          if (to - from != 1) throw new Error("Attribute changes must apply to a single position")
          pieces.push(ChangeSet.setAttrs(doc, from, spec.setAttr))
        }
        return pieces.length > 1 ? ChangeSet.create(doc, pieces) : pieces[0]
      } else if (spec.to == null && !spec.insert) {
        return ChangeSet.empty(doc.length)
      } else {
        let to = spec.to ?? spec.from, sections: number[] = [], data: (Slice | null)[] = []
        if (from > 0) { sections.push(from, -1); data.push(null) }
        sections.push(to - from, spec.insert ? spec.insert.length : 0); data.push(spec.insert || Slice.empty)
        if (to < doc.length) { sections.push(doc.length - to, -1); data.push(null) }
        return new ChangeSet(sections, data)
      }
    }
  }

  static empty(length: number) {
    return length ? new ChangeSet([length, -1], [null]) : new ChangeSet([], [])
  }
}

function createMarkSet(doc: Node, from: number, to: number, mods: readonly Modification[], test: (n: Node) => boolean) {
  let sections: number[] = [], data: (readonly Modification[] | null)[] = []
  let upto = 0
  doc.iterate(from, to, (node, pos) => {
    if (((pos >= from && pos + node.length <= to) || node.isText()) && test(node)) {
      let [start, end] = node.isText() ? [Math.max(pos, from), Math.min(pos + node.length, to)] : [pos, pos + 1]
      if (start > upto) { sections.push(start - upto, -1); data.push(null) }
      sections.push(end - start, -1)
      data.push(mods)
      upto = end
      return false
    }
  })
  if (upto < doc.length) { sections.push(doc.length - upto, -1); data.push(null) }
  return new ChangeSet(sections, data)
}

export type ChangeSetJSON = readonly {
  length: number
  modifications?: readonly ModificationJSON[]
  replacement?: SliceJSON
}[]

export enum MapMode {
  /// Map a position to a valid new position, even when its context
  /// was deleted.
  Simple,
  /// Return null if deletion happens across the position.
  TrackDel,
  /// Return null if the character _before_ the position is deleted.
  TrackBefore,
  /// Return null if the character _after_ the position is deleted.
  TrackAfter
}

class SectionIter {
  i = 0
  len!: number
  off!: number
  ins!: number

  constructor(readonly set: ChangeSet) {
    this.next()
  }

  next() {
    let {sections} = this.set
    if (this.i < sections.length) {
      this.len = sections[this.i++]
      this.ins = sections[this.i++]
    } else {
      this.len = 0; this.ins = -2
    }
    this.off = 0
  }

  get done() { return this.ins == -2 }

  get len2() { return this.ins < 0 ? this.len : this.ins }

  get mods() {
    return this.set.data[(this.i - 2) >> 1] as readonly Modification[] | null
  }

  get slice() {
    return this.set.data[(this.i - 2) >> 1] as Slice
  }

  slicePart(len?: number) {
    return this.slice.slice(this.off, len == null ? undefined : this.off + len)
  }

  forward(len: number) {
    if (len == this.len) this.next()
    else { this.len -= len; this.off += len }
  }

  forward2(len: number) {
    if (this.ins == -1) this.forward(len)
    else if (len == this.ins) this.next()
    else { this.ins -= len; this.off += len }
  }
}

function addSection(sections: number[], data: (Slice | readonly Modification[] | null)[],
                    len: number, ins: number, value: Slice | readonly Modification[] | null,
                    forceJoin = false) {
  if (len == 0 && ins <= 0) return
  let last = sections.length - 2
  if (last >= 0 && ins <= 0 && ins == sections[last + 1]) {
    // Deletion or preserved section that matches the last element in `sections`
    let lastValue = data[data.length - 1]
    let match = ins == 0 ? true
      : value ? lastValue && compareModifications(lastValue as readonly Modification[], value as readonly Modification[])
      : !lastValue
    if (match) {
      sections[last] += len
      return
    }
  }
  if (forceJoin || last >= 0 && len == 0 && sections[last] == 0) {
    // Insertion or replacement joinable to another insertion
    sections[last] += len
    sections[last + 1] += ins
    data[data.length - 1] = (data[data.length - 1] as Slice).concat(value as Slice)
  } else {
    sections.push(len, ins)
    data.push(value)
  }
}
