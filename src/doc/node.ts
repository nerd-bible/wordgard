import {Slice, Token, TokenType, End} from "./slice"
import {TextOutput} from "./text"
import {PartShape} from "./shape"
import {Schema} from "./schema"
import {Pos} from "./pos"
import {Prop} from "./prop"
import {eqArray, none, splitGroups, compareDeep} from "./helper"
import {ElementShape, StructureShape, ElementParseRule} from "./shape"

const enum PartFlag { // FIXME drop some of these?
  None = 0,
  Inline = 1,
  InlineContent = 2,
  Doc = 16,
  NullParam = 32,
  List = 64
}

export class Leaf<Param> {
  constructor(readonly type: Leaf.Type<Param>, readonly param: Param, readonly props: readonly Prop<unknown>[]) {}

  get name() { return this.type.name }
  get label() { return this }

  prop<Value>(prop: Prop.Type<Value>): Value | undefined {
    for (let v of this.props) if (v.type == prop) return v.value as Value
    return undefined
  }

  eq(other: Part | Part.Tag): boolean {
    return this == other || other.isLeaf && this.type == other.type && compareDeep(this.param, other.param) &&
      Prop.sameSet(this.props, other.props)
  }

  is<T>(type: Leaf.Type<T>): this is Leaf<T> {
    return this.type == type as Leaf.Type<any>
  }

  static defineInline(name: string, spec: Leaf.Spec<null>): Leaf<null> {
    checkTagName(name)
    return new Leaf.Type<null>(name, flagsFor(spec, true) | PartFlag.NullParam, spec).default!
  }

  static defineBlock(name: string, spec: Leaf.Spec<null>): Leaf<null> {
    checkTagName(name)
    return new Leaf.Type<null>(name, flagsFor(spec, false) | PartFlag.NullParam, spec).default!
  }

  withProps(props: readonly Prop<unknown>[]) {
    return Prop.sameSet(this.props, props) ? this : this.type.of(this.param, props)
  }

  get tokenType(): TokenType.Part { return TokenType.Part }

  get isInline() { return this.type.isInline }
  get isBlock() { return this.type.isBlock }
  get isLeaf(): true { return true }
  get isText() { return this.type == Leaf.Text as Leaf.Type<any> }

  get length(): number { return this.is(Leaf.Text) ? this.param.length : 1 }

  toJSON(): Part.JSON {
    let result: Part.JSON = {type: this.name}
    if (this != this.type.default) result.param = this.param
    if (this.props.length) {
      result.props = Object.create(null)
      for (let {name, value} of this.props) result.props![name] = value
    }
    return result
  }

  join(onto: Part) {
    if (!this.is(Leaf.Text) || !Leaf.Text.chk(onto) || !Prop.sameSet(this.props, onto.props)) return null
    return Leaf.text(onto.param + this.param, this.props)
  }

  pushTo(parts: Part[]) {
    let joined = parts.length && this.join(parts[parts.length - 1])
    if (joined) parts[parts.length - 1] = joined
    else parts.push(this)
  }

  sliceText(from: number, to?: number) {
    if (!this.is(Leaf.Text)) throw new Error("Calling sliceText on a non-text node")
    if (to == null) to = this.param.length
    if (!from && to == this.param.length) return this
    return Leaf.Text.of(this.param.slice(Math.max(from, 0), Math.max(0, to)), this.props)
  }

  static text(text: string, props: readonly Prop<any>[] = none) {
    return Leaf.Text.of(text, props)
  }
}

export namespace Leaf {
  export class Type<Param> {
    readonly default: Leaf<Param> | null
    readonly groups: readonly string[]
    readonly shape: PartShape<Param>

    constructor(
      readonly name: string,
      readonly flags: PartFlag,
      readonly spec: Leaf.Spec<Param>
    ) {
      this.default = "defaultParam" in spec ? new Leaf(this, spec.defaultParam!, none) :
        (flags & PartFlag.NullParam) ? new Leaf(this, null as any, none) : null
      this.groups = typeGroups(this)
      this.shape = PartShape.from(this, spec.shape)
    }

    static defineInline<T>(name: string, spec: Leaf.Spec<T>) {
      checkTagName(name)
      return new Leaf.Type<T>(name, flagsFor(spec, true), spec)
    }

