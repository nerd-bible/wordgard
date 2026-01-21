import {Slice, Token, TokenType, End} from "./slice"
import {TextOutput} from "./text"
import {NodeShape} from "./shape"
import {Schema} from "./schema"
import {Pos, PlotPos} from "./pos"
import {Mark} from "./mark"
import {eqArray, none, compareDeep, inGroup} from "./helper"
import {ElementShape, StructureShape, ElementParseRule} from "./shape"

const enum NodeFlag {
  None = 0,
  Inline = 1,
  InlineContent = 2,
  Atom = 4,
  Doc = 8,
  NullParam = 16,
}

export type Node = Plot | Leaf.Any

export namespace Node {
  export interface Shared {
    name: string
    tag: Node.Tag
    mark<Value>(mark: Mark.Type<Value>): Value | undefined
    eq(other: Node | Node.Tag): boolean
    withMarks(marks: readonly Mark<unknown>[]): Node
    pushTo(nodes: Node[]): void
    slice(from: number, to?: number): Slice
    isInline: boolean
    isBlock: boolean
    isLeaf: boolean
    isPlot: boolean
    isText: boolean
    length: number
    toJSON(): Node.JSON
  }

  export type Type<T> = Leaf.Type<T> | Plot.Type<T>

  export namespace Type {
    export abstract class Base<Param> {
      readonly groups: Set<string> = new Set
      readonly shape: NodeShape<Param>
      abstract default: Node.Tag | null

      constructor(
        readonly name: string,
        readonly flags: NodeFlag,
        readonly spec: Node.Spec<Param>
      ) {
        this.groups.add(name)
        this.groups.add("_")
        if (flags & NodeFlag.Inline) this.groups.add("Inline")
        if (spec.group) for (let g of typeof spec.group == "string" ? [spec.group] : spec.group) {
          this.groups.add(g)
          for (let pos = 0;;) {
            let nextDot = g.indexOf(".", pos)
            if (nextDot < 0) break
            this.groups.add(g.slice(0, nextDot))
            pos = nextDot + 1
          }
        }
        this.shape = NodeShape.from(this, spec.shape)
        if (this.shape.atom) this.flags |= NodeFlag.Atom
      }

      /// Test whether this node type is in the given group. When
      /// multiple group names, separated by spaces, are given, this
      /// tests whether the node is in _all_ of those groups.
      inGroup(group: Node.Group) { return inGroup(group, this.groups) }

      get isInline() { return (this.flags & NodeFlag.Inline) > 0 }
      get isBlock() { return (this.flags & NodeFlag.Inline) == 0 }
      get isAtom() { return (this.flags & NodeFlag.Atom) > 0 }
      abstract isLeaf: boolean
      abstract isPlot: boolean
    }
  }

  export type Tag = Leaf.Any | Plot.Tag.Any

  export namespace Tag {
    export abstract class Base<Param> {
      abstract type: Node.Type<Param>

        constructor(
          readonly param: Param,
          readonly marks: readonly Mark[]
        ) {}

      mark<Value>(mark: Mark.Type<Value>): Value | undefined {
        for (let v of this.marks) if (v.type == mark) return v.value as Value
        return undefined
      }

      get name() { return this.type.name }

      abstract eq(other: Node | Node.Tag): boolean

      get isInline() { return this.type.isInline }
      get isBlock() { return this.type.isBlock }
      abstract isLeaf: boolean
      abstract isPlot: boolean
      get isText() { return this.type == Leaf.Text as Leaf.Type<any> }

      is<T>(type: Leaf.Type<T>): this is Leaf<T>
        is<T>(type: Plot.Type<T>): this is Plot.Tag<T>
        is(type: any) { return this.type == type }

      toJSON(): Node.JSON {
        let result: Node.JSON = {type: this.name}
        if (this != this.type.default as any) result.param = this.param
        if (this.marks.length) {
          result.marks = Object.create(null)
          for (let {name, value} of this.marks) result.marks![name] = value
        }
        return result
      }
    }
  }

