import {EditorView} from "./editorview"
import {Span, SpanLabel, SpanSet} from "@willows/state"
import {Pos, Node, Tag, Walker} from "@willows/doc"

// FIXME define event handling and update mechanisms

export abstract class WidgetDecoration extends SpanLabel {
  abstract render(view: EditorView): HTMLElement

  get side() { return -1 }

  get startSide() { return this.side }
  get endSide() { return this.side }
  get point() { return true }
  get rank() { return 0 }

  at(pos: number) { return Span.create(pos, pos, this) }
}

export class InlineDecoration extends SpanLabel {
  attributes: Record<string, string> | undefined
  element: string | undefined
  private _rank: number

  constructor(spec: {
    attributes?: Record<string, string>,
    element?: string,
    rank?: number
  }) {
    super()
    this.attributes = spec.attributes
    this.element = spec.element
    this._rank = Math.max(0, Math.min(100, spec.rank ?? 100))
  }

  range(from: number, to: number) { return Span.create(from, to, this) }

  get spanning() { return true }

  get rank() { return this._rank }
}

export type Decoration = InlineDecoration | WidgetDecoration

export type LocalDecoration = InlineDecoration // FIXME name?

export type DecorationSet = SpanSet<Decoration>

export interface DecoWalker {
  skip(node: Node, deco: readonly LocalDecoration[]): void
  enter(tag: Tag, deco: readonly LocalDecoration[]): void | boolean
  leave(): void
  widget(widget: WidgetDecoration, deco: readonly LocalDecoration[]): void
}

export function iterateDeco(pos: Pos, deco: readonly DecorationSet[], from: number, to: number, walker: DecoWalker) {
  let active: readonly LocalDecoration[] = []
  let wrap: Walker = {
    skip(node) { walker.skip(node, active) },
    enter(tag) { walker.enter(tag, active) },
    leave() { walker.leave() }
  }
  SpanSet.fragments(deco, from, to, {
    point(from, to, label, active) {
      if (label instanceof WidgetDecoration) walker.widget(label, active as LocalDecoration[])
      pos = pos.advance(to - from)
    },
    fragment(from, to, local) {
      active = local as LocalDecoration[]
      pos = pos.walk(to - from, wrap)
    }
  })
}
