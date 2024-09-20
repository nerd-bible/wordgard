import {Node, DocNode, Tag, TokenType} from "./node"
import {Prop, subtractSet} from "./prop"
import {Schema} from "./schema"
import {Slice, Token, CloseToken, OpenToken, SliceJSON} from "./slice"
import {Context, Walker} from "./context"

class BuildContext {
  children: Node[] = []
  constructor(readonly tag: Tag) {}
}

class Builder implements Walker {
  stack: BuildContext[]
  modifications: readonly Modification[] | null = null
  schema: Schema

  constructor(doc: DocNode) {
    this.schema = doc.schema
    this.stack = [new BuildContext(doc.tag)]
  }

  add(node: Node) {
    if (this.modifications) {
      if (!node.tag.isLeaf()) throw new Error("Invalid modification on non-leaf node")
      let tag = applyModifications(this.modifications, node.tag)
      if (tag != node.tag) node = tag.create(node.children)
    }
    node.pushTo(this.stack[this.stack.length - 1].children)
  }    

  enter(tag: Tag) {
    if (this.modifications) tag = applyModifications(this.modifications, tag)
    this.stack.push(new BuildContext(tag))
  }

  leave() {
    if (this.modifications) throw new Error("Invalid modification on close token")
    if (this.stack.length == 1) throw new Error("Surplus close token")
    let top = this.stack.pop()!
    if (!top.children.length && !top.tag.isLeaf() && !top.tag.inlineContent())
      throw new Error(`Invalid change creating an empty block-child node`)
    this.add(top.tag.create(top.children))
  }

  skip(node: Node) {
    this.add(node)
  }

  finish() {
    if (this.stack.length != 1) throw new Error("Invalid change")
    let {tag, children} = this.stack[0]
    if (!children.length && !tag.inlineContent())
      throw new Error(`Invalid change creating an empty block-child node`)
    return this.schema.doc(children)
  }
}

type Modification = {add: Prop} | {remove: Prop}

function isAdd(m: Modification): m is {add: Prop} { return !!(m as any).add }
function isRemove(m: Modification): m is {remove: Prop} { return !!(m as any).remove }

function applyModifications(modifications: readonly Modification[], tag: Tag) {
  for (const m of modifications) {
    if (isAdd(m)) {
      if (!m.add.type.canTarget(tag.type))
        throw new Error(`Trying to add prop ${m.add.name} to a node of type ${tag.name}`)
      tag = tag.addProp(m.add)
    } else {
      tag = tag.removeProp(m.remove)
    }
  }
  return tag
}

export type ModificationJSON = {add: string, value: any} | {remove: string, value: any}

function modificationToJSON(m: Modification): ModificationJSON {
  return isAdd(m) ? {add: m.add.name, value: m.add.value} : {remove: m.remove.name, value: m.remove.value}
}

function modificationFromJSON(schema: Schema, json: ModificationJSON): Modification {
  let {add, remove} = json as {add?: string, remove?: string}
  if (typeof add == "string" || typeof remove == "string") {
    let prop = schema.getProp((add || remove)!)
    if (!prop) throw new Error(`Unknown prop ${add || remove}`)
    let value = prop.of(json.value) // FIXME validate
    if (prop) return add ? {add: value} : {remove: value}
  }
  throw new Error("Invalid modification JSON")
}

function compareModifications(a: readonly Modification[], b: readonly Modification[]) {
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!compareModification(a[i], b[i])) return false
  return true
}

function compareModification(a: Modification, b: Modification) {
  return isAdd(a) ? isAdd(b) && a.add.eq(b.add) : isRemove(b) && a.remove.eq(b.remove)
}

export type ChangeSpec = {
  from: number
  to?: number
  insert?: Slice
  add?: Prop<any>
  remove?: Prop<any>
} | ChangeSet | ChangeSpec[]

type SectionData = Slice | readonly Modification[] | null

export class ChangeDesc {
  constructor(
    // Pairs of integers, first one representing the length of the
    // section in A, the second either -1 for a preserved, -2 for a
    // marked range, or a non-negative insertion length for a
    // replacement.
    readonly sections: readonly number[]
  ) {}

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

  get desc(): ChangeDesc { return this }

