import {Node, DocNode, NodeType, Mark, MarkJSON, pushNode, TokenType} from "./node"
import {Schema} from "./schema"
import {Slice, Token, CloseToken, OpenToken, SliceJSON} from "./slice"
import {Context, Walker} from "./context"

class BuildContext {
  children: Node[] = []
  constructor(readonly node: Node) {}
}

class Builder implements Walker {
  stack: BuildContext[]
  modifications: readonly Modification[] | null = null

  constructor(doc: DocNode) {
    this.stack = [new BuildContext(doc)]
  }

  add(node: Node) {
    if (this.modifications) {
      if (!node.type.isLeaf()) throw new Error("Invalid modification on non-leaf node")
      node = applyModifications(this.modifications, node)
    }
    pushNode(this.stack[this.stack.length - 1].children, node)
  }    

  enter(node: Node) {
    if (this.modifications) node = applyModifications(this.modifications, node)
    this.stack.push(new BuildContext(node))
  }

  leave() {
    if (this.modifications) throw new Error("Invalid modification on close token")
    if (this.stack.length == 1) throw new Error("Surplus close token")
    let top = this.stack.pop()!
    if (!top.children.length && !top.node.type.isLeaf() && !top.node.inlineContent())
      throw new Error(`Invalid change creating an empty block-child node`)
    this.add(top.node.copy(top.children))
  }

  skip(node: Node) {
    this.add(node)
  }

