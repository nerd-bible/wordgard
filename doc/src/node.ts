import {Slice, OpenToken, Token, CloseToken} from "./slice"
import {TagSpec} from "./spec"
import {Schema, SchemaElement} from "./schema"
import {Context} from "./context"
import {PropType, PropSet} from "./prop"
import {eqArray, none, splitGroups, compareDeep} from "./helper"

export const enum TokenType { Open, Close, Node }

const enum TagFlag {
  None = 0,
  Inline = 1,
  InlineContent = 2,
  Text = 4,
  Leaf = 8,
  Doc = 16,
  NullParam = 32
}

function flagsFor(spec: TagSpec<any>, inline: boolean) {
  let flags = inline ? TagFlag.Inline : TagFlag.None
  if (spec.inlineContent && spec.blockContent) throw new Error("A tag cannot have both block and inline content")
  if (spec.inlineContent) flags |= TagFlag.InlineContent
  else if (!spec.blockContent) flags |= TagFlag.Leaf
  return flags
}

export class TagType<Param> {
  groups: readonly string[]
  contentGroups: readonly string[]
  readonly childCache: Map<TagType<unknown>, boolean> = new Map
  readonly preserveWhitespace: boolean
  readonly default: Tag<Param> | null

  constructor(
    readonly name: string,
    readonly flags: TagFlag,
    readonly spec: TagSpec<Param>
  ) {
    let groups = this.groups = [name]
    if (flags & TagFlag.Inline) groups.push("Inline")
    if (spec.group) for (let g of splitGroups(spec.group)) groups.push(g)
    let content = spec.inlineContent === true ? "Inline" : spec.inlineContent  || spec.blockContent
    this.contentGroups = content ? splitGroups(content) : none
    this.preserveWhitespace = !!spec.preserveWhitespace
    this.default = "defaultParam" in spec ? new Tag(this, spec.defaultParam!) :
      (flags & TagFlag.NullParam) ? new Tag(this, null as any) : null
  }

  static defineInline<T>(name: string, spec: TagSpec<T>) {
    checkReserved(name)
    return new TagType<T>(name, flagsFor(spec, true), spec)
  }

  static defineBlock<T>(name: string, spec: TagSpec<T>) {
    checkReserved(name)
    return new TagType<T>(name, flagsFor(spec, false), spec)
  }

  get schemaElement(): SchemaElement { return this }

  of(param: Param) { return new Tag(this, param) }

  isInGroup(group: string) {
    return group == "_" || this.groups.includes(group)
  }

  canContain(child: TagType<any>) {
    let result = this.childCache.get(child)
    if (result == null) {
      result = (child.flags & TagFlag.Doc) ? false : this.contentGroups.some(g => child.isInGroup(g))
      this.childCache.set(child, result)
    }
    return result
  }

  sharesContent(other: TagType<any>) {
    return other.contentGroups.some(g => this.contentGroups.includes(g))
  }

  checkProps(props: PropSet) {
    for (let prop of props.set) if (!prop.type.canTarget(this))
      throw new Error(`Prop ${prop.name} cannot be applied to node ${this.name}`)
    return props
  }

  checkChildren(children: readonly Node[]) {
    for (let child of children)
      if (!this.canContain(child.tag.type))
        throw new Error(`${child.name} is not a valid child of ${this.name}`)
    return children
  }

  isInline() { return (this.flags & TagFlag.Inline) > 0 }
  isText() { return (this.flags & TagFlag.Text) > 0 }
  isBlock() { return (this.flags & TagFlag.Inline) == 0 }
  inlineContent() { return (this.flags & TagFlag.InlineContent) > 0 }
  isTextblock() { return this.isBlock() && this.inlineContent() }
  isLeaf() { return (this.flags & TagFlag.Leaf) > 0 }
  isDoc() { return (this.flags & TagFlag.Doc) > 0 }
}

export class Tag<Param = unknown> {
  constructor(
    readonly type: TagType<Param>,
    readonly param: Param
  ) {}

  get name() { return this.type.name }

  static defineInline(name: string, spec: TagSpec<null>) {
    checkReserved(name)
    return new TagType<null>(name, flagsFor(spec, true) | TagFlag.NullParam, spec).default!
  }

  static defineBlock(name: string, spec: TagSpec<null>) {
    checkReserved(name)
    return new TagType<null>(name, flagsFor(spec, false) | TagFlag.NullParam, spec).default!
  }