  eq(other: ChangeDesc) {
    if (other.sections.length != this.sections.length) return false
    for (let i = 0; i < this.sections.length; i++)
      if (this.sections[i] != other.sections[i]) return false
    return true
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

  composeDesc(other: ChangeDesc): ChangeDesc { return compose(this, other, false) }

  invertDesc() {
    let sections: number[] = []
    for (let iS = 0, pos = 0; iS < this.sections.length; iS += 2) {
      let len = this.sections[iS], ins = this.sections[iS + 1]
      if (ins >= 0) addSection(sections, null, ins, len, null)
      else if (len) addSection(sections, null, len, ins, null)
      pos += len
    }
    return new ChangeDesc(sections)
  }

  touchesRange(from: number, to: number) {
    for (let i = 0, pos = 0; i < this.sections.length && pos <= to;) {
      let len = this.sections[i++], ins = this.sections[i++], end = pos + len
      if (ins >= 0 && pos <= to && end >= from) return pos < from && end > to ? "cover" : true
      pos = end
    }
    return false
  }

  /// Iterate over the sections of the document this change leaves
  /// unchanged or which have only prop changes. `posA` provides the
  /// position of the range in the original document, `posB` the
  /// position in the changed document.
  iterGaps(f: (posA: number, posB: number, length: number) => void) {
    for (let i = 0, posA = 0, posB = 0; i < this.sections.length;) {
      let len = this.sections[i++], ins = this.sections[i++]
      if (ins < 0) {
        while (i < this.sections.length && this.sections[i + 1] < 0) {
          len += this.sections[i]
          i += 2
        }
        f(posA, posB, len)
        posB += len
      } else {
        posB += ins
      }
      posA += len
    }
  }
}

export class ChangeSet extends ChangeDesc {
  constructor(
    sections: readonly number[],
    readonly data: readonly SectionData[]
  ) {
    super(sections)
  }

  apply(doc: DocNode) {
    if (this.empty) return doc
    let builder = new Builder(doc)
    let cursor = Context.atStart(doc)
    for (let i = 0, iS = 0; i < this.data.length; i++) {
      let lenA = this.sections[iS++], lenB = this.sections[iS++]
      if (lenB < 0) {
        builder.modifications = this.data[i] as (null | readonly Modification[])
        cursor = cursor.advance(lenA, builder)
        builder.modifications = null
      } else {
        cursor = cursor.advance(lenA)
        ;(this.data[i] as Slice).run(builder)
      }
    }
    if (cursor.parent || cursor.index != (cursor.node.isText() ? cursor.node.text.length : cursor.node.children.length))
      throw new Error("Change doesn't cover the entire document")
    return builder.finish()
  }

  get desc() { return new ChangeDesc(this.sections) }

  eq(other: ChangeDesc) {
    if (!(other instanceof ChangeSet) && super.eq(other)) return false
    for (let i = 0; i < this.data.length; i++) {
      let a = this.data[i] as any, b = (other as ChangeSet).data[i] as any
      if (a && !(this.sections[(i << 1) + 1] < 0 ? compareModifications(a, b) : a.eq(b))) return false
    }
    return true
  }

  toJSON(): ChangeSetJSON {
    return this.data.map((data, i) => {
      let length = this.sections[i << 1], type = this.sections[(i << 1) + 1]
      return type >= 0 ? {length, replacement: (data as Slice).toJSON()}
        : data ? {length, modifications: (data as readonly Modification[]).map(modificationToJSON)}
        : {length}
    })
  }