  /// Groups are used to specify parent-child relationships between
  /// nodes, and to indicate a semantic meaning for some types of
  /// nodes. Any string can be used as a group name. Dot-separated
  /// names indicate sub-groups of the group before the dot.
  ///
  /// The `"List"` group identifies a plot as a list container. This
  /// makes some commands treat the plot specially. `"List.Ordered"`
  /// and `"List.Bullet"` are subgroups of that, used by things like
  /// list menu items to find the schema's list node type.
  ///
  /// `"Code"` indicates that a plot contains code, and makes some
  /// commands behave differently inside such a plot.
  ///
  /// A single leaf type in a schema may belong to the `"LineBreak"`
  /// group, which identifies it as the node canonical that represents
  /// a line break. Nodes marked as line breaks will be parsed from
  /// and serialized to newline characters inside
  /// [whitespace-preserving](#state.Tag.Spec.preserveWhitespace)
  /// nodes.
  ///
  /// Each node is part of the `"_"` group, inline nodes automatically
  /// get assigned to `"Inline"`, plots to `"Plot"`, and leaves to
  /// `"Leaf"`.
  export type Group = "List" | "List.Bullet" | "List.Ordered" | "Code" | "LineBreak" | "Inline" | "Plot" | "Leaf" | "_" | (string & {})

  export interface Spec<Param> {
    defaultParam?: Param extends null ? never : Param
    /// A function or type name used to validate this tag's parameter
    /// value. This will be used when deserializing the attribute from
    /// JSON. When a string, it should be a `|`-separated string of
    /// primitive types (`"number"`, `"string"`, `"boolean"`, `"null"`,
    /// and `"undefined"`), and the library will raise an error when the
    /// value is not one of those types. When a function, it should
    /// raise an error if the value doesn't have the expected type or
    /// shape.
    validateParam?: string | ((param: Param) => void)
    /// Assign one or more groups to this node type. Groups are used
    /// when specifying allowed content for a plot. Some pre-defined
    /// group names (see [`Node.Group`](#doc.Node.Group)) are used to
    /// identify the semantic role of nodes.
    group?: Group | readonly Group[]
    shape: ElementShape<Param> | StructureShape<Param>
    parseRules?: readonly ElementParseRule<Param>[]
  }

  export type Selector = Leaf.Any | Plot.Tag.Any | Node.Type<any> | string | readonly Node.Selector[]

  export function selector(selector?: Node.Selector): (type: Node.Type<any>) => boolean {
    if (!selector) return () => true
    if (Array.isArray(selector)) {
      let inner = selector.map(Node.selector)
      return type => inner.some(s => s(type))
    }
    if (typeof selector == "string") {
      if (!/ /.test(selector)) return t => t.inGroup(selector as string)
      let groups = selector.split(/ /)
      return t => groups.some(g => t.inGroup(g))
    }
    let type = selector instanceof Leaf.Type || selector instanceof Plot.Type ? selector
      : (selector as Leaf<any> | Plot.Tag<any>).type
    return t => t === type
  }

  export interface JSON {
    type: string
    param?: any
    marks?: {[name: string]: any}
    content?: readonly Node.JSON[]
  }
}

export class Leaf<Param> extends Node.Tag.Base<Param> implements Node.Shared {
  constructor(readonly type: Leaf.Type<Param>, param: Param, marks: readonly Mark<unknown>[]) {
    super(param, marks)
  }

  get tag() { return this }

  eq(other: Node | Node.Tag): boolean {
    return this == other || other.isLeaf && this.type == other.type && compareDeep(this.param, other.param) &&
      Mark.sameSet(this.marks, other.marks)
  }

  static defineInline(name: string, spec: Leaf.Spec<null>): Leaf<null> {
    checkTagName(name)
    return new Leaf.Type<null>(name, flagsFor(spec, true) | NodeFlag.NullParam, spec).default!
  }