    static defineBlock<T>(name: string, spec: Leaf.Spec<T>) {
      checkTagName(name)
      return new Leaf.Type<T>(name, flagsFor(spec, false), spec)
    }

    of(param: Param, props: readonly Prop<any>[] = none) {
      if (!props.length && this.default && compareDeep(this.default.param, param)) return this.default
      return new Leaf(this, param, props)
    }

    isInGroup(group: string) { return isInGroup(this, group) }

    get isInline() { return (this.flags & PartFlag.Inline) > 0 }
    get isBlock() { return (this.flags & PartFlag.Inline) == 0 }
    get isLeaf(): true { return true }

    // FIXME find a better name
    chk(part: Part): part is Leaf<Param>
    chk(tag: Part.Tag): tag is Leaf<Param>
    chk(obj: Part | Part.Tag) { return obj.type == this }
  }

  export interface Spec<Param> extends Part.Spec<Param> {
    /// Makes this tag the canonical line break for the schema. The node
    /// must be inline and a leaf, and have no required parameter. Nodes
    /// marked as line breaks will be parsed from and serialized to
    /// newline characters inside
    /// [whitespace-preserving](#state.Tag.Spec.preserveWhitespace)
    /// nodes.
    isLineBreak?: boolean
    toText?(node: Leaf.Any): string
  }

  export type Any = Omit<Leaf<unknown>, "type" | "label" | "withProps"> & {
    type: Leaf.Type<any>,
    label: Leaf.Any,
    withProps(props: readonly Prop[]): Leaf.Any
  }

  export const Text = new Leaf.Type<string>("Text", PartFlag.Inline, {
    shape: {element: ""}
  })
}

function checkTagName(name: string) {
  if (/[\s:]/.test(name)) throw new Error(`Tag names may not include space or colon characters (${name})`)
  if (name == "Inline" || name == "Block" || name == "Text" || name == "Doc")
    throw new Error(`Tag name ${name} is reserved`)
}

export type Part = Plot | Leaf.Any

export namespace Part {
  export type Type<T> = Leaf.Type<T> | Plot.Type<T>

  export type Tag = Leaf.Any | Plot.Label.Any

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
    group?: string
    shape: ElementShape<Param> | StructureShape<Param>
    parseRules?: readonly ElementParseRule<Param>[]
  }

  export type Selector = Leaf.Any | Plot.Label.Any | Part.Type<any> | string | readonly Part.Selector[]

  export function selector(selector?: Part.Selector): (type: Part.Type<any>) => boolean {
    if (!selector) return () => true
    if (Array.isArray(selector)) {
      let inner = selector.map(Part.selector)
      return type => inner.some(s => s(type))
    }
    if (typeof selector == "string") {
      if (!/ /.test(selector)) return t => t.isInGroup(selector as string)
      let groups = selector.split(/ /)
      return t => groups.some(g => t.isInGroup(g))
    }
    // FIXME have a Part.is predicate?
    let type = selector instanceof Leaf.Type || selector instanceof Plot.Type ? selector
      : (selector as Leaf<any> | Plot.Label<any>).type
    return t => t === type
  }

  export interface JSON {
    type: string
    param?: any
    props?: {[name: string]: any}
    content?: readonly Part.JSON[]
  }
}

export class Plot {
  contentLength: number
  label: Plot.Label.Any

  constructor(
    tag: Plot.Label.Any,
    readonly content: readonly Part[],
  ) {
    this.label = tag
    this.contentLength = content.reduce((s, c) => s + c.length, 0)
  }

  get name() { return this.label.name }
  get type() { return this.label.type }
  get props() { return this.label.props }

  get length() {
    return 2 + this.contentLength
  }