  static defineDoc(spec: {inlineContent?: string, blockContent?: string}) {
    if (!spec.inlineContent && !spec.blockContent) throw new Error("Doc nodes must allow content")
    let flags = TagFlag.NullParam | TagFlag.Doc
    if (spec.inlineContent) flags |= TagFlag.InlineContent
    return new TagType<Schema>("Doc", flags, {
      ...spec,
      dom: {element: ""}
    })
  }

  get schemaElement(): SchemaElement { return this.type }

  create(props: PropSet, children?: readonly Node[]): Node
  create(children?: readonly Node[]): Node
  create(propsOrChildren?: PropSet | readonly Node[], children?: readonly Node[]): Node {
    if (this.isDoc()) throw new Error("Document nodes must be created with schema.doc()")
    let props = PropSet.empty
    if (propsOrChildren) {
      if (Array.isArray(propsOrChildren)) children = propsOrChildren
      else if (propsOrChildren instanceof Node) children = [propsOrChildren]
      else props = propsOrChildren as PropSet
    }
    return new Node(this, this.type.checkProps(props), this.type.checkChildren(joinText(children || none)))
  }

  eq(other: Tag) {
    return this == other || this.type == other.type && compareDeep(this.param, other.param)
  }

  isInline() { return this.type.isInline() }
  isText() { return this.type.isText() }
  isBlock() { return this.type.isBlock() }
  inlineContent() { return this.type.inlineContent() }
  isTextblock() { return this.type.isTextblock() }
  isLeaf() { return this.type.isLeaf() }
  isDoc() { return this.type.isDoc() }
}

function checkReserved(name: string) {
  if (name == "Inline" || name == "Block" || name == "Text" || name == "Doc")
    throw new Error(`Node name ${name} is reserved`)
}

export class Node {
  contentLength: number
  tag: Tag<unknown>

  constructor(
    tag: Tag<any>,
    readonly props: PropSet,
    readonly children: readonly Node[],
  ) {
    this.tag = tag
    this.contentLength = children.reduce((s, c) => s + c.length, 0)
  }

  get name() { return this.tag.name }

  get length() { return this.tag.type == Text ? (this.tag.param as string).length : this.isLeaf() ? 1 : 2 + this.contentLength }

  get text(): string | null { return this.isText() ? this.tag.param as string : null }

  cutText(this: TextNode, from: number, to = this.text.length) {
    return !from && to == this.text.length ? this : new Node(Text.of(this.text.slice(Math.max(from, 0), Math.max(0, to))), this.props, none)
  }

  withProps(props: PropSet) {
    return props.eq(this.props) ? this : new Node(this.tag, this.tag.type.checkProps(props), this.children)
  }

  pushTo(nodes: Node[]) {
    let last = nodes.length - 1
    if (last >= 0 && this.isText() && nodes[last].isText() && nodes[last].props.eq(this.props))
      nodes[last] = Node.text(nodes[last].text + this.text, this.props)
    else
      nodes.push(this)
  }

  sameMarkup(other: Node) {
    return this.tag.eq(other.tag) && this.props.eq(other.props)
  }

  eq(other: Node): boolean {
    return this == other || this.sameMarkup(other) && eqArray(this.children, other.children)
  }

  copy(children: readonly Node[]) {
    return new Node(this.tag, this.props, this.tag.type.checkChildren(joinText(children)))
  }

  slice(from: number, to = this.length) {
    if (from == to) return Slice.empty
    let content: Token[] = []
    this.sliceNode(content, from, to)
    return new Slice(content)
  }

  /// @internal
  sliceNode(content: Token[], from: number, to: number) {
    if (this.isText()) {
      if (from < to) content.push(this.cutText(from, to))
      return
    }
    if (from <= 0) {
      if (to >= this.length) {
        content.push(this)
        return
      }
      content.push(new OpenToken(this.copy(none)))
    }
    sliceContent(content, this.children, from - 1, to - 1)
    if (to >= this.length) content.push(CloseToken)
  }

  isInline() { return this.tag.isInline() }
  isText(): this is TextNode { return this.tag.isText() }
  isBlock() { return this.tag.isBlock() }
  inlineContent() { return this.tag.inlineContent() }
  isTextblock() { return this.tag.isTextblock() }
  isLeaf() { return this.tag.isLeaf() }
  isDoc() { return this.tag.isDoc() }

  iterate(from: number, to: number, f: (node: Node, pos: number) => boolean | void) {
    if (f(this, 0) !== false)
      this.iterInner(0, from, to, f)
  }

  nodeAt(pos: number): Node | null {
    for (let child of this.children) {
      if (pos == 0) return child
      if (pos < child.length) return child.nodeAt(pos - 1)
      pos -= child.length
    }
    return null
  }

