import {Node, Prop, NodeType} from "./node"

export type Attrs = {[name: string]: string | number | undefined}

export const Reject: unique symbol = Symbol("reject")
export type Reject = typeof Reject

export type ElementRepresentation<Param> = {
  tag: string
  selector?: string
  attributes?: Attrs | ((param: Param) => Attrs)
  readElement?: (element: HTMLElement) => Param | Reject
}

export type AttributeRepresentation<Param> = {
  attribute: string
  value?: string | ((param: Param) => string | null)
  readAttribute?: (value: string) => Param | Reject
}

export function isElementRepresentation<T>(repr: AttributeRepresentation<T> | ElementRepresentation<T>): repr is ElementRepresentation<T> {
  return (repr as ElementRepresentation<any>).tag != null
}

export function isAttributeRepresentation<T>(repr: AttributeRepresentation<T> | ElementRepresentation<T>): repr is AttributeRepresentation<T> {
  return (repr as AttributeRepresentation<any>).attribute != null
}

export type NodeSpec<Props extends {}> = {
  props?: {[name in keyof Props]: LocalPropSpec<Props[name]>}
  content?: string
  group?: string
  toText?: (node: Node) => string
  dom: ElementRepresentation<Props> | ((props: Props) => HTMLElement)
  parseRules?: readonly ElementParseRule<Props>[]
  preserveWhitespace?: boolean
}

export type LocalPropSpec<Value> = {
  required?: boolean
  dom?: ElementRepresentation<Value> | AttributeRepresentation<Value>
}

export type PropSpec<Value> = {
  nodes?: string
  rank?: number
  spanning?: boolean
  // FIXME rename
  multi?: Value extends ReadonlyArray<infer Content> ? {compare: (a: Content, b: Content) => number} : never
  dom: ElementRepresentation<Value> | AttributeRepresentation<Value>
  parseRules?: readonly (ElementParseRule<Value> | AttributeParseRule<Value>)[]
}

export interface BaseParseRule {
  ignore?: boolean | "skip"
  consuming?: boolean
}

export interface ElementParseRule<Param> extends BaseParseRule {
  selector: string
  node?: Param extends {} ? NodeType<Param> : never
  prop?: Prop<Param>
  param?: Param
  readElement?: (element: HTMLElement) => Param | Reject
}

export interface AttributeParseRule<Param> extends BaseParseRule {
  attribute: string
  prop?: Prop<Param>
  param?: Param
  readAttribute?: (value: string) => Param | Reject
}

export type ParseRule<Param = any> = ElementParseRule<Param> | AttributeParseRule<Param>