  eq(other: Part | Part.Tag): boolean {
    return this == other || other instanceof Plot && this.label.eq(other.label) && eqArray(this.content, other.content)
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
      out.push(this.label)
    }
    sliceContent(out, this.content, from - 1, to - 1)
    if (to >= this.length) out.push(Plot.End)
  }

  get isText(): false { return false }
  get isInline() { return this.type.isInline }
  get isBlock() { return this.type.isBlock }
  get inlineContent() { return this.type.inlineContent }
  get isTextblock() { return this.type.isTextblock }
  get isLeaf(): false { return false }
  get isDoc() { return this.type.isDoc }

  get firstPart(): Part | null {
    return this.content.length ? this.content[0] : null
  }

  get lastPart(): Part | null {
    let last = this.content.length - 1
    return last < 0 ? null : this.content[last]
  }

  /// Iterate though the given range (or the entire document, when
  /// given only one argument), and call the given function on every
  /// node that overlaps the given range, outer nodes before inner
  /// nodes. When the function returns `false` for a node, descendents
  /// of that node are not iterated.
  iterate(from: number, to: number, f: (part: Part, pos: number, parent: Plot | null, index: number) => boolean | void): void
  iterate(f: (part: Part, pos: number, parent: Plot | null, index: number) => boolean | void): void
  iterate(a: number | ((part: Part, pos: number, parent: Plot | null, index: number) => boolean | void),
          b?: number, c?: (node: Part, pos: number, parent: Plot | null, index: number) => boolean | void): void {
    let [from, to, f] = typeof a == "number" ? [a, b!, c!] : [0, this.length, a]
    if (this.isDoc || f(this, 0, null, 0) !== false)
      this.iterInner(0, from, to, f)
  }

  partAt(pos: number): Part | null {
    for (let part of this.content) {
      if (pos == 0) return part
      if (pos < part.length) return part.isLeaf ? null : part.partAt(pos - 1)
      pos -= part.length
    }
    return null
  }

  /// @internal
  iterInner(contentStart: number, from: number, to: number,
            f: (part: Part, pos: number, parent: Plot | null, index: number) => boolean | void) {
    for (let pos = contentStart, i = 0; i < this.content.length; i++) {
      if (pos >= to) break
      let part = this.content[i], start = pos
      pos += part.length
      if (pos <= from) continue
      if (f(part, start, this, i) !== false && !part.isLeaf) part.iterInner(start + 1, from, to, f)
    }
  }

  /// @internal
  toString() {
    return this.name + propString(this.label.props) + "(" + this.content.join() + ")"
  }

  toJSON(): Part.JSON {
    let result = this.label.toJSON()
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
    this.iterate(from, to, (part, pos) => {
      return !out.serialize(Leaf.Text.chk(part) ? part.sliceText(Math.max(0, from - pos), Math.min(part.length, to - pos)) : part)
    })
    return out.text
  }

  prop<Value>(prop: Prop.Type<Value>): Value | undefined { return this.label.prop(prop) }

  join(other: Part) { return null }

  pushTo(parts: Part[]) { parts.push(this) }

  withProps(props: readonly Prop[]) {
    return Prop.sameSet(this.label.props, props) ? this : this.label.withProps(props).create(this.content)
  }

  get tokenType(): TokenType.Part { return TokenType.Part }

  static defineInline(name: string, spec: Plot.Spec<null>): Plot.Label<null> {
    checkTagName(name)
    return new Plot.Type<null>(name, flagsFor(spec, true) | PartFlag.NullParam, spec).default!
  }

  static defineBlock(name: string, spec: Plot.Spec<null>): Plot.Label<null> {
    checkTagName(name)
    return new Plot.Type<null>(name, flagsFor(spec, false) | PartFlag.NullParam, spec).default!
  }

  static defineDoc(spec: {inlineContent?: string | true, blockContent?: string}) {
    if (!spec.inlineContent && !spec.blockContent) throw new Error("Doc nodes must allow content")
    let flags = PartFlag.NullParam | PartFlag.Doc
    if (spec.inlineContent) flags |= PartFlag.InlineContent
    return new Plot.Type<Schema>("Doc", flags, {
      ...spec,
      shape: {element: ""}
    })
  }

  static End = End
}

export namespace Plot {
  export class Label<Param> {
    constructor(readonly type: Plot.Type<Param>, readonly param: Param, readonly props: readonly Prop<unknown>[]) {}

    prop<Value>(prop: Prop.Type<Value>): Value | undefined {
      for (let v of this.props) if (v.type == prop) return v.value as Value
      return undefined
    }

    get name() { return this.type.name }

    eq(other: Part | Part.Tag): boolean {
      return this == other || other instanceof Plot.Label && !this.isDoc && compareDeep(this.param, other.param) &&
        Prop.sameSet(this.props, other.props)
    }