  static fromJSON(schema: Schema, json: ChangeSetJSON) {
    if (!Array.isArray(json)) throw new Error("Invalid ChangeSet JSON")
    let sections: number[] = [], data: SectionData[] = []
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

  map(other: ChangeSet, doc: DocNode, before: boolean = false): ChangeSet {
    if (this.length != doc.length || other.length != doc.length)
      throw new Error("Mapping a change that doesn't match the start document")
    // Produce a copy of setA that applies to the document after setB
    // has been applied. Assumes both start at the same document (`doc`).
    let sections: number[] = [], data: SectionData[] = []
    let fitter = new ChangeFitter(doc)
    let a = new SectionIter(this), b = new SectionIter(other), pos = 0
    // Iterate over both sets in parallel. inserted tracks, for changes
    // in A that have to be processed piece-by-piece, whether their
    // content has been inserted already, and refers to the section
    // index.
    for (let inserted = -1;;) {
      if (a.keep && b.keep) {
        // Move across ranges skipped by both sets.
        let len = Math.min(a.len, b.len)
        let mods = before ? a.mods : filterMods(a.mods, b.mods)
        addSection(sections, data, len, mods ? -2 : -1, mods)
        a.forward(len)
        b.forward(len)
        fitter.preserved(pos, pos += len)
      } else if (b.ins >= 0 && (a.ins < 0 || inserted == a.i || a.off == 0 && (b.len < a.len || b.len == a.len && !before))) {
        // If there's a change in B that comes before the next change in
        // A (ordered by start pos, then len, then before flag), skip
        // that (and process any changes in A it covers).
        let end = pos + b.len
        addSection(sections, data, b.ins, -1, null)
        fitter.replaced(b.slice, pos, end, true)
        while (pos < end) {
          let piece = Math.min(a.len, end - pos)
          if (a.ins >= 0 && inserted < a.i && a.len <= piece) {
            addSection(sections, data, 0, a.ins, a.slice)
            fitter.replaced(a.slice, pos - a.off, pos + a.len)
            inserted = a.i
          }
          a.forward(piece)
          pos += piece
        }
        b.next()
      } else if (a.ins >= 0) {
        // Process the part of a change in A up to the start of the next
        // non-deletion change in B (if overlapping).
        let start = pos, end = pos + a.len, len = 0
        while (pos < end) {
          if (b.keep) {
            let piece = Math.min(end - pos, b.len)
            pos += piece
            len += piece
            b.forward(piece)
          } else if (b.ins == 0 && pos + b.len < end) {
            fitter.replaced(b.slice, pos, pos += b.len, true)
            b.next()
          } else {
            break
          }
        }
        if (inserted < a.i) {
          addSection(sections, data, len, a.ins, a.slice)
          fitter.replaced(a.slice, start - a.off, start + a.len)
          inserted = a.i
        } else {
          addSection(sections, data, len, 0, Slice.empty)
        }
        a.forward(pos - start)
      } else {
        if (!a.done || !b.done) throw new Error("Mismatched change set lengths")
        let fit = fitter.finish(), base = new ChangeSet(sections, data)
        return fit ? base.compose(fit) : base
      }
    }
  }

  compose(other: ChangeSet): ChangeSet { return compose(this, other, true) as ChangeSet }

  invert(doc: DocNode) {
    let sections: number[] = [], data: SectionData[] = []
    for (let i = 0, iS = 0, pos = 0; iS < this.sections.length; iS += 2, i++) {
      let len = this.sections[iS], ins = this.sections[iS + 1]
      if (ins >= 0) {
        addSection(sections, data, ins, len, doc.slice(pos, pos + len))
      } else {
        let mods = this.data[i] as readonly Modification[] | null
        let at = pos, end = pos + len
        if (mods) doc.iterate(pos, end, (node, nodePos) => {
          if (node.isLeaf() || nodePos >= pos && nodePos < end) {
            let [from, to] = node.isText()
              ? [Math.max(at, nodePos), Math.min(end, nodePos + node.length)]
              : [nodePos, nodePos + 1]
            if (at < from) addSection(sections, data, from - at, -1, null)
            addSection(sections, data, to - from, -2, invertMods(mods!, node))
            at = to
          }
        })
        if (at < end) addSection(sections, data, end - at, -1, null)
      }
      pos += len
    }
    return new ChangeSet(sections, data)
  }

  /// Iterate over the ranges in this changeset, calling `replaced`
  /// for ranges that have been replaced, and `preserved` for ranges
  /// that are either preserved as-is (when `modifications` is null)
  /// or only have properties modified.
  iterChanges(replaced: (fromA: number, toA: number, fromB: number, toB: number, inserted: Slice) => void,
              preserved?: (fromA: number, toA: number, fromB: number, toB: number, modifications: readonly Modification[] | null) => void) {
    for (let posA = 0, posB = 0, i = 0, iS = 0; i < this.data.length;) {
      let len = this.sections[iS++], ins = this.sections[iS++], data = this.data[i++]
      if (ins < 0) {
        if (preserved) preserved(posA, posA + len, posB, posB + len, data as any)
        posA += len; posB += len
      } else {
        replaced(posA, posA += len, posB, posB += ins, data as Slice)
      }
    }
  }

  static create(doc: DocNode, spec: ChangeSpec): ChangeSet {
    let sections: number[] = [], data: SectionData[] = [], pos = 0
    let accum: ChangeSet | null = null
    let section = (from: number, to: number, ins: number, value: SectionData) => {
      if (from < pos) flush()
      if (from > pos) addSection(sections, data, from - pos, -1, null)
      addSection(sections, data, to - from, ins, value)
      pos = to
    }
    let flush = () => {
      if (sections.length) {
        if (pos < doc.length) addSection(sections, data, doc.length - pos, -1, null)
        add(new ChangeSet(sections, data))
        sections = []; data = []; pos = 0
      }
    }
    let add = (set: ChangeSet) => {
      accum = accum ? accum.compose(set.map(accum, doc)) : set
    }
    let explore = (spec: ChangeSpec) => {
      if (Array.isArray(spec)) {
        spec.forEach(explore)
      } else if (spec instanceof ChangeSet) {
        if (spec.length != doc.length) throw new Error("Mismatched change set length")
        flush()
        add(spec)
      } else {
        const {from, add, remove, insert} = spec
        let modifies = add || remove
        if (modifies && !insert) {
          let to = spec.to ?? spec.from + 1
          if (add) {
            let mods: Modification[] = [{add: add}]
            markableSections(doc, from, to, (node, from, to) => {
              if (!add.type.canTarget(node.tag.type)) return false
              let has = node.tag.hasProp(add.type)
              if (add.type.set) {
                let modsHere = mods
                if (has) {
                  let left = subtractSet(add.value as any[], has.value as any[], add.type.set)
                  if (!left.length) return false
                  modsHere = [{add: add.type.of(left)}]
                }
                section(from, to, -2, modsHere)
              } else if (!has || !has.eq(add)) {
                section(from, to, -2, mods)
              }
              return true
            })
          }
          if (remove) {
            let mods: Modification[] = [{remove: remove}]
            markableSections(doc, from, to, (node, from, to) => {
              const has = node.tag.hasProp(remove)
              if (!has || !remove.type.canTarget(node.tag.type)) return false
              let modsHere = mods
              if (remove.type.set) {
                let left = subtractSet(remove.value as any[], has.value as any[], remove.type.set!)
                if (!left.length) return false
                modsHere = [{remove: remove.type.of(left)}]
              }
              section(from, to, -2, modsHere)
              return true
            })
          }
        } else {
          let to = spec.to ?? spec.from
          if (to <= from) to = from
          if (insert || to != from)
            section(from, to, insert ? insert.length : 0, insert || Slice.empty)
        }
      }
    }
    explore(spec)
    flush()
    return accum || ChangeSet.empty(doc.length)
  }

  static createChecked(doc: DocNode, spec: ChangeSpec): ChangeSet {
    let base = ChangeSet.create(doc, spec)
    let fitter = new ChangeFitter(doc)
    for (let i = 0, iS = 0, pos = 0; i < base.data.length; i++) {
      let len = base.sections[iS++], ins = base.sections[iS++]
      if (ins < 0) fitter.preserved(pos, pos += len)
      else fitter.replaced(base.data[i] as Slice, pos, pos += len)
    }
    let fit = fitter.finish()
    return fit ? base.compose(fit) : base
  }

  static empty(length: number) {
    return length ? new ChangeSet([length, -1], [null]) : new ChangeSet([], [])
  }

  /// @internal
  toString() {
    let result = ""
    for (let i = 0, iS = 0, pos = 0; i < this.data.length; i++) {
      let len = this.sections[iS++], ins = this.sections[iS++], data = this.data[i]
      let text = ""
      if (ins >= 0) {
        text += data
      } else if (data) {
        text += `[${(data as readonly Modification[]).map(mod => {
          return `${isAdd(mod) ? "+" + mod.add : "-" + mod.remove}`
        })}]`
      }
      if (text) result += `${result ? "," : ""}${pos}${len ? `-${pos + len}` : ""}${text}`
      pos += len
    }
    return result
  }
}

function compose<T extends ChangeDesc>(chA: T, chB: T, isSet: boolean): ChangeSet | ChangeDesc {
  let sections: number[] = [], data: SectionData[] | null = isSet ? [] : null
  let a = new SectionIter(chA), b = new SectionIter(chB)
  for (let open = false;;) {
    if (a.done && b.done) {
      return isSet ? new ChangeSet(sections, data!) : new ChangeDesc(sections)
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
      if (a.keep && b.keep) {
        let mods = combineMods(a.mods, b.mods)
        addSection(sections, data, len, mods ? -2 : -1, mods, open)
      } else if (a.keep) {
        addSection(sections, data, len, b.off ? 0 : b.ins, b.off ? Slice.empty : b.slice, open)
      } else if (b.keep) {
        addSection(sections, data, a.off ? 0 : a.len, len, applyModsToSlice(a.slicePart(len), b.mods), open)
      } else {
        addSection(sections, data, a.off ? 0 : a.len, b.off ? 0 : b.ins, b.off ? Slice.empty : b.slice, open)
      }
      open = (a.ins > len || b.ins >= 0 && b.len > len) && (open || sections.length > sectionLen)
      a.forward2(len)
      b.forward(len)
    }
  }
}

function combineMods(a: null | readonly Modification[], b: null | readonly Modification[]): null | readonly Modification[] {
  return !a ? b : !b ? a : a.concat(b)
}

function filterMods(mods: null | readonly Modification[], against: null | readonly Modification[]) {
  if (!mods || !against) return mods
  return mods.filter(m => !against!.some(a => modCancels(a, m)))
}

function modCancels(mod: Modification, other: Modification) {
  if (isAdd(other)) {
    return isAdd(mod) ? mod.add.type == other.add.type && !mod.add.type.set : mod.remove.eq(other.add)
  } else {
    return isAdd(mod) && mod.add.eq(isAdd(other) ? other.add : other.remove)
  }
}

function invertMods(mods: readonly Modification[], target: Node): readonly Modification[] {
  return mods.map(mod => {
    if (isRemove(mod)) return {add: mod.remove}
    if (!mod.add.type.set) {
      let existed = target.tag.hasProp(mod.add.type)
      if (existed) return {add: existed}
    }
    return {remove: mod.add}
  })
}

function applyModsToSlice(slice: Slice, mods: readonly Modification[] | null) {
  if (!mods) return slice
  let content: Token[] = []
  for (let tok of slice.content) {
    if (tok.tokenType == TokenType.Open) {
      content.push(new OpenToken(applyModifications(mods, tok.tag)))
    } else if (tok.tokenType == TokenType.Node) {
      let node = applyModifications(mods, tok.tag).create(tok.children)
      if (content.length && content[content.length - 1].tokenType == TokenType.Node)
        node.pushTo(content as Node[])
      else
        content.push(node)
    } else {
      content.push(tok)
    }
  }
  return new Slice(content)
}

const enum FitFlag {
  None = 0,
  NeedsChild = 1,
  Synthetic = 2
}

class FitLevel {
  flags = FitFlag.None

