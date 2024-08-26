
// FIXME typing of optional local props in node representations

export type Representation<Param> = ElementRepresentation<Param>
  | AttributeRepresentation<Param>
  | StyleRepresentation<Param>
  | DynamicElementRepresentation<Param>

export type ElementRepresentation<Param> = {
  tag: string
  selector?: string
  toAttributes?: Attrs | ((param: Param) => Attrs)
  fromAttributes?: Param | ((elt: HTMLElement) => Param | Reject)
}

export type DynamicElementRepresentation<Param> = {
  create: (param: Param) => HTMLElement
}

export function isElementRepresentation(repr: Representation<any>): repr is ElementRepresentation<any> {
  return (repr as ElementRepresentation<any>).tag != null
}

export type AttributeRepresentation<Param> = {
  attribute: string
  toAttribute?: (param: Param) => string | null
  fromAttribute: (value: string) => Param | typeof Reject
}

export function isAttributeRepresentation(repr: Representation<any>): repr is AttributeRepresentation<any> {
  return (repr as AttributeRepresentation<any>).attribute != null
}

export type StyleRepresentation<Param> = {
  style: string
  toStyle?: (param: Param) => string | null
  fromStyle: (value: string) => Param | typeof Reject
}

export function isStyleRepresentation(repr: Representation<any>): repr is StyleRepresentation<any> {
  return (repr as StyleRepresentation<any>).style != null
}
