import {Node, Tag, TagType} from "./node"
import {Prop, PropType} from "./prop"

export type Attrs = {[name: string]: string | number | undefined}

export const Reject: unique symbol = Symbol("reject")
export type Reject = typeof Reject

export type ElementRepresentation<Param> = {
  element: string
  selector?: string
  attributes?: Attrs | ((param: Param) => Attrs)
  readElement?: (element: HTMLElement) => Param | Reject
}

export type AttributeRepresentation<Param> = {
  attribute: string
  value?: string | ((param: Param) => string | null)
  readAttribute?: (value: string) => Param | Reject
}

export function isElementRepresentation<T>(
  repr: AttributeRepresentation<T> | ElementRepresentation<T>
): repr is ElementRepresentation<T> {
  return (repr as ElementRepresentation<any>).element != null
}

export function isAttributeRepresentation<T>(
  repr: AttributeRepresentation<T> | ElementRepresentation<T>
): repr is AttributeRepresentation<T> {
  return (repr as AttributeRepresentation<any>).attribute != null
}

// FIXME split inline and block specs?
export type TagSpec<Param> = {
  blockContent?: string
  inlineContent?: string | true
  defaultParam?: Param extends null ? never : Param
  atom?: boolean
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
  toText?: (node: Node) => string
  dom: ElementRepresentation<Param> | ((param: Param) => HTMLElement)
  parseRules?: readonly ElementParseRule<Param>[]
  preserveWhitespace?: boolean
  /// Indicates that this type of block is the default generic block
  /// type in parent nodes where it may occur (which is appropriate
  /// for, for example, paragraphs tags). Default blocks should not
  /// have a required param. When not specified, the configuration
  /// precedence order determines which child type is the default.
  defaultBlock?: boolean
  /// Makes this tag the canonical line break for the schema. The node
  /// must be inline and a leaf, and have no required parameter. Nodes
  /// marked as line breaks will be parsed from and serialized to
  /// newline characters inside
  /// [whitespace-preserving](#state.TagSpec.preserveWhitespace)
  /// nodes.
  isLineBreak?: boolean
  isolating?: boolean
  defining?: boolean
  neutral?: boolean
  autoJoin?: boolean | ((before: Tag, after: Tag) => boolean) // FIXME implement
  // FIXME should this be integrated in Tag.split? Handling validity in parent may be awkward
  splitTag?: (tag: Tag, atEnd: boolean) => Tag | null
  /// For inline nodes with inline content, this determines whether
  /// there are normalized cursor positions directly inside the node.
  /// The default is to only have cursor positions right outside the
  /// node.
  cursorInsideBounds?: boolean // FIXME make a node flag?
}

export type PropSpec<Value> = {
  /// Which node tags this prop may apply to, as a space separated
  /// string of tag or group names. The default is `"Inline:Atom"`.
  tags?: string
  /// Determines the position of this prop relative to other props.
  /// Props with lower rank appear first in prop set arrays, and are
  /// rendered around higher rank props in DOM representation. Ties
  /// are broken by name.
  rank?: number
  /// Whether this mark should be active when the cursor is positioned
  /// at its end (or at its start when that is also the start of the
  /// parent node). Defaults to true.
  inclusive?: boolean
  /// Whether this prop can span across multiple nodes, or refers to
  /// an individual node. Only spanning props can be added to text.
  /// Spanning props with an element representation can be drawn as
  /// elements containing multiple nodes, unless another, lower-ranked
  /// prop requires the nodes to be wrapped separately. Defaults to
  /// true for specs with an element representation, false
  /// for specs with an attribute representation.
  spanning?: boolean
  /// Used by `Tag.split` to determine whether to keep this prop in
  /// the split-off tag. `atEnd` will be true if the split happens at
  /// the end of the node's content.
  keepOnSplit?: boolean | ((tag: Tag<unknown>, atEnd: boolean) => boolean)
  /// Used by `Tag.changeType` to decide whether props of this type
  /// are preserved after the type change.
  keepOnTypeChange?: boolean | ((from: Tag<unknown>, to: TagType<unknown>) => boolean)
  /// A function or type name used to validate values of this prop.
  /// See [`TagSpec.validateParam`](#doc.TagSpec.validateParam).
  validate?: string | ((value: Value) => void)
  set?: Value extends ReadonlyArray<infer Content> ? {compare: (a: Content, b: Content) => number} : never
  dom: ElementRepresentation<Value> | AttributeRepresentation<Value>
  parseRules?: readonly (ElementParseRule<Value> | AttributeParseRule<Value>)[]
}

export interface ElementParseRule<Param> {
  selector: string
  tag?: TagType<Param> | Tag<Param>
  prop?: PropType<Param> | Prop<Param>
  ignore?: boolean | "skip"
  param?: Param
  readElement?: (element: HTMLElement) => Param | Reject
  contentElement?: string | ((elt: HTMLElement) => HTMLElement)
}

export function isElementParseRule(rule: ParseRule): rule is ElementParseRule<unknown> {
  return (rule as any).selector != null
}

export interface AttributeParseRule<Param> {
  attribute: string
  prop?: PropType<Param> | Prop<Param>
  ignore?: boolean
  clearProp?: (prop: Prop<unknown>) => boolean
  param?: Param
  value?: string
  readAttribute?: (value: string) => Param | Reject
  consuming?: boolean
}

export function isAttributeParseRule(rule: ParseRule): rule is AttributeParseRule<unknown> {
  return (rule as any).attribute != null
}

export type ParseRule<Param = any> = ElementParseRule<Param> | AttributeParseRule<Param>
