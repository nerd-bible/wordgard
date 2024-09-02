import {DocNode, ChangeDesc} from "@willows/doc"

export class EditorSelection {
  // FIXME
  map(changes: ChangeDesc) { return this }

  static fromJSON(json: any) { return new EditorSelection }

  static between(anchor: number, head?: number) { return new EditorSelection }

  static atStart(doc: DocNode) { return new EditorSelection }

  toJSON() { return {} }

  /// @internal
  check(doc: DocNode) {}
}