    get isInline() { return this.type.isInline }
    get isBlock() { return this.type.isBlock }

    withProps(props: readonly Prop[]) {
      return Prop.sameSet(this.props, props) ? this : this.type.of(this.param, props)
    }

    create(children?: readonly Part[]): Plot {
      if (this.isDoc) throw new Error("Document nodes must be created with schema.doc()")
      return new Plot(this, this.type.checkChildren(joinText(children || none)))
    }

    is<T>(type: Plot.Type<T>): this is Plot.Label<T> {
      return this.type == type as Plot.Type<any>
    }

    split(atEnd: boolean) {
      return this.props.length ? this.withProps(this.props.filter(p => {
        let {keepOnSplit} = p.type.spec
        return keepOnSplit && (keepOnSplit === true || keepOnSplit(this, atEnd))
      })) : this
    }

    changeType(to: Plot.Label.Any) {
      if (!this.props.length) return to
      let props = to.props
      for (let prop of this.props) if (prop.type.canTarget(to.type) && (prop.type.set || !prop.isInSet(props))) {
        let {keepOnTypeChange} = prop.type.spec
        if (keepOnTypeChange && (keepOnTypeChange === true || keepOnTypeChange(this, to)))
          props = prop.addToSet(props)
      }
      return to.withProps(props)
    }

    get tokenType(): TokenType.Open { return TokenType.Open }

    get inlineContent() { return this.type.inlineContent }
    get isTextblock() { return this.type.isTextblock }
    get isLeaf(): false { return false }
    get isDoc() { return this.type.isDoc }

    toJSON(): Part.JSON {
      let result: Part.JSON = {type: this.name}
      if (this != this.type.default && !this.isDoc) result.param = this.param
      if (this.props.length) {
        result.props = Object.create(null)
        for (let {name, value} of this.props) result.props![name] = value
      }
      return result
    }
  }

  export namespace Label {
    export type Any = Omit<Plot.Label<unknown>, "type" | "split" | "withProps"> & {
      type: Plot.Type<any>,
      split(atEnd: boolean): Plot.Label.Any
      withProps(props: readonly Prop[]): Plot.Label.Any
    }
  }

  export class Type<Param> {
    readonly default: Plot.Label<Param> | null
    readonly contentGroups: readonly string[]
    readonly childCache: Map<Part.Type<any>, boolean> = new Map
    readonly isolating: boolean
    readonly defining: boolean
    readonly neutral: boolean
    readonly preserveWhitespace: boolean
    readonly orientation: "row" | "column"
    readonly groups: readonly string[]
    readonly shape: PartShape<Param>

    constructor(
      readonly name: string,
      readonly flags: PartFlag,
      readonly spec: Plot.Spec<Param>
    ) {
      let content = spec.inlineContent === true ? "Inline" : spec.inlineContent || spec.blockContent
      this.contentGroups = content ? splitGroups(content) : none
      this.isolating = !!spec.isolating
      this.defining = !!spec.defining
      this.neutral = spec.neutral ?? !this.defining
      this.preserveWhitespace = !!spec.preserveWhitespace
      this.orientation = flags & PartFlag.InlineContent ? "row" : spec.orientation || "column"
      this.default = "defaultParam" in spec ? new Plot.Label(this, spec.defaultParam!, none) :
        (flags & PartFlag.NullParam) ? new Plot.Label(this, null as any, none) : null
      this.groups = typeGroups(this)
      this.shape = PartShape.from(this, spec.shape)
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

    of(param: Param, props: readonly Prop<any>[] = none) {
      if (!props.length && this.default && compareDeep(this.default.param, param)) return this.default
      return new Plot.Label(this, param, props)
    }

    canContain(child: Part.Type<any>) {
      let result = this.childCache.get(child)
      if (result == null) {
        result = (child.flags & PartFlag.Doc) ? false : this.contentGroups.some(g => child.isInGroup(g))
        this.childCache.set(child, result)
      }
      return result
    }

    sharesContent(other: Plot.Type<any>) {
      return other.contentGroups.some(g => this.contentGroups.includes(g))
    }

    checkChildren(children: readonly Part[]) {
      for (let child of children)
        if (!this.canContain(child.type))
          throw new Error(`${child.name} is not a valid child of ${this.name}`)
      return children
    }

    isInGroup(group: string) { return isInGroup(this, group) }

    get isInline() { return (this.flags & PartFlag.Inline) > 0 }
    get isBlock() { return (this.flags & PartFlag.Inline) == 0 }
    get inlineContent() { return (this.flags & PartFlag.InlineContent) > 0 }
    get isTextblock() { return this.isBlock && this.inlineContent }
    get isDoc() { return (this.flags & PartFlag.Doc) > 0 }
    get isList() { return (this.flags & PartFlag.List) > 0 }
    get isLeaf(): false { return false }

    chk(part: Part): part is Plot
    chk(tag: Part.Tag): tag is Plot.Label<Param>
    chk(obj: Part | Part.Tag) { return obj.type == this }
  }

