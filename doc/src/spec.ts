import {Node, Prop, PropType, Tag, TagType} from "./node"

export type Attrs = {[name: string]: string | number | undefined}

export const Reject: unique symbol = Symbol("reject")
export type Reject = typeof Reject

export type ElementRepresentation<Param> = {
  tag: string // FIXME too easy to confuse with our use of tag
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
  return (repr as ElementRepresentation<any>).tag != null
}

export function isAttributeRepresentation<T>(
  repr: AttributeRepresentation<T> | ElementRepresentation<T>
): repr is AttributeRepresentation<T> {
  return (repr as AttributeRepresentation<any>).attribute != null
}

export type TagSpec<Param> = {
  kind: "block" | "inline"
  blockContent?: string
  // FIXME allow inlineContent: true
  inlineContent?: string
  defaultParam?: Param extends null ? never : Param
  group?: string
  toText?: (node: Node) => string
  dom: ElementRepresentation<Param> | ((param: Param) => HTMLElement)
  parseRules?: readonly ElementParseRule<Param>[]
  preserveWhitespace?: boolean
}

export type PropSpec<Value> = {
  tags?: string
  rank?: number
  spanning?: boolean
  // FIXME rename
  multi?: Value extends ReadonlyArray<infer Content> ? {compare: (a: Content, b: Content) => number} : never
  dom: ElementRepresentation<Value> | AttributeRepresentation<Value>
  parseRules?: readonly (ElementParseRule<Value> | AttributeParseRule<Value>)[]
}

export interface BaseParseRule {
  ignore?: boolean | "skip"
}

export interface ElementParseRule<Param> extends BaseParseRule {
  selector: string
  tag?: TagType<Param> | Tag<Param>
  prop?: PropType<Param> | Prop<Param>
  readElement?: (element: HTMLElement) => Param | Reject
  contentElement?: string | ((elt: HTMLElement) => HTMLElement)
}

export function isElementParseRule(rule: ParseRule): rule is ElementParseRule<unknown> {
  return (rule as any).selector != null
}

export interface AttributeParseRule<Param> extends BaseParseRule {
  attribute: string
  prop?: PropType<Param> | Prop<Param>
  clearProp?: (prop: Prop<unknown>) => boolean
  readAttribute?: (value: string) => Param | Reject
  consuming?: boolean
}

export function isAttributeParseRule(rule: ParseRule): rule is AttributeParseRule<unknown> {
  return (rule as any).attribute != null
}

export type ParseRule<Param = any> = ElementParseRule<Param> | AttributeParseRule<Param>
