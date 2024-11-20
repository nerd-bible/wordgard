import {EditorView} from "./editorview"
import {Span, SpanLabel, SpanSet} from "@willows/state"

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

export type DecorationSet = SpanSet<Decoration>