  static defineBlock(name: string, spec: Leaf.Spec<null>): Leaf<null> {
    checkTagName(name)
    return new Leaf.Type<null>(name, flagsFor(spec, false) | NodeFlag.NullParam, spec).default!
  }

  withMarks(marks: readonly Mark<unknown>[]) {
    return Mark.sameSet(this.marks, marks) ? this : this.type.of(this.param, marks)
  }

  get tokenType(): TokenType.Node { return TokenType.Node }
  get isLeaf(): true { return true }
  get isPlot(): false { return false }

  get length(): number { return this.is(Leaf.Text) ? this.param.length : 1 }

  join(onto: Node): Leaf.Any | null {
    if (!this.is(Leaf.Text) || !onto.is(Leaf.Text) || !Mark.sameSet(this.marks, onto.marks)) return null
    return Leaf.text(onto.param + this.param, this.marks)
  }

  pushTo(nodes: Node[]) {
    let joined = nodes.length && this.join(nodes[nodes.length - 1])
    if (joined) nodes[nodes.length - 1] = joined
    else nodes.push(this)
  }

  slice(from: number, to = this.length) {
    return from == to ? Slice.empty : new Slice([this.is(Leaf.Text) ? this.sliceText(from, to) : this])
  }

  sliceText(from: number, to?: number) {
    if (!this.is(Leaf.Text)) throw new Error("Calling sliceText on a non-text node")
    if (to == null) to = this.param.length
    if (!from && to == this.param.length) return this
    return Leaf.Text.of(this.param.slice(Math.max(from, 0), Math.max(0, to)), this.marks)
  }

  static text(text: string, marks: readonly Mark<any>[] = none) {
    return Leaf.Text.of(text, marks)
  }

  /// @internal
  toString() {
    return (this.is(Leaf.Text) ? JSON.stringify(this.param) : this.name) + markString(this.marks)
  }
}

export namespace Leaf {
  export class Type<Param> extends Node.Type.Base<Param> {
    default: Leaf<Param> | null
    declare spec: Leaf.Spec<Param>

    constructor(name: string, flags: NodeFlag, spec: Leaf.Spec<Param>) {
      super(name, flags, spec)
      this.groups.add("Leaf")
      this.default = "defaultParam" in spec ? new Leaf(this, spec.defaultParam!, none) :
        (flags & NodeFlag.NullParam) ? new Leaf(this, null as any, none) : null
    }

    static defineInline<T>(name: string, spec: Leaf.Spec<T>) {
      checkTagName(name)
      return new Leaf.Type<T>(name, flagsFor(spec, true), spec)
    }

    static defineBlock<T>(name: string, spec: Leaf.Spec<T>) {
      checkTagName(name)
      return new Leaf.Type<T>(name, flagsFor(spec, false), spec)
    }

    of(param: Param, marks: readonly Mark<any>[] = none) {
      if (!marks.length && this.default && compareDeep(this.default.param, param)) return this.default
      return new Leaf(this, param, marks)
    }

    get isLeaf(): true { return true }
    get isPlot(): false { return false }
  }

  export interface Spec<Param> extends Node.Spec<Param> {
    toText?(node: Leaf.Any): string
  }

  export type Any = Omit<Leaf<unknown>, "type" | "tag" | "withMarks"> & {
    type: Leaf.Type<any>,
    tag: Leaf.Any,
    withMarks(marks: readonly Mark[]): Leaf.Any
  }

  export const Text = new Leaf.Type<string>("Text", NodeFlag.Inline, {
    shape: {element: ""}
  })
}

export class Plot implements Node.Shared {
  contentLength: number
  tag: Plot.Tag.Any

  constructor(
    tag: Plot.Tag.Any,
    readonly content: readonly Node[],
  ) {
    this.tag = tag
    this.contentLength = content.reduce((s, c) => s + c.length, 0)
  }

  get name() { return this.tag.name }
  get type() { return this.tag.type }
  get marks() { return this.tag.marks }

