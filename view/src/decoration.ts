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

  at(pos: number) { return Span.create(pos, pos, this) }
}

export class InlineDecoration extends SpanLabel {
  constructor(readonly attributes: Record<string, string>, readonly element?: string) {
    super()
  }

  range(from: number, to: number) { return Span.create(from, to, this) }
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
    span(from, to, local) {
      console.log("got span", from, to)
      active = local as LocalDecoration[]
      pos.walk(to - from, wrap)
    }
  })
}
