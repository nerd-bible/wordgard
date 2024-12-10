import {EditorView} from "./editorview"
import {SpanLabel, SpanSet} from "@willows/state"
import {Pos, Node, Tag, Walker} from "@willows/doc"

// FIXME define event handling and update mechanisms

export abstract class Widget extends SpanLabel {
  abstract render(view: EditorView): HTMLElement

  get side() { return -1 }

  get startSide() { return this.side }
  get endSide() { return this.side }
  get point() { return true }
  get rank() { return 0 }

  at(pos: number) { return this.span(pos) }
}

export enum DecorationType { Spanning, Atom }

export class Decoration extends SpanLabel {
  attributes: Record<string, string> | undefined
  element: string | undefined
  private _rank: number
  type: DecorationType

  constructor(spec: {
    attributes?: Record<string, string>,
    element?: string,
    rank?: number,
    atoms?: boolean
  }, readonly leaf: boolean) {
    super()
    this.attributes = spec.attributes
    this.element = spec.element
    this._rank = Math.max(0, Math.min(100, spec.rank ?? 100))
    this.type = spec.atoms ? DecorationType.Atom : DecorationType.Spanning
  }

  get rank() { return this._rank }
}

export type Decorator = Decoration | Widget

export type DecorationSet = SpanSet<Decorator>

export interface DecoWalker {
  skip(node: Node, deco: readonly Decoration[]): void
  enter(tag: Tag, deco: readonly Decoration[]): void | boolean
  leave(): void
  widget(widget: Widget, deco: readonly Decoration[]): void
}



export function iterateDeco(pos: Pos, deco: readonly DecorationSet[], from: number, to: number, walker: DecoWalker) {
  let active: readonly Decoration[] = []
  let wrap: Walker = {
    skip(node) { walker.skip(node, active) },
    enter(tag) { walker.enter(tag, active) },
    leave() { walker.leave() }
  }
  SpanSet.fragments(deco, from, to, {
    point(from, to, label, active) {
      if (label instanceof Widget) walker.widget(label, active as Decoration[])
      pos = pos.advance(to - from)
    },
    fragment(from, to, local) {
      active = local as Decoration[]
      pos = pos.walk(to - from, wrap)
    }
  })
}