  get length() {
    return 2 + this.contentLength
  }

  eq(other: Node | Node.Tag): boolean {
    return this == other || other instanceof Plot && this.tag.eq(other.tag) && eqArray(this.content, other.content)
  }

  slice(from: number, to = this.length) {
    if (from == to) return Slice.empty
    let content: Token[] = []
    this.slicePlot(content, from, to)
    return new Slice(content)
  }

  /// @internal
  slicePlot(out: Token[], from: number, to: number) {
    if (from <= 0) {
      if (to >= this.length) {
        out.push(this)
        return
      }
      out.push(this.tag)
    }
    sliceContent(out, this.content, from - 1, to - 1)
    if (to >= this.length) out.push(Plot.End)
  }

  is<T>(type: Leaf.Type<T>): false { return false }

  get isText(): false { return false }
  get isInline() { return this.type.isInline }
  get isBlock() { return this.type.isBlock }
  get inlineContent() { return this.type.inlineContent }
  get isTextblock() { return this.type.isTextblock }
  get isLeaf(): false { return false }
  get isPlot(): true { return true }
  get isDoc() { return this.type.isDoc }

  get firstChild(): Node | null {
    return this.content.length ? this.content[0] : null
  }

  get lastChild(): Node | null {
    let last = this.content.length - 1
    return last < 0 ? null : this.content[last]
  }

  /// Iterate though the given range (or the entire document, when
  /// given only one argument), and call the given function on every
  /// node that overlaps the given range, outer nodes before inner
  /// nodes. When the function returns `false` for a node, descendents
  /// of that node are not iterated.
  iterate(from: number, to: number, f: (node: Node, pos: number, parent: Plot | null, index: number) => boolean | void): void
  iterate(f: (node: Node, pos: number, parent: Plot | null, index: number) => boolean | void): void
  iterate(a: number | ((node: Node, pos: number, parent: Plot | null, index: number) => boolean | void),
          b?: number, c?: (node: Node, pos: number, parent: Plot | null, index: number) => boolean | void): void {
    let [from, to, f] = typeof a == "number" ? [a, b!, c!] : [0, this.length, a]
    if (this.isDoc || f(this, 0, null, 0) !== false)
      this.iterInner(0, from, to, f)
  }

  nodeAt(pos: number): Node | null {
    for (let node of this.content) {
      if (pos == 0) return node
      if (pos < node.length) return node.isLeaf ? null : node.nodeAt(pos - 1)
      pos -= node.length
    }
    return null
  }

  /// @internal
  iterInner(contentStart: number, from: number, to: number,
            f: (node: Node, pos: number, parent: Plot | null, index: number) => boolean | void) {
    for (let pos = contentStart, i = 0; i < this.content.length; i++) {
      if (pos >= to) break
      let node = this.content[i], start = pos
      pos += node.length
      if (pos <= from) continue
      if (f(node, start, this, i) !== false && node.isPlot) node.iterInner(start + 1, from, to, f)
    }
  }

  /// @internal
  toString() {
    return this.name + markString(this.tag.marks) + "(" + this.content.join() + ")"
  }

  toJSON(): Node.JSON {
    let result = this.tag.toJSON()
    if (this.content.length) result.content = this.content.map(c => c.toJSON())
    return result
  }

  textContent(options: {
    from?: number, to?: number,
    blockSeparator?: string,
    leafText?: string | ((node: Leaf.Any) => string)
  } = {}) {
    let {from = 0, to = this.length, blockSeparator = "\n", leafText} = options
    let out = new TextOutput(blockSeparator, leafText == null ? undefined : typeof leafText == "string" ? () => leafText : leafText)
    this.iterate(from, to, (node, pos) => {
      return !out.serialize(node.is(Leaf.Text) ? node.sliceText(Math.max(0, from - pos), Math.min(node.length, to - pos)) : node)
    })
    return out.text
  }

  mark<Value>(mark: Mark.Type<Value>): Value | undefined { return this.tag.mark(mark) }