  export interface Spec<Param> extends Part.Spec<Param> {
    blockContent?: string
    inlineContent?: string | true

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
    preserveWhitespace?: boolean
    /// Indicates that this node represents a list, which makes some
    /// commands behave specially on it.
    isList?: boolean
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
    autoJoin?: boolean | ((before: Plot.Label.Any, after: Plot.Label.Any) => boolean)
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

  // FIXME the use of schema objects as param conflicts with the
  // plain JSON structure that we assume params have
  export class Doc extends Plot {
    constructor(tag: Plot.Label<Schema>, children: readonly Part[]) {
      super(tag, children)
    }

    get length() { return this.contentLength }

    get schema() { return this.label.param as Schema }

    slicePlot(content: Token[], from: number, to: number) {
      sliceContent(content, this.content, from, to)
    }

    resolve(pos: number) {
      return Pos.resolve(this, pos)
    }

    resolveNode(pos: number) {
      return Pos.resolveNode(this, pos)
    }

    contextAt(pos: number, maxDepth?: number): readonly Plot.Label.Any[] {
      for (let {parent} = this.resolve(pos), context = [];;) {
        if (!parent.parent || maxDepth != null && context.length == maxDepth) return context
        context.push(parent.part.label)
        parent = parent.parent
      }
    }
  }
}

function flagsFor(spec: Plot.Spec<any>, inline: boolean) {
  let flags = inline ? PartFlag.Inline : PartFlag.None
  if (spec.inlineContent && spec.blockContent) throw new Error("A tag cannot have both block and inline content")
  if (spec.inlineContent) flags |= PartFlag.InlineContent
  if (spec.isList) flags |= PartFlag.List
  return flags
}

function typeGroups(type: Part.Type<any>) {
  let groups = [type.name, "*"]
  if (type.flags & PartFlag.Inline) groups.push("Inline")
  if (type.spec.group) for (let g of splitGroups(type.spec.group)) groups.push(g)
  return groups
}

function isInGroup(type: Part.Type<any>, group: string) {
  let mod = group.indexOf(":")
  if (mod > -1) {
    let modName = group.slice(mod + 1)
    if (modName == "Leaf" && !type.isLeaf) return false
    group = group.slice(0, mod)
  }
  return group == "_" || type.groups.includes(group)
}

function propString(props: readonly Prop[]) {
  let values: string[] = []
  for (let prop of props) {
    if (prop.type.default == prop) values.push(prop.type.name)
    else values.push(`${prop.type.name}=${prop.value}`)
  }
  return values.length ? `[${values.join()}]` : ""
}

function sliceContent(out: Token[], content: readonly Part[], from: number, to: number) {
  let off = 0
  for (let child of content) {
    if (off >= to) break
    let start = off
    off += child.length
    if (off <= from) continue
    if (!child.isLeaf) {
      child.slicePlot(out, from - start, to - start)
    } else if (child.isText) {
      out.push(child.sliceText(from - start, to - start))
    } else {
      out.push(child)
    }
  }
}

function joinText(parts: readonly Part[]) {
  if (!parts.length || parts[0].isBlock) return parts
  let joined: Part[] | undefined
  for (let i = 0, last: Leaf.Any | null = null; i < parts.length; i++) {
    let part = parts[i], join
    if (join = last && part.join(last)) {
      if (!joined) joined = parts.slice(0, i)
      last = joined[joined.length - 1] = join
    } else {
      last = part.isLeaf ? part : null
      if (joined) joined.push(part)
    }
  }
  return joined || parts
}
