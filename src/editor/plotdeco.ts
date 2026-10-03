import {Plot, Node} from "wordgard/doc"
import {GardState, Transaction} from "wordgard/state"
import {RangeSet} from "wordgard/set"
import {Decoration} from "./decoration"

function offset(
  add: (from: number, to: number, value: Decoration.Range) => void,
  offset: number
): (from: number, to: number, value: Decoration.Range) => void {
  return (from, to, v) => add(from + offset, to + offset, v)
}

function init(config: Config, doc: Plot.Doc) {
  return Decoration.Range.set(add => {
    doc.iterate((node, pos) => {
      if (node.isPlot && doc.schema.matchNode(node.type, config.type))
        config.decorations(node as Plot, offset(add, pos + 1))
    })
  })
}

function refreshByPred(config: Config, doc: Plot.Doc, deco: Decoration.Range.Set, pred: (plot: Plot) => boolean) {
  let recreate: RangeSet.Replacement<Decoration.Range>[] = []
  return Decoration.Range.set(add => {
    doc.iterate((node, pos) => {
      if (doc.schema.matchNode(node.type, config.type) && pred(node as Plot)) recreate.push({
        from: pos, to: pos + node.length,
        add: add => config.decorations(node as Plot, offset(add, pos + 1))
      })
    })
  })
  return recreate.length ? deco.modify({replace: recreate}) : deco
}

function update(config: Config, deco: Decoration.Range.Set, tr: Transaction) {
  let doc = tr.newDoc
  let refresh = config.refresh && config.refresh(tr)
  if (refresh === true) return init(config, doc)
  if (refresh) deco = refreshByPred(config, tr.startState.doc, deco, refresh)
  if (!tr.docChanged && !refresh) return deco
  let recreate: RangeSet.Replacement<Decoration.Range>[] = []
  let clear: RangeSet.Replacement<Decoration.Range>[] = []
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    let covered = false
    doc.iterate(fromB, toB, (node, pos) => {
      if (doc.schema.matchNode(node.type, config.type)) {
        recreate.push({
          from: pos, to: pos + node.length,
          add: add => config.decorations(node as Plot, offset(add, pos + 1))
        })
        if (pos < toB && pos + node.length > toB) covered = true
        return false
      }
    })
    if (!covered) {
      let end = tr.startState.doc.resolve(toA)
      let open = end.matchingParent(p => doc.schema.matchNode(p.type, config.type))
      if (open && open.before >= fromA) clear.push({from: open.before, to: open.after})
    }
  })
  if (clear.length) deco = deco.modify({replace: clear})
  deco = deco.map(tr.changes, recreate)
  return deco
}

type Config = {
  /// The type of plot to decorate.
  type: Node.Query,
  /// A function that produces decorations for a plot. `from` and `to`
  /// should be relative to the start of the plot's content, and be
  /// fall entirely within the plot.
  decorations: (node: Plot, add: (from: number, to: number, deco: Decoration.Range) => void) => void
  /// An optional function that causes the decorations to be recreated
  /// on matching transaction, either for the entire document (`true`)
  /// or for any plot where the returned predicate returns `true`.
  refresh?: (tr: Transaction) => boolean | ((plot: Plot) => boolean)
}

/// Create an extension that adds decorations to plots matching the
/// given type.
 export function decoratePlots(config: Config): GardState.Extension {
  let field = GardState.Field.define<Decoration.Range.Set>({
    create(state) { return init(config, state.doc) },
    update(value, tr) { return update(config, value, tr) }
  })
  return [
    field,
    Decoration.Range.source.of(s => s.field(field))
  ]
}