  join(other: Node) { return null }

  pushTo(nodes: Node[]) { nodes.push(this) }

  withMarks(marks: readonly Mark[]) {
    return Mark.sameSet(this.tag.marks, marks) ? this : this.tag.withMarks(marks).create(this.content)
  }

  get tokenType(): TokenType.Node { return TokenType.Node }

  static defineInline(name: string, spec: Plot.Spec<null>): Plot.Tag<null> {
    checkTagName(name)
    return new Plot.Type<null>(name, flagsFor(spec, true) | NodeFlag.NullParam, spec).default!
  }

  static defineBlock(name: string, spec: Plot.Spec<null>): Plot.Tag<null> {
    checkTagName(name)
    return new Plot.Type<null>(name, flagsFor(spec, false) | NodeFlag.NullParam, spec).default!
  }

  static defineDoc(spec: {inlineContent?: string | true, blockContent?: string | readonly string[]}) {
    if (!spec.inlineContent && !spec.blockContent) throw new Error("Doc nodes must allow content")
    let flags = NodeFlag.NullParam | NodeFlag.Doc | NodeFlag.NullParam
    if (spec.inlineContent) flags |= NodeFlag.InlineContent
    return new Plot.Type<null>("Doc", flags, {
      ...spec,
      shape: {element: ""}
    })
  }

  static End = End
}

export namespace Plot {
  export class Tag<Param> extends Node.Tag.Base<Param> {
    constructor(readonly type: Plot.Type<Param>, param: Param, marks: readonly Mark<unknown>[]) {
      super(param, marks)
    }

    eq(other: Node | Node.Tag): boolean {
      return this == other || other instanceof Plot.Tag && this.type == other.type &&
        compareDeep(this.param, other.param) && Mark.sameSet(this.marks, other.marks)
    }

    withMarks(marks: readonly Mark[]) {
      return Mark.sameSet(this.marks, marks) ? this : this.type.of(this.param, marks)
    }

    create(children?: readonly Node[]): Plot {
      if (this.isDoc) throw new Error("Document nodes must be created with schema.doc()")
      return new Plot(this, this.type.checkChildren(joinText(children || none)))
    }

    split(atEnd: boolean) {
      return this.marks.length ? this.withMarks(this.marks.filter(p => {
        let {keepOnSplit} = p.type.spec
        return keepOnSplit && (keepOnSplit === true || keepOnSplit(this, atEnd))
      })) : this
    }

    changeType(to: Plot.Tag.Any) {
      if (!this.marks.length) return to
      let marks = to.marks
      for (let mark of this.marks) if (mark.type.canTarget(to.type) && (mark.type.set || !mark.isInSet(marks))) {
        let {keepOnTypeChange} = mark.type.spec
        if (keepOnTypeChange && (keepOnTypeChange === true || keepOnTypeChange(this, to)))
          marks = mark.addToSet(marks)
      }
      return to.withMarks(marks)
    }

    get tokenType(): TokenType.Open { return TokenType.Open }

    get inlineContent() { return this.type.inlineContent }
    get isTextblock() { return this.type.isTextblock }
    get isLeaf(): false { return false }
    get isPlot(): true { return true }
    get isDoc() { return this.type.isDoc }

    /// @internal
    toString() {
      return this.type.name + markString(this.marks)
    }
  }

  export namespace Tag {
    export type Any = Omit<Plot.Tag<unknown>, "type" | "split" | "withMarks"> & {
      type: Plot.Type<any>,
      split(atEnd: boolean): Plot.Tag.Any
      withMarks(marks: readonly Mark[]): Plot.Tag.Any
    }
  }

  export class Type<Param> extends Node.Type.Base<Param> {
    readonly default: Plot.Tag<Param> | null
    declare spec: Plot.Spec<Param>
    readonly contentGroups: readonly string[]
    readonly childCache: Map<Node.Type<any>, boolean> = new Map
    readonly isolating: boolean
    readonly defining: boolean
    readonly neutral: boolean
    readonly preserveWhitespace: boolean
    readonly orientation: "row" | "column"