  constructor(
    readonly tag: Tag,
    readonly next: FitLevel | null,
  ) {
    if (!this.tag.inlineContent() && !this.tag.isLeaf()) this.flags |= FitFlag.NeedsChild
  }
}

const counter = {
  count: 0,
  skip() {},
  enter() { this.count++ },
  leave() { this.count-- },
  countDelta(pos: Context, distance: number) {
    this.count = 0
    return pos.advance(distance, this)
  }
}

class ChangeFitter implements Walker {
  stack: FitLevel
  inputPos: Context
  delInputPos: Context
  pos = 0
  patches: {from: number, to: number, insert: Token[]}[] = []
  stackDelta = 0
  inputDelta = 0
  inserting = false

  constructor(readonly doc: DocNode) {
    this.stack = new FitLevel(doc.tag, null)
    this.inputPos = this.delInputPos = Context.atStart(doc)
  }

  getPos(at: number) {
    let {inputPos, delInputPos} = this
    if (inputPos.pos == at) return inputPos
    if (delInputPos.pos == at) return delInputPos
    return inputPos.advance(at - inputPos.pos)
  }

  preserved(from: number, to: number) {
    let inputPos = this.getPos(from)
    if (!this.inputDelta && this.stackDelta) {
      this.syncToContext(inputPos)
      this.stackDelta = 0
    }

    this.inputPos = inputPos.advance(to - from, this)
  }

