import {Slice, Token} from "./slice"
import {TextOutput} from "./text"
import {NodeShape} from "./shape"
import type {Schema} from "./schema"
import {Pos} from "./pos"
import {Mark} from "./mark"
import {eqArray, none, compareDeep} from "./helper"
import {Shape, ParseRule} from "./shape"
import {SchemaError} from "./error"

const enum NodeFlag {
  None = 0,
  Inline = 1,
  InlineContent = 2,
  Atom = 4,
  Doc = 8,
  NullParam = 16,
  Selectable = 32,
  CanBeEmpty = 64,
}

// FIXME make these types easier to import (and ideally to understand)

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
      readonly roles: Set<Node.Role> = new Set
      readonly shape: NodeShape<Param>
      abstract default: Node.Tag | null

      constructor(
        readonly name: string,
        readonly flags: NodeFlag,
        readonly spec: Node.Spec<Param>
      ) {
        if (spec.role instanceof Node.Role) this.roles.add(spec.role)
        else if (spec.role) for (let role of spec.role) this.roles.add(role)
        this.shape = NodeShape.from(this, spec.shape)
        if (this.shape.atom) this.flags |= NodeFlag.Atom
      }

      /// Test whether this node has the given role.
      hasRole(role: Node.Role) { return this.roles.has(role) }

      get isInline() { return (this.flags & NodeFlag.Inline) > 0 }
      get isBlock() { return (this.flags & NodeFlag.Inline) == 0 }
      get isAtom() { return (this.flags & NodeFlag.Atom) > 0 }
      abstract isLeaf: boolean
      abstract isPlot: boolean
    }

    /// Used as input type by some functions acting on node types, so
    /// that you can pass either a bare type or a singleton leaf or
    /// plot tag.
    export type Ref<T> = Plot.Type<T> | Leaf.Type<T> | Plot.Tag<T> | Leaf<T>
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

    /// Deduce a tag type for a given node or tag type.
    export type For<Type extends Node.Type.Ref<any>> =
      Type extends Leaf.Type<infer T> ? Leaf<T> : Type extends Plot.Type<infer T> ? Plot.Tag<T> : Type
  }

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
    /// group names (see {@link Node.Group}) are used to identify the
    /// semantic role of nodes.
    group?: Group | readonly Group[]
    /// Roles to add to this node type, which mark it as having a
    /// certain semantic role, such as being a list.
    role?: Node.Role | readonly Node.Role[]
    shape: Shape.Element<Param> | Shape.Structure<Param>
    parseRules?: readonly ParseRule.Element<Param>[]
  }

  /// The JSON representation for a node.
  export interface JSON {
    type: string
    param?: any
    marks?: {[name: string]: any}
    content?: readonly Node.JSON[]
  }

  /// Groups are used to specify parent-child relationships between
  /// nodes, and valid targets for marks. You can use predefined
  /// groups provided as static properties on the class, or define
  /// your own for custom categories.
  export class Group {
    declare private tag: Node.Group

    private constructor(
      /// Groups may have a parent group. Membership of a group
      /// implies membership of its parent groups.
      readonly parent: Group | undefined
    ) {}

    /// Define a custom node group.
    static define(parent?: Group) { return new Group(parent) }

    /// A group that contains every node type.
    static All = Group.define()
    /// All inline nodes are automatically assigned to this group.
    static Inline = Group.define()
    /// Block elements automatically get assigned to this group.
    static Block = Group.define()
    /// The group of all leaf nodes.
    static Leaf = Group.define()
    /// The group of all non-leaf nodes.
    static Plot = Group.define()
    /// Block plots with inline content are tagged as textblocks.
    static Textblock = Group.define()
    /// A group used for generic block content, such as paragraphs and
    /// lists. The basic schema uses this as the content type for the
    /// top level document, blockquotes, and list items.
    static Content = Group.define()
    /// Group for the innermost cell nodes in tables.
    static TableCell = Group.define()
    /// Generic list item group.
    static ListItem = Group.define()

    /// @internal
    static builtin = [Group.All, Group.Inline, Group.Block, Group.Leaf, Group.Plot, Group.Textblock]
  }

  export type Query = Node.Tag | Node.Type<any> | Group | readonly Node.Query[] | {and: readonly Node.Query[]}

  /// Roles are used to add some semantic information to node types.
  /// You can define your own, and use the `hasRole` method to check
  /// whether a given node has the role attached.
  export class Role {
    declare private tag: "Node.Role"

    /// This role indicates that a plot contains code, and makes some
    /// commands behave differently inside such a plot.
    static Code = new Role

    /// Identifies a plot as a list container. This makes some
    /// commands treat the plot specially.
    static List = new Role

    /// A single leaf type in a schema may have the `LineBreak` role,
    /// which identifies it as the node canonical that represents a
    /// line break. Nodes marked as line breaks will be parsed from
    /// and serialized to newline characters inside
    /// {@link Plot.Spec.preserveWhitespace | whitespace-preserving}
    /// nodes.
    static LineBreak = new Role
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

  get tokenType(): Token.Type.Node { return Token.Type.Node }
  get isLeaf(): true { return true }
  get isPlot(): false { return false }

  get length(): number { return this.is(Leaf.Text) ? this.param.length : 1 }

  pushTo(nodes: Node[]) {
    if (this.is(Leaf.Text)) {
      let prevI = nodes.length - 1, prev = prevI >= 0 ? nodes[prevI] : null
      if (prev && prev.is(Leaf.Text) && Mark.sameSet(prev.marks, this.marks)) {
        nodes[prevI] = Leaf.text(prev.param + this.param, this.marks)
        return
      }
    }
    nodes.push(this)
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
    get isSelectable() { return (this.flags & NodeFlag.Selectable) > 0 }
  }

  export interface Spec<Param> extends Node.Spec<Param> {
    toText?(node: Leaf.Any): string
    selectable?: boolean
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

  plotAt(pos: number): Plot | null {
    let node = this.nodeAt(pos)
    return node instanceof Plot ? node : null
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

  pushTo(nodes: Node[]) { nodes.push(this) }

  withMarks(marks: readonly Mark[]) {
    return Mark.sameSet(this.tag.marks, marks) ? this : this.tag.withMarks(marks).create(this.content)
  }

  get tokenType(): Token.Type.Node { return Token.Type.Node }

  static defineInline(name: string, spec: Plot.Spec<null>): Plot.Tag<null> {
    checkTagName(name)
    return new Plot.Type<null>(name, flagsFor(spec, true) | NodeFlag.NullParam, spec).default!
  }

  static defineBlock(name: string, spec: Plot.Spec<null>): Plot.Tag<null> {
    checkTagName(name)
    return new Plot.Type<null>(name, flagsFor(spec, false) | NodeFlag.NullParam, spec).default!
  }

  static defineDoc(spec: {inlineContent?: Node.Query | true, blockContent?: Node.Query, canBeEmpty?: boolean}) {
    if (!spec.inlineContent && !spec.blockContent) throw new SchemaError("Doc nodes must allow content")
    let flags = NodeFlag.NullParam | NodeFlag.Doc | NodeFlag.NullParam
    if (spec.inlineContent) flags |= NodeFlag.InlineContent
    if (spec.inlineContent || spec.canBeEmpty) flags |= NodeFlag.CanBeEmpty
    return new Plot.Type<null>("Doc", flags, {
      ...spec,
      shape: {element: ""}
    })
  }

  static End = Token.End
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
      return new Plot(this, children ? joinText(children) : none)
    }

    split(atEnd: boolean): Tag<Param> {
      return this.marks.length ? this.withMarks(this.marks.filter(p => {
        let {keepOnSplit} = p.type.spec
        return keepOnSplit && (keepOnSplit === true || keepOnSplit(this, atEnd))
      })) : this
    }

    get tokenType(): Token.Type.Open { return Token.Type.Open }

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
    readonly isolating: boolean
    readonly defining: boolean
    readonly neutral: boolean
    readonly preserveWhitespace: boolean
    readonly orientation: "row" | "column"

    constructor(name: string, flags: NodeFlag, spec: Plot.Spec<Param>) {
      super(name, flags, spec)
      if (!spec.inlineContent && !spec.blockContent)
        throw new SchemaError("Plot definitions must specify either inlineContent or blockContent")
      this.isolating = !!spec.isolating
      this.defining = !!spec.defining
      this.neutral = spec.neutral ?? !this.defining
      this.preserveWhitespace = spec.preserveWhitespace ?? !!this.hasRole(Node.Role.Code)
      this.orientation = flags & NodeFlag.InlineContent ? "row" : spec.orientation || "column"
      this.default = "defaultParam" in spec ? new Plot.Tag(this, spec.defaultParam!, none) :
        (flags & NodeFlag.NullParam) ? new Plot.Tag(this, null as any, none) : null
      if (!this.shape.atom && this.isInline && !this.inlineContent)
        throw new SchemaError("Inline tags with block content must be marked as atoms")
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

    get inlineContent() { return (this.flags & NodeFlag.InlineContent) > 0 }
    get isTextblock() { return this.isBlock && this.inlineContent }
    get isDoc() { return (this.flags & NodeFlag.Doc) > 0 }
    get isLeaf(): false { return false }
    get isPlot(): true { return true }
    get canBeEmpty() { return (this.flags & NodeFlag.CanBeEmpty) > 0 }
  }

  export interface Spec<Param> extends Node.Spec<Param> {
    /// When this node has block-level content, provide a query
    /// matching the nodes it may contain here. You generally don't
    /// want to use `Node.Group.Block` here, since specialized block
    /// types (like table cells or list items) should probably only be
    /// allowed in their designated parent plots.
    blockContent?: Node.Query
    /// When this node has inline content, provide a query specifying
    /// valid content. If set to `true`, any inline node may appear in
    /// this node.
    inlineContent?: Node.Query | true
    /// Plots with block content, by default, require at least one
    /// child. You can set this to true to allow them to be empty.
    /// Plots with inlne content can always be empty.
    canBeEmpty?: boolean
    /// Whether the sides of this plot act as a 'barrier' when {@link
    /// state.GardSelection.nextNormalCursor normalizing} a cursor
    /// position, which means that a separate cursor position exists
    /// at its boundary. By default, nodes that are {@link
    /// Plot.Spec.isolating | isolating}, {@link
    /// Plot.Spec.preserveWhitespace | whitespace-preserving}, or both
    /// a {@link Leaf | leaf} and a block count as barriers.
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
    /// serializer. Defaults to false, unless the node has the {@link
    /// Node.Role.Code} role.
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
    /// Neutral nodes may be completely replaced when their entire
    /// content gets replaced. Defaults to `!defining`.
    neutral?: boolean
    /// Whether block nodes of this type should be automatically
    /// joined when they become adjacent through an edit. Defaults to
    /// false. Note that editing commands need to explicitly call
    /// {@link command.autoJoinBlocks} for joining to happen.
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

  let validate = true

  export class Doc extends Plot {
    constructor(readonly schema: Schema, children: readonly Node[]) {
      super(schema.docTag, children)
      if (validate) schema.validate(this)
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
      return r instanceof Pos.Plot ? r : null
    }

    contextAt(pos: number, maxDepth?: number): readonly Plot.Tag.Any[] {
      for (let {parent} = this.resolve(pos), context = [];;) {
        if (!parent.parent || maxDepth != null && context.length == maxDepth) return context
        context.push(parent.node.tag)
        parent = parent.parent
      }
    }

    static noValidate<T>(f: () => T): T {
      let prev = validate
      validate = false
      try { return f() }
      finally { validate = prev }
    }
  }
}

function flagsFor(spec: Plot.Spec<any>, inline: boolean) {
  let flags = inline ? NodeFlag.Inline : NodeFlag.None
  if (spec.inlineContent && spec.blockContent) throw new SchemaError("A tag cannot have both block and inline content")
  if (spec.inlineContent) flags |= NodeFlag.InlineContent
  if (spec.inlineContent || spec.canBeEmpty) flags |= NodeFlag.CanBeEmpty
  if ((spec as Leaf.Spec<any>).selectable) flags |= NodeFlag.Selectable
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
  for (let i = 0, last: Leaf<string> | null = null; i < nodes.length; i++) {
    let node = nodes[i]
    if (node.is(Leaf.Text)) {
      if (last && Mark.sameSet(last.marks, node.marks)) {
        if (!joined) joined = nodes.slice(0, i)
        last = joined[joined.length - 1] = Leaf.text(last.param + node.param, node.marks)
        continue
      } else {
        last = node
      }
    } else {
      last = null
    }
    if (joined) joined.push(node)
  }
  return joined || nodes
}

function checkTagName(name: string) {
  if (/[\s:]/.test(name)) throw new Error(`Tag names may not include space or colon characters (${name})`)
  if (name == "Inline" || name == "Block" || name == "Text" || name == "Doc")
    throw new Error(`Tag name ${name} is reserved`)
}