    constructor(name: string, flags: NodeFlag, spec: Plot.Spec<Param>) {
      super(name, flags, spec)
      this.groups.add("Plot")
      let content = spec.inlineContent === true ? "Inline" : spec.inlineContent || spec.blockContent
      this.contentGroups = typeof content == "string" ? [content] : content!
      this.isolating = !!spec.isolating
      this.defining = !!spec.defining
      this.neutral = spec.neutral ?? !this.defining
      this.preserveWhitespace = spec.preserveWhitespace ?? !!this.inGroup("Code")
      this.orientation = flags & NodeFlag.InlineContent ? "row" : spec.orientation || "column"
      this.default = "defaultParam" in spec ? new Plot.Tag(this, spec.defaultParam!, none) :
        (flags & NodeFlag.NullParam) ? new Plot.Tag(this, null as any, none) : null
      if (!this.shape.atom && this.isInline && !this.inlineContent)
        throw new Error("Inline tags with block content must be marked as atoms")
    }

    static defineInline<T>(name: string, spec: Plot.Spec<T>) {
      checkTagName(name)
      return new Plot.Type<T>(name, flagsFor(spec, true), spec)
    }

    static defineBlock<T>(name: string, spec: Plot.Spec<T>) {
      checkTagName(name)
      return new Plot.Type<T>(name, flagsFor(spec, false), spec)
    }

    of(param: Param, marks: readonly Mark<any>[] = none) {
      if (!marks.length && this.default && compareDeep(this.default.param, param)) return this.default
      return new Plot.Tag(this, param, marks)
    }

    canContain(child: Node.Type<any>) {
      let result = this.childCache.get(child)
      if (result == null) {
        result = (child.flags & NodeFlag.Doc) ? false : this.contentGroups.some(g => child.inGroup(g))
        this.childCache.set(child, result)
      }
      return result
    }

    sharesContent(other: Plot.Type<any>) {
      return other.contentGroups.some(g => this.contentGroups.includes(g))
    }

    checkChildren(children: readonly Node[]) {
      for (let child of children)
        if (!this.canContain(child.type))
          throw new Error(`${child.name} is not a valid child of ${this.name}`)
      return children
    }

    get inlineContent() { return (this.flags & NodeFlag.InlineContent) > 0 }
    get isTextblock() { return this.isBlock && this.inlineContent }
    get isDoc() { return (this.flags & NodeFlag.Doc) > 0 }
    get isLeaf(): false { return false }
    get isPlot(): true { return true }
  }

  export interface Spec<Param> extends Node.Spec<Param> {
    blockContent?: string | readonly string[]
    inlineContent?: string | readonly string[] | true