  finish() {
    if (this.stack.length != 1) throw new Error("Invalid change")
    let {node, children} = this.stack[0]
    if (!children.length && !node.inlineContent())
      throw new Error(`Invalid change creating an empty block-child node`)
    return node.copy(children) as DocNode
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

type SectionData = Slice | readonly Modification[] | null

export class ChangeSet {
  constructor(
    // Pairs of integers, first one representing the length of the
    // section in A, the second either -1 for a preserved or marked
    // range, or an insertion length for a replacement.
    readonly sections: readonly number[],
    readonly data: readonly SectionData[]
  ) {}

  apply(doc: DocNode) {
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
      if (a.ins == -1 && b.ins == -1) {
        // Move across ranges skipped by both sets.
        let len = Math.min(a.len, b.len)
        addSection(sections, data, len, -1, before ? a.mods : filterMods(a.mods, b.mods))
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
          if (b.ins == -1) {
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

  compose(other: ChangeSet): ChangeSet {
    let sections: number[] = [], data: SectionData[] = []
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
        if (a.ins == -1 && b.ins == -1) {
          addSection(sections, data, len, -1, combineMods(a.mods, b.mods), open)
        } else if (a.ins == -1) {
          addSection(sections, data, len, b.off ? 0 : b.ins, b.off ? Slice.empty : b.slice, open)
        } else if (b.ins == -1) {
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

  invert(doc: DocNode) {
    let sections = this.sections.slice(), data: SectionData[] = []
    for (let i = 0, iS = 0, pos = 0; iS < sections.length; iS += 2, i++) {
      let len = sections[iS], ins = sections[iS + 1]
      if (ins >= 0) {
        sections[iS] = ins; sections[iS + 1] = len
        data.push(doc.slice(pos, pos + len))
      } else {
        let mods = this.data[i] as readonly Modification[] | null
        data.push(mods ? invertMods(mods, doc, pos) : null)
      }
      pos += len
    }
    return new ChangeSet(sections, data)
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
        const {from, addMark, removeMark, setAttr, insert} = spec
        let modifies = addMark || removeMark || setAttr
        if (modifies && !insert) {
          let to = spec.to ?? spec.from + 1
          if (addMark) {
            let mods: Modification[] = [{type: "addMark", mark: addMark}]
            markableSections(doc, from, to, (node, from, to) => {
              if (!addMark.type.canTarget(node.type) || addMark.isInSet(node.marks)) return false
              let added = addMark.addToSet(node.marks), modsHere = mods
              // The mark replaces one or more marks
              if (added.length != node.marks.length + 1)
                modsHere = node.marks
                  .filter(m => !added.includes(m))
                  .map(mark => ({type: "removeMark", mark} as Modification))
                  .concat(mods)
              section(from, to, -1, modsHere)
              return true
            })
          }
          if (removeMark) {
            let mods: Modification[] = [{type: "removeMark", mark: removeMark}]
            markableSections(doc, from, to, (node, from, to) => {
              if (!removeMark.isInSet(node.marks)) return false
              section(from, to, -1, mods)
              return true
            })
          }
          if (setAttr) {
            if (to - from != 1) throw new Error("Attribute changes must apply to a single position")
            let mods: Modification[] = [], node = doc.nodeAt(from)
            if (!node) throw new Error("No node at position given to ChangeSet.setAttrs")
            for (let attr in setAttr) {
              if (!node.type.attrs.some(a => a.name == attr))
                throw new Error(`Nodes of type ${node.name} don't support an attribute ${attr}`)
              mods.push({type: "setAttr", attr, value: setAttr[attr]})
            }
            section(from, to, -1, mods)
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
          if (mod.type == "addMark") return `+${mod.mark.name}`
          if (mod.type == "removeMark") return `-${mod.mark.name}`
          return `${mod.attr}=${String(mod.value).slice(0, 20)}`
        })}]`
      }
      if (text) result += `${result ? "," : ""}${pos}${len ? `-${pos + len}` : ""}${text}`
      pos += len
    }
    return result
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
  if (other.type == "setAttr") {
    return mod.type == "setAttr" && mod.attr == other.attr
  } else if (other.type == "addMark") {
    return mod.type == "addMark" ? mod.mark.type.excludes(other.mark.type)
      : mod.type == "removeMark" ? mod.mark.eq(other.mark) : false
  } else {
    return mod.type == "addMark" && mod.mark.eq(other.mark)
  }
}

function invertMods(mods: readonly Modification[], doc: DocNode, pos: number): readonly Modification[] {
  let resolved: Node | undefined
  return mods.map(mod => {
    if (mod.type == "addMark") return {type: "removeMark", mark: mod.mark}
    if (mod.type == "removeMark") return {type: "addMark", mark: mod.mark}
    if (!resolved) resolved = doc.nodeAt(pos)!
    return {type: "setAttr", attr: mod.attr, value: resolved.attrs[mod.attr]}
  })
}

function applyModsToSlice(slice: Slice, mods: readonly Modification[] | null) {
  if (!mods) return slice
  let content: Token[] = []
  for (let tok of slice.content) {
    if (tok.tokenType == TokenType.Open) {
      content.push(new OpenToken(applyModifications(mods, tok.node)))
    } else if (tok.tokenType == TokenType.Node) {
      let node = applyModifications(mods, tok)
      if (content.length && content[content.length - 1].tokenType == TokenType.Node)
        pushNode(content as Node[], node)
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
    readonly type: NodeType,
    readonly next: FitLevel | null,
  ) {
    if (!this.type.inlineContent() && !this.type.isLeaf()) this.flags |= FitFlag.NeedsChild
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
    this.stack = new FitLevel(doc.type, null)
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

  fit(type: NodeType) {
    if (this.stack.type.canContain(type)) return true
    let fix: {leave: number, enter: readonly Node[], cost: number} | null = null
    let dDelta = this.stackDelta - this.inputDelta
    for (let level: FitLevel | null = this.stack, leave = 0, leaveCost = 0; level; level = level.next, leave++) {
      if (fix && leaveCost > fix.cost) break
      let enter = this.doc.schema.findWrapping(level.type, type)
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
      this.stack = new FitLevel(wrapper.type, this.stack)
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
      if (!cx.node.type.sharesContent(levels[d].type)) {
        while (levels.length > d) { this.insertClose(); levels.pop() }
        break
      }
    }
    for (let i = levels.length; i < depth + 1; i++) {
      let cx = context.atDepth(i)
      this.stack = new FitLevel(cx.node.type, this.stack)
      this.patch(0, new OpenToken(cx.node))
    }
  }

  insertClose() {
    if (this.stack.flags & FitFlag.NeedsChild) this.patch(0, this.doc.schema.createDefault(this.stack.type), CloseToken)
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
    if (this.fit(node.type))
      this.stack.flags &= ~FitFlag.NeedsChild
    else
      this.patch(node.length)
    this.pos += node.length
  }

  enter(node: Node) {
    if (this.inserting) this.inputDelta++
    if (this.doubleDeleteDelta > 0) {
      this.doubleDeleteDelta--
      this.patch(1)
    } else if (this.fit(node.type)) {
      this.stack.flags &= ~FitFlag.NeedsChild
      this.stack = new FitLevel(node.type, this.stack)
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
      if (this.stack.flags & FitFlag.NeedsChild) this.patch(0, this.doc.schema.createDefault(this.stack.type))
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
        this.patch(0, this.doc.schema.createDefault(this.stack.type))
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

function addSection(sections: number[], data: SectionData[],
                    len: number, ins: number, value: SectionData,
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