  /// @internal
  iterInner(contentStart: number, from: number, to: number, f: (node: Node, pos: number) => boolean | void) {
    for (let pos = contentStart, i = 0; i < this.children.length; i++) {
      if (pos >= to) break
      let child = this.children[i], start = pos
      pos += child.length
      if (pos <= from) continue
      if (f(child, start) !== false) child.iterInner(start + 1, from, to, f)
    }
  }

  /// @internal
  toString() {
    return propsToString(this.props, this.isText() ? JSON.stringify(this.text) : this.name + (this.isLeaf() ? `` : `(${this.children.join()})`))
  }

  toJSON(): NodeJSON {
    let result: NodeJSON = {type: this.name}
    if (this.tag != this.tag.type.default) result.param = this.tag.param
    if (!this.props.empty) {
      result.props = Object.create(null)
      for (let {name, value} of this.props.set) result.props![name] = value
    }
    if (this.isText()) result.text = this.text
    if (this.children.length) result.children = this.children.map(c => c.toJSON())
    return result
  }

  textContent(options: {
    from?: number, to?: number,
    blockSeparator?: string,
    leafText?: string | ((node: Node) => string)
  } = {}) {
    let {from = 0, to = this.length, blockSeparator = "\n", leafText} = options
    let text = "", first = true
    this.iterate(from, to, (node, pos) => {
      let nodeText = node.isText() ? node.text.slice(Math.max(0, from - pos), Math.min(node.length, to - pos))
        : !node.isLeaf() ? ""
        : leafText ? (typeof leafText === "function" ? leafText(node) : leafText)
        : node.tag.type.spec.toText ? node.tag.type.spec.toText(node)
        : ""
      if (node.isBlock() && (node.isLeaf() && nodeText || node.isTextblock())) {
        if (first) first = false
        else text += blockSeparator
      }
      text += nodeText
    })
    return text
  }

  prop<Value>(prop: PropType<Value>, required: true): Value
  prop<Value>(prop: PropType<Value>): Value | undefined
  prop<Value>(prop: PropType<Value>, required = false): Value | undefined {
    return (this.props.get as any)(prop, required)
  }

  get tokenType(): TokenType.Node { return TokenType.Node }

  static text(text: string, props: PropSet = PropSet.empty) {
    return new Node(Text.of(text), Text.checkProps(props), none)
  }
}

export type TextNode = Node & {text: string}

export type NodeJSON = {
  type: string,
  param?: any
  props?: {[name: string]: any}
  text?: string,
  children?: readonly NodeJSON[]
}

export type MarkJSON = {
  type: string,
  params?: any
}

export class DocNode extends Node {
  constructor(tag: Tag<Schema>, children: readonly Node[]) {
    super(tag, PropSet.empty, children)
  }

  get length() { return this.contentLength }

  get schema() { return this.tag.param as Schema }

  copy(children: readonly Node[]) {
    return new DocNode(this.tag as Tag<Schema>, this.tag.type.checkChildren(children))
  }

  withProps(props: PropSet) {
    if (props.empty) throw new Error("Document nodes cannot have props")
    return this
  }

  sliceNode(content: Token[], from: number, to: number) {
    sliceContent(content, this.children, from, to)
  }

  resolve(pos: number) {
    return Context.resolve(this, pos)
  }
}

function sliceContent(content: Token[], nodes: readonly Node[], from: number, to: number) {
  let off = 0
  for (let child of nodes) {
    if (off >= to) break
    let start = off
    off += child.length
    if (off <= from) continue
    child.sliceNode(content, from - start, to - start)
  }
}

export const Text = new TagType<string>("Text", TagFlag.Leaf | TagFlag.Text | TagFlag.Inline, {
  dom: {element: ""}
})

// FIXME show values? display differently?
function propsToString(props: PropSet, inner: string) {
  for (let i = props.set.length - 1; i >= 0; i--)
    inner = props.set[i].name + "(" + inner + ")"
  return inner
}

function joinText(nodes: readonly Node[]) {
  if (!nodes.length || nodes[0].isBlock()) return nodes
  let joined: Node[] | undefined
  for (let i = 0, last = null; i < nodes.length; i++) {
    let node = nodes[i]
    if (last && node.isText() && last.isText() && last.props.eq(node.props)) {
      if (!joined) joined = nodes.slice(0, i)
      last = joined[joined.length - 1] = Node.text(last.text + node.text, node.props)
    } else {
      last = node
      if (joined) joined.push(node)
    }
  }
  return joined || nodes
}