  lastCoverFrom = -1
  lastCoverTo = -1
  doubleDeleteDelta = 0

  replaced(slice: Slice, from: number, to: number, covering = false) {
    this.doubleDeleteDelta = 0
    if (covering) {
      this.lastCoverFrom = from
      this.lastCoverTo = to
    } else if (slice.length) {
      let overlapFrom = Math.max(from, this.lastCoverFrom)
      let overlapTo = Math.min(to, this.lastCoverTo)
      if (overlapFrom < overlapTo) {
        counter.countDelta(this.getPos(overlapFrom), overlapTo - overlapFrom)
        this.doubleDeleteDelta = counter.count
      }
    }
    if (from != to) {
      this.delInputPos = counter.countDelta(this.getPos(from), to - from)
      this.inputDelta -= counter.count
    }
    this.inserting = true
    slice.run(this)
    this.inserting = false
  }

  fit(tag: Tag) {
    if (this.stack.tag.type.canContain(tag.type)) return true
    let fix: {leave: number, enter: readonly Tag[], cost: number} | null = null
    let dDelta = this.stackDelta - this.inputDelta
    for (let level: FitLevel | null = this.stack, leave = 0, leaveCost = 0; level; level = level.next, leave++) {
      if (fix && leaveCost > fix.cost) break
      let enter = this.doc.schema.findWrapping(level.tag, tag)
      if (enter) {
        let cost = leaveCost + enter.length * 2 - Math.max(0, Math.min(-dDelta, enter.length))
        if (!fix || fix.cost > cost) fix = {leave, enter, cost}
      }
      leaveCost += level.flags & FitFlag.Synthetic ? 0 : dDelta > leave ? 1 : 2
    }
    if (!fix) return false
    for (let i = 0; i < fix.leave; i++) {
      this.insertClose()
      this.stackDelta--
    }
    for (let wrapper of fix.enter) {
      this.patch(0, new OpenToken(wrapper))
      this.stack.flags &= ~FitFlag.NeedsChild
      this.stack = new FitLevel(wrapper, this.stack)
      this.stack.flags |= FitFlag.Synthetic
      this.stackDelta++
    }
    return true
  }

