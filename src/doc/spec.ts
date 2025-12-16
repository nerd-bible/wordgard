import {Tag} from "./node"
import {Prop} from "./prop"
import {Reject} from "./shape"

export interface ElementParseRule<Param> {
  selector: string
  tag?: Tag.Type<Param> | Tag<Param>
  prop?: Prop.Type<Param> | Prop<Param>
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
  prop?: Prop.Type<Param> | Prop<Param>
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
