import {Plot, Node} from "./node"
import { Mark, subtractSet } from "./mark"
import {Schema} from "./schema"
import {Slice, Token} from "./slice"
import {Pos} from "./pos"
import {validate} from "./helper"
import {ValidationError} from "./error"

class BuildContext {
  children: Plot[] = []
  constructor(readonly tag: Plot.Tag.Any, readonly parent: BuildContext | null) {}
}

class Builder implements Pos.Walker, Slice.Walker {
  stack: BuildContext
  modifications: readonly Modification[] | null = null
  schema: Schema

  constructor(doc: Plot.Doc) {
    this.schema = doc.schema
    this.stack = new BuildContext(doc.tag, null)
  }

  add(node: Node) {
    if (this.modifications) {
      if (node.isPlot) throw new ValidationError("Invalid modification on non-leaf node")
      node = node.withMarks(applyModifications(this.modifications, node.marks, node.type))
    }
    node.pushTo(this.stack.children)
  }    

  enterPlot(plot: Plot) {
    this.open(plot.tag)
  }

  leavePlot() {
    if (this.modifications) throw new ValidationError("Invalid modification on close token")
    if (!this.stack.parent) throw new ValidationError("Surplus close token after " + this.stack.children)
    let top = this.stack
    this.stack = this.stack.parent
    this.add(top.tag.create(top.children))
  }

  skip(node: Node) {
    this.add(node)
  }

  open(tag: Plot.Tag.Any) {
    if (this.modifications) tag = tag.withMarks(applyModifications(this.modifications, tag.marks, tag.type))
    this.stack = new BuildContext(tag, this.stack)
  }

  close() { this.leavePlot() }

  node(node: Node) { this.skip(node) }

  finish() {
    if (this.stack.parent) throw new ValidationError("Invalid change")
    return this.schema.doc(this.stack.children)
  }
}

type Modification = {add: Mark} | {remove: Mark}

function isAdd(m: Modification): m is {add: Mark} { return !!(m as any).add }
function isRemove(m: Modification): m is {remove: Mark} { return !!(m as any).remove }

function applyModifications(modifications: readonly Modification[], marks: readonly Mark[], type: Node.Type<any>) {
  for (const m of modifications) {
    if (isAdd(m)) {
      marks = m.add.addToSet(marks)
    } else {
      marks = m.remove.removeFromSet(marks)
    }
  }
  return marks
}

function modificationToJSON(m: Modification): ModificationJSON {
  return isAdd(m) ? {add: m.add.name, value: m.add.value} : {remove: m.remove.name, value: m.remove.value}
}