  syncToContext(context: Context) {
    // FIXME make this elegant somehow
    let levels = [], depth = context.depth
    for (let l = this.stack as FitLevel | null; l; l = l.next) levels.push(l)
    levels.reverse()
    while (levels.length > depth + 1) { this.insertClose(); levels.pop() }
    for (let d = 1; d <= Math.min(depth, levels.length - 1); d++) {
      let cx = context.atDepth(d)
      if (!cx.node.tag.type.sharesContent(levels[d].tag.type)) {
        while (levels.length > d) { this.insertClose(); levels.pop() }
        break
      }
    }
    for (let i = levels.length; i < depth + 1; i++) {
      let cx = context.atDepth(i)
      this.stack = new FitLevel(cx.node.tag, this.stack)
      this.patch(0, new OpenToken(cx.node.tag))
    }
  }

  insertClose() {
    if (this.stack.flags & FitFlag.NeedsChild) this.patch(0, this.doc.schema.createDefault(this.stack.tag.type), CloseToken)
    else this.patch(0, CloseToken)
    this.stack = this.stack.next!
  }

  patch(length: number, ...insert: Token[]) {
    let prev = this.patches.length ? this.patches[this.patches.length - 1] : null
    if (prev && prev.to == this.pos) {
      prev.to += length
      for (let tok of insert) prev.insert.push(tok)
    } else {
      this.patches.push({from: this.pos, to: this.pos + length, insert})
    }
  }

  skip(node: Node) {
    if (this.fit(node.tag))
      this.stack.flags &= ~FitFlag.NeedsChild
    else
      this.patch(node.length)
    this.pos += node.length
  }