    /// Whether the sides of this node act as a 'barrier' when
    /// [normalizing](#state.EditorSelection.normalize) a cursor
    /// position. By default, block nodes that are
    /// [isolating](#state.Tag.Spec.isolating),
    /// [atomic](#state.EditorState.isAtom), or whitepace-preserving act
    /// as barriers.
    cursorBarrier?: boolean
    /// Indicates that this type of block is the default generic block
    /// type in parent nodes where it may occur (which is appropriate
    /// for, for example, paragraphs tags). Default blocks should not
    /// have a required param. When not specified, the configuration
    /// precedence order determines which child type is the default.
    defaultBlock?: boolean
    /// Controls whether whitespace inside this type of node should be
    /// preserved. Disables whitespace collapsing and the replacement
    /// of newlines with line break nodes in the parser and
    /// serializer. Defaults to false, unless the node is in group
    /// `"Code"`.
    preserveWhitespace?: boolean
    isolating?: boolean
    /// Block containers are, by default, assumed to arrange their
    /// children vertically below each other (`"column"`). You can set this
    /// to `"row"` to tell the editor that this container's children
    /// are horizontally next to each other.
    orientation?: "row" | "column"
    /// Defining nodes are preserved (when possible) when their content
    /// is duplicated (dragged, pasted, etc) into a new position.
    /// Defaults to false.
    defining?: boolean
    /// Neutral nodes can be completely replaced when their entire
    /// content gets replaced. Defaults to `!defining`.
    neutral?: boolean
    /// Whether block nodes of this type should be automatically joined
    /// when they become adjacent through an edit. Defaults to false.
    /// Note that editing commands need to explicitly call
    /// [`autoJoinBlocks`](#state.autoJoinBlocks) for joining to happen.
    autoJoin?: boolean | ((before: Plot.Tag.Any, after: Plot.Tag.Any) => boolean)
    /// By default, splitting a textblock at the end will revert the new
    /// block to the default type of textblock at that position. Setting
    /// this to true on a textblock type will prevent that behavior.
    preserveOnSplitAtEnd?: boolean
    /// For inline nodes with inline content, this determines whether
    /// there are normalized cursor positions directly inside the node.
    /// The default is to only have cursor positions right outside the
    /// node.
    cursorInsideBounds?: boolean
  }

  export class Doc extends Plot {
    constructor(readonly schema: Schema, children: readonly Node[]) {
      super(schema.docTag, children)
    }

    get length() { return this.contentLength }

    slicePlot(content: Token[], from: number, to: number) {
      sliceContent(content, this.content, from, to)
    }

    resolve(pos: number) {
      return Pos.resolve(this, pos)
    }

    resolveNode(pos: number) {
      return Pos.resolveNode(this, pos)
    }

    resolvePlot(pos: number) {
      let r = this.resolveNode(pos)
      return r instanceof PlotPos ? r : null
    }

    contextAt(pos: number, maxDepth?: number): readonly Plot.Tag.Any[] {
      for (let {parent} = this.resolve(pos), context = [];;) {
        if (!parent.parent || maxDepth != null && context.length == maxDepth) return context
        context.push(parent.node.tag)
        parent = parent.parent
      }
    }
  }
}

function flagsFor(spec: Plot.Spec<any>, inline: boolean) {
  let flags = inline ? NodeFlag.Inline : NodeFlag.None
  if (spec.inlineContent && spec.blockContent) throw new Error("A tag cannot have both block and inline content")
  if (spec.inlineContent) flags |= NodeFlag.InlineContent
  return flags
}

function markString(marks: readonly Mark[]) {
  let values: string[] = []
  for (let mark of marks) {
    if (mark.type.default == mark) values.push(mark.type.name)
    else values.push(`${mark.type.name}=${mark.value}`)
  }
  return values.length ? `[${values.join()}]` : ""
}

function sliceContent(out: Token[], content: readonly Node[], from: number, to: number) {
  let off = 0
  for (let child of content) {
    if (off >= to) break
    let start = off
    off += child.length
    if (off <= from) continue
    if (child.isPlot) {
      child.slicePlot(out, from - start, to - start)
    } else if (child.isText) {
      out.push(child.sliceText(from - start, to - start))
    } else {
      out.push(child)
    }
  }
}

function joinText(nodes: readonly Node[]) {
  if (!nodes.length || nodes[0].isBlock) return nodes
  let joined: Node[] | undefined
  for (let i = 0, last: Leaf.Any | null = null; i < nodes.length; i++) {
    let node = nodes[i], join
    if (join = last && node.join(last)) {
      if (!joined) joined = nodes.slice(0, i)
      last = joined[joined.length - 1] = join
    } else {
      last = node.isLeaf ? node : null
      if (joined) joined.push(node)
    }
  }
  return joined || nodes
}

function checkTagName(name: string) {
  if (/[\s:]/.test(name)) throw new Error(`Tag names may not include space or colon characters (${name})`)
  if (name == "Inline" || name == "Block" || name == "Text" || name == "Doc")
    throw new Error(`Tag name ${name} is reserved`)
}