function modificationFromJSON(schema: Schema, json: ModificationJSON): Modification {
  let {add, remove} = json as {add?: string, remove?: string}
  if (typeof add == "string" || typeof remove == "string") {
    let mark = schema.getMark((add || remove)!)
    if (!mark) throw new ValidationError(`Unknown mark ${add || remove}`)
    let value = mark.of(validate(mark.spec.validate, json.value))
    if (mark) return add ? {add: value} : {remove: value}
  }
  throw new ValidationError("Invalid modification JSON")
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

/// Representation of a single document change. Changes can either
/// affect marks (when `add` or `remove` is present), or replace a
/// part of the document (otherwise).
export type Change = {
  /// The start position of the change.
  from: number
  /// The end position. When not given, this defaults to `from` for
  /// replacement changes, and `from + 1` for changes that add or
  /// remove marks.
  to?: number
  /// Replace the given range with this slice.
  insert?: Slice | readonly Token[]
  /// For deletions or insertions where it isn't obvious that the
  /// replacement will produce a valid document, set this to `true` or
  /// a stack of context labels to make the library process the
  /// replacement to make sure it fits. Context tags (passed with the
  /// innermost tag first, as in
  /// [`DocNode.contextAt`](#doc.DocNode.contextAt)) may be used as
  /// wrappers when fitting the slice.
  fit?: boolean | readonly Plot.Tag.Any[]
  /// Add the given mark to this change's range.
  add?: Mark<any>
  /// Remove the given mark from this range.
  remove?: Mark<any>
}

type SectionData = Slice | readonly Modification[] | null

const applyCache = new WeakMap<ChangeSet, {a: Plot.Doc, b: Plot.Doc}>()

export class ChangeSet {
  private _length = -1
  private _newLength = -1

  constructor(
    // Pairs of integers, first one representing the length of the
    // section in A, the second either -1 for a preserved, -2 for a
    // marked range, or a non-negative insertion length for a
    // replacement.
    readonly sections: ChangeSet.Sections,
    readonly data: readonly SectionData[]
  ) {}

  get length() {
    if (this._length < 0) {
      this._length = 0
      for (let i = 0; i < this.sections.length; i += 2) this._length += this.sections[i]
    }
    return this._length
  }

  get newLength() {
    if (this._newLength < 0) {
      this._newLength = 0
      for (let i = 0; i < this.sections.length; i += 2) {
        let ins = this.sections[i + 1]
        this._newLength += ins < 0 ? this.sections[i] : ins
      }
    }
    return this._newLength
  }

  get empty() { return this.sections.length == 0 || this.sections.length == 2 && this.sections[1] < 0 }

  eq(other: ChangeSet) {
    if (other.sections.length != this.sections.length) return false
    for (let i = 0; i < this.sections.length; i++)
      if (this.sections[i] != other.sections[i]) return false
    for (let i = 0; i < this.data.length; i++) {
      let a = this.data[i] as any, b = (other as ChangeSet).data[i] as any
      if (a && !(this.sections[(i << 1) + 1] < 0 ? compareModifications(a, b) : a.eq(b))) return false
    }
    return true
  }

  apply(doc: Plot.Doc) {
    if (this.length != doc.length)
      throw new ValidationError(`Trying to apply change of length ${this.length} to doc of length ${doc.length}`)
    if (this.empty) return doc
    let cached = applyCache.get(this)
    if (cached && doc.eq(cached.a)) return cached.b

    let builder = new Builder(doc)
    let cursor = Pos.atStart(doc)
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
    if (cursor.pos != doc.length)
      throw new ValidationError("Change doesn't cover the entire document")

    let newDoc = builder.finish()
    applyCache.set(this, {a: doc, b: newDoc})
    return newDoc
  }

  toJSON(): ChangeSet.JSON {
    return this.data.map((data, i) => {
      let length = this.sections[i << 1], type = this.sections[(i << 1) + 1]
      return type >= 0 ? {length, replacement: (data as Slice).toJSON()}
        : data ? {length, modifications: (data as readonly Modification[]).map(modificationToJSON)}
        : {length}
    })
  }

  static fromJSON(schema: Schema, json: ChangeSet.JSON) {
    if (!Array.isArray(json)) throw new ValidationError("Invalid ChangeSet JSON")
    let sections: number[] = [], data: SectionData[] = []
    for (let elt of json) {
      let {length} = elt
      if (typeof length != "number") throw new ValidationError("Invalid ChangeSet JSON")
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

  map(other: ChangeSet, doc: Plot.Doc, before: boolean = false): ChangeSet {
    return map(this, other, doc, before, true)
  }

  compose(other: ChangeSet): ChangeSet {
    let {sections, data} = compose(this.sections, other.sections, this.data, other.data)
    return new ChangeSet(sections, data!)
  }

  invert(doc: Plot.Doc) {
    let sections: number[] = [], data: SectionData[] = []
    for (let i = 0, iS = 0, pos = 0; iS < this.sections.length; iS += 2, i++) {
      let len = this.sections[iS], ins = this.sections[iS + 1]
      if (ins >= 0) {
        addSection(sections, data, ins, len, doc.slice(pos, pos + len))
      } else {
        let mods = this.data[i] as readonly Modification[] | null
        let at = pos, end = pos + len
        if (mods) doc.iterate(pos, end, (node, nodePos) => {
          if (node.isLeaf || nodePos >= pos && nodePos < end) {
            let [from, to] = node.isText
              ? [Math.max(at, nodePos), Math.min(end, nodePos + node.length)]
              : [nodePos, nodePos + 1]
            if (at < from) addSection(sections, data, from - at, -1, null)
            addSection(sections, data, to - from, -2, invertMods(mods!, node.tag))
            at = to
          }
        })
        if (at < end) addSection(sections, data, end - at, -1, null)
      }
      pos += len
    }
    return new ChangeSet(sections, data)
  }

  /// Returns the change itself if it can be applied to this document
  /// and produce a valid document, or a modified version of the
  /// change that _is_ correct.
  correct(doc: Plot.Doc, local = false) {
    let fitter = new ChangeFitter(doc, local)
    for (let i = 0, iS = 0, pos = 0; i < this.data.length; i++) {
      let len = this.sections[iS++], ins = this.sections[iS++]
      if (ins < 0) fitter.preserved(pos, pos += len)
      else fitter.replaced(this.data[i] as Slice, pos, pos += len)
    }
    let fit = fitter.finish()
    return fit ? this.compose(fit) : this
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

  touchesRange(from: number, to: number) {
    for (let i = 0, pos = 0; i < this.sections.length && pos <= to;) {
      let len = this.sections[i++], ins = this.sections[i++], end = pos + len
      if (ins >= 0 && pos <= to && end >= from) return pos < from && end > to ? "cover" : true
      pos = end
    }
    return false
  }

  /// Iterate over the ranges in this changeset, calling `replaced`
  /// for ranges that have been replaced, and `preserved` for ranges
  /// that are either preserved as-is (when `modifications` is null)
  /// or only have marks modified.
  iterChanges(replaced: (fromA: number, toA: number, fromB: number, toB: number, inserted: Slice) => void,
              preserved?: (fromA: number, toA: number, fromB: number, toB: number,
                           modifications: readonly Modification[] | null) => void) {
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

  /// Iterate over the sections of the document this change leaves
  /// unchanged or which have only mark changes. `posA` provides the
  /// position of the range in the original document, `posB` the
  /// position in the changed document.
  iterGaps(gap: (fromA: number, toA: number, fromB: number, toB: number) => void,
           change?: (fromA: number, toA: number, fromB: number, toB: number) => void) {
    for (let i = 0, posA = 0, posB = 0; i < this.sections.length;) {
      let len = this.sections[i++], ins = this.sections[i++]
      if (ins < 0) {
        while (i < this.sections.length && this.sections[i + 1] < 0) {
          len += this.sections[i]
          i += 2
        }
        gap(posA, posA + len, posB, posB + len)
        posB += len
      } else {
        while (i < this.sections.length && this.sections[i + 1] >= 0) {
          len += this.sections[i++]
          ins += this.sections[i++]
        }
        if (change) change(posA, posA + len, posB, posB + ins)
        posB += ins
      }
      posA += len
    }
  }

  /// Iterate over the ranges changed (either replaced or modified) by
  /// this change desc.
  iterChangedRanges(range: (fromA: number, toA: number, fromB: number, toB: number) => void) {
    for (let i = 0, posA = 0, posB = 0; i < this.sections.length;) {
      let len = this.sections[i++], ins = this.sections[i++]
      if (ins == -1) {
        posB += len
      } else {
        if (ins == -2) ins = len
        while (i < this.sections.length && this.sections[i + 1] != -1) {
          let addLen = this.sections[i++], addIns = this.sections[i++]
          len += addLen
          ins += addIns == -2 ? addLen : addIns
        }
        range(posA, posA + len, posB, posB + ins)
        posB += ins
      }
      posA += len
    }
  }

  static create(doc: Plot.Doc, spec: ChangeSet.Spec): ChangeSet {
    return createChangeSet(doc, spec)
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

  static composeSections(a: ChangeSet.Sections, b: ChangeSet.Sections): ChangeSet.Sections {
    return compose(a, b).sections
  }
}

export namespace ChangeSet {
  export type Sections = readonly number[]

  export type Spec = Change | {correct: ChangeSet.Spec, local?: boolean} | ChangeSet | readonly ChangeSet.Spec[]

  export type JSON = readonly {
    length: number
    modifications?: readonly ModificationJSON[]
    replacement?: Slice.JSON
  }[]
}

type ModificationJSON = {add: string, value: any} | {remove: string, value: any}

class ChangeSetBuilder {
  constructor(readonly docLen: number) {}

  sections: number[] = []
  data: SectionData[] = []
  pos = 0
}

function createChangeSet(doc: Plot.Doc, spec: ChangeSet.Spec, mayCorrect = true): ChangeSet {
  let cur: ChangeSetBuilder | null = null
  let accum: ChangeSet | null = null
  let doCorrect = false

  let flush = () => {
    if (cur) {
      if (cur.pos < cur.docLen) addSection(cur.sections, cur.data, cur.docLen - cur.pos, -1, null)
      push(new ChangeSet(cur.sections, cur.data))
      cur = null
    }
  }
  let push = (set: ChangeSet) => {
    accum = accum ? accum.compose(map(set, accum, doc, false, false)) : set
  }
  let section = (from: number, to: number, ins: number, value: SectionData) => {
    if (!cur || from < cur.pos) {
      flush()
      cur = new ChangeSetBuilder(doc.length)
    }
    if (from > cur.pos) addSection(cur.sections, cur.data, from - cur.pos, -1, null)
    addSection(cur.sections, cur.data, to - from, ins, value)
    cur.pos = to
  }

  let build = (spec: ChangeSet.Spec) => {
    if (Array.isArray(spec)) {
      for (let elt of spec) build(elt)
    } else if (spec instanceof ChangeSet) {
      flush()
      push(spec)
    } else if ((spec as any).correct) {
      flush()
      let {correct, local} = spec as any
      let inner = createChangeSet(doc, correct, false)
      push(mayCorrect || local ? inner.correct(doc, local) : inner)
    } else {
      let {from, to, add, remove, insert, fit} = spec as Change
      let modifies = add || remove
      if (modifies) {
        if (insert)
          throw new ValidationError(`A Change object cannot both ${add ? "add" : "remove"} a mark and replace a range`)
        if (to == null) to = from + 1
        if (add) {
          let mods: Modification[] = [{add}]
          markableSections(doc, from, to, add.type.spanning, (node, from, to) => {
            if (!doc.schema.markAllowed(add.type, node.type)) return false
            let has = add.type.isInSet(node.tag.marks)
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
          let mods: Modification[] = [{remove}]
          markableSections(doc, from, to, remove.type.spanning, (node, from, to) => {
            const has = remove.isInSet(node.tag.marks)
            if (!has || !doc.schema.markAllowed(remove.type, node.type)) return false
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
        if (to == null) to = from
        insert = (!insert ? Slice.empty : Array.isArray(insert) ? new Slice(insert) : insert) as Slice
        if (to <= from) to = from
        if (fit) {
          doCorrect = true
          ;({from, to, slice: insert} =
            fitReplacement(doc, doc.resolve(from), doc.resolve(to), insert, fit === true ? [] : fit))
        }
        if (insert.length || to != from)
          section(from, to, insert.length, insert)
      }
    }
  }
  build(spec)
  flush()
  return !accum ? ChangeSet.empty(doc.length) : doCorrect && mayCorrect ? (accum as any).correct(doc) : accum
}

function map(setA: ChangeSet, setB: ChangeSet, doc: Plot.Doc, before: boolean, fit: boolean) {
  if (setA.length != doc.length || setB.length != doc.length)
    throw new ValidationError("Mapping a change that doesn't match the start document")
  // Produce a copy of setA that applies to the document after setB
  // has been applied. Assumes both start at the same document (`doc`).
  let sections: number[] = [], data: SectionData[] = []
  let fitter = fit ? new ChangeFitter(doc, false) : null
  let a = new SectionIter(setA.sections, setA.data), b = new SectionIter(setB.sections, setB.data), pos = 0
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
      if (fitter) fitter.preserved(pos, pos + len)
      pos += len
    } else if (b.ins >= 0 && (a.ins < 0 || inserted == a.i || a.off == 0 && (b.len < a.len || b.len == a.len && !before))) {
      // If there's a change in B that comes before the next change in
      // A (ordered by start pos, then len, then before flag), skip
      // that (and process any changes in A it covers).
      let end = pos + b.len
      addSection(sections, data, b.ins, -1, null)
      if (fitter) fitter.replaced(b.slice, pos, end, true)
      while (pos < end) {
        if (a.done) throw new ValidationError("Mismatched change sets")
        let piece = Math.min(a.len, end - pos)
        if (a.ins >= 0 && inserted < a.i && a.len <= piece) {
          addSection(sections, data, 0, a.ins, a.slice)
          if (fitter) fitter.replaced(a.slice, pos - a.off, pos + a.len)
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
          if (fitter) fitter.replaced(b.slice, pos, pos + b.len, true)
          pos += b.len
          b.next()
        } else {
          break
        }
      }
      if (inserted < a.i) {
        addSection(sections, data, len, a.ins, a.slice)
        if (fitter) fitter.replaced(a.slice, start - a.off, start + a.len)
        inserted = a.i
      } else {
        addSection(sections, data, len, 0, Slice.empty)
      }
      a.forward(pos - start)
    } else {
      let correction = fitter && fitter.finish(), base = new ChangeSet(sections, data)
      return correction ? base.compose(correction) : base
    }
  }
}

function compose(
  sectionsA: ChangeSet.Sections, sectionsB: ChangeSet.Sections,
  dataA?: readonly SectionData[], dataB?: readonly SectionData[]
): {sections: ChangeSet.Sections, data: readonly SectionData[] | null} {
  let sections: number[] = [], data: SectionData[] | null = dataA ? [] : null
  let a = new SectionIter(sectionsA, dataA), b = new SectionIter(sectionsB, dataB)
  for (let open = false;;) {
    if (a.done && b.done) {
      return {sections, data}
    } else if (a.ins == 0) { // Deletion in A
      addSection(sections, data, a.len, 0, a.slice, open)
      a.next()
    } else if (b.len == 0 && !b.done) { // Insertion in B
      addSection(sections, data, 0, b.ins, b.slice, open)
      b.next()
    } else if (a.done || b.done) {
      throw new ValidationError("Mismatched change set lengths")
    } else {
      let len = Math.min(a.len2, b.len), sectionLen = sections.length
      if (a.keep && b.keep) {
        let mods = combineMods(a.mods, b.mods)
        addSection(sections, data, len, (data ? mods : a.ins == -2 || b.ins == -2) ? -2 : -1, mods, open)
      } else if (a.keep) {
        addSection(sections, data, len, b.off ? 0 : b.ins, b.off ? Slice.empty : b.slice, open)
      } else if (b.keep) {
        addSection(sections, data, a.off ? 0 : a.len, len, data ? applyModsToSlice(a.slicePart(len), b.mods) : null, open)
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

function invertMods(mods: readonly Modification[], target: Node.Tag): readonly Modification[] {
  return mods.map(mod => {
    if (isRemove(mod)) return {add: mod.remove}
    if (!mod.add.type.set) {
      let existed = mod.add.type.isInSet(target.marks)
      if (existed) return {add: existed}
    }
    return {remove: mod.add}
  })
}

function applyModsToSlice(slice: Slice, mods: readonly Modification[] | null) {
  if (!mods) return slice
  let content: Token[] = []
  for (let tok of slice.content) {
    if (tok.tokenType == Token.Type.Open) {
      content.push(tok.withMarks(applyModifications(mods, tok.marks, tok.type)))
    } else if (tok.tokenType == Token.Type.Node) {
      let node = tok.withMarks(applyModifications(mods, tok.marks, tok.type))
      if (content.length && content[content.length - 1].tokenType == Token.Type.Node)
        node.pushTo(content as Plot[])
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
    readonly tag: Plot.Tag.Any,
    readonly next: FitLevel | null,
  ) {
    if (!this.tag.inlineContent && !this.tag.isLeaf) this.flags |= FitFlag.NeedsChild
  }
}

const counter = {
  count: 0,
  skip() {},
  enterPlot() { this.count++ },
  leavePlot() { this.count-- },
  countDelta(pos: Pos, distance: number) {
    this.count = 0
    return pos.advance(distance, this)
  }
}

class ChangeFitter implements Pos.Walker {
  stack: FitLevel
  inputPos: Pos
  delInputPos: Pos
  pos = 0
  patches: {from: number, to: number, insert: Token[]}[] = []
  stackDelta = 0
  inputDelta = 0
  inserting = false
  activeContext: Pos | null = null
  activeContextPos = -1
  nextSync = -1
  schema: Schema

  constructor(doc: Plot.Doc, readonly local: boolean) {
    this.schema = doc.schema
    this.stack = new FitLevel(doc.tag, null)
    this.inputPos = this.delInputPos = Pos.atStart(doc)
  }

  getPos(at: number) {
    let {inputPos, delInputPos} = this
    if (inputPos.pos == at) return inputPos
    if (delInputPos.pos == at) return delInputPos
    return inputPos.advance(at - inputPos.pos)
  }

  preserved(from: number, to: number) {
    let {nextSync} = this
    if (nextSync >= from && nextSync <= to) {
      this.stackDelta = 0
      this.nextSync = -1
      if (nextSync > from) this.preserved(from, nextSync)
      this.syncToContext(this.inputPos)
      if (to > nextSync) this.preserved(nextSync, to)
      return
    }

    let inputPos = this.getPos(from)
    if (!this.inputDelta && this.stackDelta) {
      this.syncToContext(inputPos)
      this.stackDelta = 0
    }
    this.activeContext = inputPos
    this.activeContextPos = this.pos
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
    slice.run(this, this.pos)
    this.inserting = false

    if (this.local)
      this.nextSync = Math.max(this.nextSync, localSyncPosAfter(this.inputPos = this.getPos(to)))
  }

  fit(tag: Node.Tag) {
    if (this.schema.canContain(this.stack.tag.type, tag.type)) return true
    let fix: {leave: number, enter: readonly Plot.Tag.Any[], cost: number, context: boolean} | null = null
    let dDelta = this.stackDelta - this.inputDelta
    for (let level: FitLevel | null = this.stack, leave = 0, leaveCost = 0; level; level = level.next, leave++) {
      if (fix && leaveCost > fix.cost) break
      let enter = this.schema.findWrapping(level.tag.type, tag.type)
      if (enter) {
        let cost = leaveCost + enter.length * 2 - Math.max(0, Math.min(-dDelta, enter.length))
        if (!fix || fix.cost > cost && !fix.context)
          fix = {leave, enter, cost, context: false}
      }
      if (this.activeContextPos == this.pos) {
        let top = this.activeContext?.parent || null
        for (let cx = top, i = 1; cx; cx = cx.parent, i++) {
          if (this.schema.canContain(level.tag.type, cx.node.type)) {
            let cost = leaveCost + i * 2 - Math.max(0, Math.min(-dDelta, i))
            if (!fix || fix.cost > cost || !fix.context) {
              let enter: Plot.Tag.Any[] = []
              for (let scan = top;; scan = scan!.parent) {
                enter.unshift(scan!.node.tag)
                if (scan == cx) break
              }
              fix = {leave, enter, cost, context: true}
            }
            break
          }
        }
      }
      leaveCost += level.flags & FitFlag.Synthetic ? 0 : dDelta > leave ? 1 : 2
    }
    if (!fix) return false
    for (let i = 0; i < fix.leave; i++) {
      this.insertClose()
      this.stackDelta--
    }
    for (let wrapper of fix.enter) {
      this.patch(0, wrapper)
      this.stack.flags &= ~FitFlag.NeedsChild
      this.stack = new FitLevel(wrapper, this.stack)
      this.stack.flags |= FitFlag.Synthetic
      this.stackDelta++
    }
    return true
  }

  syncToContext(context: Pos) {
    // FIXME make this elegant/efficient somehow
    let cur = [], sync = []
    for (let l = this.stack as FitLevel | null; l; l = l.next) cur.push(l)
    cur.reverse()
    for (let level: Pos.Plot | null = context.parent; level; level = level.parent) sync.push(level.node.tag)
    sync.reverse()
    while (cur.length > sync.length) { this.insertClose(); cur.pop() }
    for (let d = 1; d < Math.min(sync.length, cur.length); d++) {
      if (!this.schema.sharesContent(sync[d].type, cur[d].tag.type)) {
        while (cur.length > d) { this.insertClose(); cur.pop() }
        break
      }
    }
    for (let i = cur.length; i < sync.length; i++) {
      let tag = sync[i]
      this.stack = new FitLevel(tag, this.stack)
      this.patch(0, tag)
    }
  }

  insertClose() {
    if (this.stack.flags & FitFlag.NeedsChild) this.patch(0, this.schema.createDefault(this.stack.tag.type), Plot.End)
    else this.patch(0, Plot.End)
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

  open(tag: Plot.Tag.Any) { this.enter(tag) }
  close() { this.leavePlot() }
  node(node: Node) { this.skip(node) }

  skip(node: Node) {
    if (this.fit(node.tag))
      this.stack.flags &= ~FitFlag.NeedsChild
    else
      this.patch(node.length)
    this.pos += node.length
  }

  enterPlot(node: Plot) { this.enter(node.tag) }

  enter(tag: Plot.Tag.Any) {
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

  leavePlot() {
    if (this.inserting) this.inputDelta--
    if (this.doubleDeleteDelta < 0) {
      this.doubleDeleteDelta++
      this.patch(1)
    } else if (this.stack.next) {
      if (this.stack.flags & FitFlag.NeedsChild) this.patch(0, this.schema.createDefault(this.stack.tag.type))
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
        this.patch(0, this.schema.createDefault(this.stack.tag.type))
        this.stack.flags &= ~FitFlag.NeedsChild
      } else {
        this.patch(0, Plot.End)
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

function localSyncPosAfter(pos: Pos) {
  let found = pos.pos
  for (let cx = pos.parent, index = pos.index;; index = cx.index, cx = cx.parent) {
    if (!cx.parent || !cx.node.inlineContent && index != cx.node.content.length - 1) break
    found = cx.after
  }
  return found
}

function markableSections(doc: Plot.Doc, from: number, to: number, spanning: boolean,
                          f: (n: Node, from: number, to: number) => boolean) {
  doc.iterate(from, to, (node, pos) => {
    if ((pos >= from && pos + (spanning ? node.length : 1) <= to) || node.isText) {
      if (node.isText ? f(node, Math.max(pos, from), Math.min(pos + node.length, to)) : f(node, pos, pos + 1))
        return false
    }
  })
}

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

  constructor(readonly sections: ChangeSet.Sections, readonly data?: readonly SectionData[]) {
    this.next()
  }

  next() {
    let {sections} = this
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
    return this.data ? this.data[(this.i - 2) >> 1] as readonly Modification[] | null : null
  }

  get slice() {
    return this.data ? this.data[(this.i - 2) >> 1] as Slice : Slice.empty
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

function finishCx(cx: BuildContext, schema: Schema) {
  return cx.tag.create(cx.children.length || cx.tag.inlineContent ? cx.children
                       : [schema.createDefault(cx.tag.type)])
}

function closeSlice(schema: Schema, slice: Slice, context: readonly Plot.Tag.Any[], depth: number, closeEnd = false) {
  let top: Token[] = [], stack: BuildContext | null = null
  for (let i = depth - 1; i >= 0; i--) stack = new BuildContext(context[i], stack)
  for (let token of slice.content) {
    if (token.tokenType == Token.Type.Close) {
      if (stack) {
        let node = finishCx(stack, schema)
        stack = stack.parent
        ;(stack ? stack.children : top).push(node)
      } else {
        top.push(token)
      }
    } else if (token.tokenType == Token.Type.Open) {
      stack = new BuildContext(token, stack)
    } else {
      ;(stack ? stack.children : top).push(token)
    }
  }
  if (closeEnd) while (stack) {
    let node = finishCx(stack, schema)
    stack = stack.parent
    ;(stack ? stack.children : top).push(node)
  }
  if (stack) splatContext(top, stack)
  return new Slice(top)
}

function splatContext(top: Token[], cx: BuildContext) {
  if (cx.parent) splatContext(top, cx.parent)
  top.push(cx.tag)
  for (let ch of cx.children) top.push(ch)
}

function fitReplacement(doc: Plot.Doc, from: Pos, to: Pos, slice: Slice, context: readonly Plot.Tag.Any[]) {
  if (!slice.length) return fitDeletion(doc, from, to)

  let preferredContext = -1
  for (let i = 0; i < context.length; i++) {
    let next = context[i]
    if (next.type.defining) preferredContext = i
    else if (!next.isTextblock) break
  }
  let firstType = null, closeCount = 0
  // Find the number of nodes this slice closes, relative to its
  // start depth.
  for (let i = 0, opened = 0; i < slice.content.length; i++) {
    let tok = slice.content[i]
    if (tok.tokenType == Token.Type.Close) {
      if (opened) opened--
      else closeCount++
    } else {
      if (!i) firstType = tok.type
      if (tok.tokenType == Token.Type.Open) opened++
    }
  }

  // Scan over nodes either covered entirely, or covered from their
  // start and closed by the slice, see if the slice or one of its
  // contexts can be inserted instead of that node. If so, replace the
  // node.
  let found: {from: number, to: number, slice: Slice} | undefined, foundCost = 1e8
  let neutral = true, toEnd = true
  scan: for (let cxFrom = from.parent, cxTo = to.parent,
             fromDepth = from.depth, toDepth = to.depth,
             start = from.pos, end = to.pos;
             cxFrom.parent;
             cxFrom = cxFrom.parent, start--, fromDepth--) {
    if (cxFrom.start != start || cxFrom.node.type.isolating) break
    while (toDepth > fromDepth) {
      if (cxTo.node.type.isolating) break scan
      cxTo = cxTo.parent!
      toDepth--
      end++
    }
    if (cxTo.end != end) {
      if (!closeCount) break
      toEnd = false
    }
    if (!cxFrom.node.type.neutral) neutral = false
    if (fromDepth == toDepth) for (let i = -1, type; i < context.length; i++) {
      if (i >= 0) type = context[i].type
      else if (!firstType) continue
      else type = firstType
      if (doc.schema.canContain(cxFrom.parent.node.type, type)) {
        let cost = (neutral ? 0 : 2) + (i < preferredContext ? context.length - i : i - preferredContext) + (toEnd ? 0 : 1e7)
        if (foundCost > cost) {
          found = {from: cxFrom.before, to: toEnd ? cxTo.after : to.pos,
                   slice: i >= 0 ? closeSlice(doc.schema, slice, context, i + 1, toEnd) : slice}
          foundCost = cost
        }
      }
    }
  }
  if (found) return found

  for (let i = 0; i < context.length; i++) {
    if (doc.schema.canContain(from.parent.node.type, context[i].type)) {
      slice = closeSlice(doc.schema, slice, context, i + 1, true)
      break
    }
  }
  return {from: from.pos, to: to.pos, slice}
}

function fitDeletion(doc: Plot.Doc, from: Pos, to: Pos) {
  let toDepth = to.depth
  let covered: {from: number, to: number, slice: Slice} | undefined
  // Walk up the contexts (catching up on cxTo whenever depth reaches
  // its depth), tracking whether there is any content between the
  // current depth's start/end and from/to by counting tokens.
  for (let cx = from.parent, cxTo = to.parent, depth = from.depth, start = from.pos, end = to.pos;
       cx.parent; start--, cx = cx.parent, depth--) {
    // If there is content before from, or this is an isolating node, stop
    if (cx.start != start || cx.node.type.isolating) break
    while (toDepth > depth) { cxTo = cxTo.parent!; toDepth--; end++ }
    let toAtEnd = toDepth == depth && cxTo.end == end // Check for content before to
    // If this is a deletion starting at the start of a node and
    // continuing past its end (but not to the end of a node at the
    // same level), include the node's open token.
    if (cx.end < to.pos && cx.parent.end > to.pos && !toAtEnd) return {from: cx.before, to: to.pos, slice: Slice.empty}
    // Else if this is a completely covered set of siblings with
    // non-inline content, and the range isn't inside a single
    // textblock, pick the outermost such range and delete it
    // entirely.
    if (!cx.node.inlineContent && toAtEnd && cx.parent.start == cxTo.parent!.start &&
        !(from.parent.start == to.parent.start && from.parent.node.inlineContent))
      covered = {from: cx.before, to: cxTo.after, slice: Slice.empty}
  }
  return covered || {from: from.pos, to: to.pos, slice: Slice.empty}
}