  enter(tag: Tag) {
    if (this.inserting) this.inputDelta++
    if (this.doubleDeleteDelta > 0) {
      this.doubleDeleteDelta--
      this.patch(1)
    } else if (this.fit(tag)) {
      this.stack.flags &= ~FitFlag.NeedsChild
      this.stack = new FitLevel(tag, this.stack)
      if (this.inserting) this.stackDelta++
    } else {
      this.patch(1)
    }
    this.pos++
  }

  leave() {
    if (this.inserting) this.inputDelta--
    if (this.doubleDeleteDelta < 0) {
      this.doubleDeleteDelta++
      this.patch(1)
    } else if (this.stack.next) {
      if (this.stack.flags & FitFlag.NeedsChild) this.patch(0, this.doc.schema.createDefault(this.stack.tag.type))
      this.stack = this.stack.next
      if (this.inserting) this.stackDelta++
    } else {
      this.patch(1)
    }
    this.pos++
  }

  finish(): ChangeSet | null {
    while (this.stack.next || (this.stack.flags && FitFlag.NeedsChild)) {
      if (this.stack.flags & FitFlag.NeedsChild) {
        this.patch(0, this.doc.schema.createDefault(this.stack.tag.type))
        this.stack.flags &= ~FitFlag.NeedsChild
      } else {
        this.patch(0, CloseToken)
        this.stack = this.stack.next!
      }
    }
    if (!this.patches.length) return null
    let sections: number[] = [], data: SectionData[] = [], pos = 0
    for (let {from, to, insert} of this.patches) {
      addSection(sections, data, from - pos, -1, null)
      let slice = new Slice(insert)
      addSection(sections, data, to - from, slice.length, slice)
      pos = to
    }
    addSection(sections, data, this.pos - pos, -1, null)
    return new ChangeSet(sections, data)
  }
}

function markableSections(doc: Node, from: number, to: number, f: (n: Node, from: number, to: number) => boolean) {
  doc.iterate(from, to, (node, pos) => {
    if ((pos >= from && pos + node.length <= to) || node.isText()) {
      if (node.isText() ? f(node, Math.max(pos, from), Math.min(pos + node.length, to)) : f(node, pos, pos + 1))
        return false
    }
  })
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
  /// Return null if the token _before_ the position is deleted.
  TrackBefore,
  /// Return null if the token _after_ the position is deleted.
  TrackAfter
}

class SectionIter {
  i = 0
  len!: number
  off!: number
  ins!: number

  constructor(readonly set: ChangeDesc) {
    this.next()
  }

  next() {
    let {sections} = this.set
    if (this.i < sections.length) {
      this.len = sections[this.i++]
      this.ins = sections[this.i++]
    } else {
      this.len = 0; this.ins = -3
    }
    this.off = 0
  }

  get keep() { return this.ins == -1 || this.ins == -2 }

  get done() { return this.ins == -3 }

  get len2() { return this.ins < 0 ? this.len : this.ins }

  get mods() {
    if (this.set instanceof ChangeSet)
      return this.set.data[(this.i - 2) >> 1] as readonly Modification[] | null
    return null
  }

  get slice() {
    if (this.set instanceof ChangeSet)
      return this.set.data[(this.i - 2) >> 1] as Slice
    return Slice.empty
  }

  slicePart(len?: number) {
    return this.slice.slice(this.off, len == null ? undefined : this.off + len)
  }

  forward(len: number) {
    if (len == this.len) this.next()
    else { this.len -= len; this.off += len }
  }

  forward2(len: number) {
    if (this.keep) this.forward(len)
    else if (len == this.ins) this.next()
    else { this.ins -= len; this.off += len }
  }
}

function addSection(sections: number[], data: SectionData[] | null,
                    len: number, ins: number, value: SectionData,
                    forceJoin = false) {
  if (len == 0 && ins <= 0) return
  let last = sections.length - 2
  if (last >= 0 && ins <= 0 && ins == sections[last + 1]) {
    // Deletion or preserved section that matches the last element in `sections`
    let lastValue = data ? data[data.length - 1] : null
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
    if (data) data[data.length - 1] = (data[data.length - 1] as Slice).concat(value as Slice)
  } else {
    sections.push(len, ins)
    if (data) data.push(value)
  }
}
