import {GardState, Transaction, Facet, GardSelection} from "wordgard/state"
import {Plot, ChangeSet} from "wordgard/doc"
import {Command, undo as undoCmd, redo as redoCmd} from "wordgard/command"

const enum BranchName { Done, Undone }

const fromHistory = Transaction.Annotation.define<{side: BranchName, rest: Branch | null, selection: GardSelection}>()

/// Transaction annotation that will prevent that transaction from
/// being combined with other transactions in the undo history. Given
/// `"before"`, it'll prevent merging with previous transactions. With
/// `"after"`, subsequent transactions won't be combined with this
/// one. With `"full"`, the transaction is isolated on both sides.
export const isolateHistory = Transaction.Annotation.define<"before" | "after" | "full">()

/// This facet provides a way to register functions that, given a
/// transaction, provide a set of effects that the history should
/// store when inverting the transaction. This can be used to
/// integrate specific effects in the history, so that they can be
/// undone (and redone again).
export const invertedEffects = Facet.define<(tr: Transaction) => readonly Transaction.Effect<any>[]>()

interface HistoryConfig {
  /// The minimum depth (amount of events) to store. Defaults to 100.
  minDepth?: number
  /// The maximum time (in milliseconds) that adjacent events can be
  /// apart and still be grouped together. Defaults to 500.
  newGroupDelay?: number
  /// By default, when close enough together in time, changes are
  /// joined into an existing undo event if they touch any of the
  /// changed ranges from that event. You can pass a custom predicate
  /// here to influence that logic.
  joinToEvent?: (tr: Transaction, isAdjacent: boolean) => boolean
}

const historyConfig = Facet.define<HistoryConfig, Required<HistoryConfig>>({
  combine(configs) {
    return Facet.combineConfig(configs, {
      minDepth: 100,
      newGroupDelay: 500,
      joinToEvent: (_t, isAdjacent) => isAdjacent,
    }, {
      minDepth: Math.max,
      newGroupDelay: Math.min,
      joinToEvent: (a, b) => (tr, adj) => a(tr, adj) || b(tr, adj)
    })
  }
})

const historyField_ = GardState.Field.define({
  create() {
    return new HistoryState(null, null)
  },

  update(state: HistoryState, tr: Transaction): HistoryState {
    let config = tr.state.facet(historyConfig)

    let fromHist = tr.annotation(fromHistory)
    if (fromHist) {
      let from = fromHist.side, event = eventFromTransaction(tr)
      let other = from == BranchName.Done ? state.undone : state.done
      if (event) other = new Branch(event.changes, event.effects, null, fromHist.selection, other)
      return new HistoryState(from == BranchName.Done ? fromHist.rest : other,
                              from == BranchName.Done ? other : fromHist.rest)
    }

    let isolate = tr.annotation(isolateHistory)
    if (isolate == "full" || isolate == "before") state = state.isolate()

    if (tr.annotation(Transaction.addToHistory) === false)
      return tr.changes.empty ? state : new HistoryState(
        state.done && state.done.addMapping(tr.changes, tr.startState.doc),
        state.undone && state.undone.addMapping(tr.changes, tr.startState.doc),
        state.prevTime, state.prevUserEvent)

    let event = eventFromTransaction(tr)
    let time = tr.annotation(Transaction.time)!, userEvent = tr.annotation(Transaction.userEvent)
    if (event) state = state.addChanges(event, time, userEvent, config, tr)

    if (isolate == "full" || isolate == "after") state = state.isolate()
    return state.clip(config.minDepth)
  },

  toJSON(value) {
    let mkJSON = (value: Branch | null) => {
      let events: {changes: ChangeSet.JSON, selection: GardSelection.JSON}[] = []
      for (let cur = value; cur; cur = cur.next)
        events.push({changes: cur.changes.toJSON(), selection: cur.startSelection.toJSON()})
      return events
    }
    return {
      done: mkJSON(value.done = value.done && value.done.resolveFully()),
      undone: mkJSON(value.undone = value.undone && value.undone.resolveFully())
    }
  },

  fromJSON(json: any, state: GardState) {
    if (!json || !Array.isArray(json.done) || !Array.isArray(json.undone)) throw new RangeError("Invalid history JSON")
    let buildBranch = (json: {changes: ChangeSet.JSON, selection: GardSelection.JSON}[]) => {
      let result: Branch | null = null
      for (let i = json.length - 1; i >= 0; i--)
        result = new Branch(ChangeSet.fromJSON(state.doc.schema, json[i].changes),
                                none, null, GardSelection.fromJSON(state.doc.schema, json[i].selection), result)
                                
      return result
    }
    return new HistoryState(buildBranch(json.done), buildBranch(json.undone))
  }
})

/// Create a history extension with the given configuration.
export function history(config: HistoryConfig = {}): GardState.Extension {
  return [
    historyField_,
    historyConfig.of(config),
    Command.handler(undoCmd, view => undo(view.state)),
    Command.handler(redoCmd, view => redo(view.state))
  ]
}

/// The state field used to store the history data. Should probably
/// only be used when you want to
/// [serialize](#state.GardState.toJSON) or
/// [deserialize](#state.GardState^fromJSON) state objects in a way
/// that preserves history.
export const historyField = historyField_ as GardState.Field<unknown>

/// Undo a single group of history events. Returns false if no group
/// is available. Note that transaction specs produced with this
/// function should be dispatched as-is, and not combined with further
/// changes.
export function undo(state: GardState) {
  let historyState = state.field(historyField_, false)
  if (state.readOnly || !historyState) return false
  return historyState.pop(BranchName.Done, state)
}

/// Redo a single group of undone history events. Returns false if no
/// group is available. Transaction specs produced with this
/// function should be dispatched as-is.
export function redo(state: GardState) {
  let historyState = state.field(historyField_, false)
  if (state.readOnly || !historyState) return false
  return historyState.pop(BranchName.Undone, state)
}

function depth(branch: Branch | null | undefined) {
  return branch ? branch.depth : 0
}

/// The amount of undoable change events available in a given state.
export const undoDepth = (state: GardState) => depth(state.field(historyField_, false)?.done)
  
/// The amount of redoable change events available in a given state.
export const redoDepth = (state: GardState) => depth(state.field(historyField_, false)?.undone)

export type HistEventJSON = {
  changes: ChangeSet.JSON,
  mapped?: ChangeSet.JSON,
  startSelection: GardSelection.JSON
}

// History branch events store groups of changes or effects that need
// to be undone/redone together. They form a linked list.
class Branch {
  depth: number
  
  constructor(
    // The changes in this event. It will hold at least one
    // change or effect.
    readonly changes: ChangeSet,
    // The effects associated with this event
    readonly effects: readonly Transaction.Effect<any>[],
    // Accumulated mapping (from addToHistory==false) that should be
    // applied to this event and those below. `doc` refers to the doc
    // that doesn't have this change yet, which is both the start doc
    // for the mapping change and `this.changes`, which is needed to
    // be able to perform further mapping on these.
    readonly mapped: {change: ChangeSet, doc: Plot.Doc} | null,
    // The selection before this event
    readonly startSelection: GardSelection,
    readonly next: Branch | null
  ) {
    this.depth = depth(next) + 1
  }

  // Assumes `this` is already resolved
  addChanges(changes: ChangeSet, effects: readonly Transaction.Effect<any>[]) {
    return new Branch(changes.compose(this.changes),
                          conc(Transaction.Effect.mapEffects(effects, this.changes), this.effects),
                          null, this.startSelection, this.next)
  }

  // Resolve this event's mapping, if any.
  resolve(): Branch | null {
    if (!this.mapped) return this
    let {mapped: {change, doc}, next} = this
    // Map the event's changes and mapped.change (which both start
    // from mapped.doc) over each other
    let mappedChanges = this.changes.map(change, doc), mappedMapping = change.map(this.changes, doc, true)
    // If there's more events below this, push the updated mapping down
    if (next) next = next.addMapping(mappedMapping, next.mapped ? null : this.changes.apply(doc))
    // If there's nothing left in this event, return the next one
    if (mappedChanges.empty && !this.effects.length) return next && next.resolve()
    // Map the effects over the original mapping, and the selection
    // (referring to the state before this event's changes) over the
    // updated mapping.
    return new Branch(mappedChanges, Transaction.Effect.mapEffects(this.effects, change), null,
                      this.startSelection.map(mappedMapping), next)
  }

  // When serializing to JSON, we first fully resolve the whole history.
  resolveFully(): Branch | null {
    let stack: Branch[] = []
    for (let head: Branch | null = this; head; head = head.next) {
      head = head.resolve()
      if (!head) break
      stack.push(head)
    }
    let result: Branch | null = null
    for (let i = stack.length - 1; i >= 0; i--) {
      let next = stack[i]
      if (next.next == result) result = next
      else result = new Branch(next.changes, next.effects, null, next.startSelection, result)
    }
    return result
  }

  // Add a mapping to this change
  addMapping(change: ChangeSet, startDoc: Plot.Doc | null) {
    return new Branch(this.changes, this.effects, this.mapped
      ? {change: this.mapped.change.compose(change), doc: this.mapped.doc}
      : {change, doc: startDoc!}, this.startSelection, this.next)
  }

  // Drop any events below the given depth
  clip(depth: number) {
    let stack: Branch[] = []
    for (let i = 0, cur: Branch | null = this; i < depth && cur; i++, cur = cur.next) stack.push(cur)
    let result = null
    for (let i = stack.length - 1; i >= 0; i--) {
      let event = stack[i]
      result = new Branch(event.changes, event.effects, event.mapped, event.startSelection, result)
    }
    return result
  }
}

function eventFromTransaction(tr: Transaction): {
  changes: ChangeSet,
  effects: readonly Transaction.Effect<any>[]
} | null {
  let effects: readonly Transaction.Effect<any>[] = none
  for (let invert of tr.startState.facet(invertedEffects)) {
    let result = invert(tr)
    if (result.length) effects = effects.concat(result)
  }
  if (!effects.length && tr.changes.empty) return null
  return {changes: tr.changes.invert(tr.startState.doc), effects}
}

// Check whether two change sets touch each other. The
// suspicious-looking use of before-positions in a and after-positions
// in b is because these will be inverted change sets.
function isAdjacent(a: ChangeSet, b: ChangeSet): boolean {
  let ranges: number[] = [], isAdjacent = false
  a.iterChangedRanges((f, t) => ranges.push(f, t))
  b.iterChangedRanges((_f, _t, f, t) => {
    for (let i = 0; i < ranges.length;) {
      let from = ranges[i++], to = ranges[i++]
      if (t >= from && f <= to) isAdjacent = true
    }
  })
  return isAdjacent
}

function conc<T>(a: readonly T[], b: readonly T[]) {
  return !a.length ? b : !b.length ? a : a.concat(b)
}

const none: readonly any[] = []

const joinableUserEvent = /^(input\.type|delete)($|\.)/

class HistoryState {
  constructor(
    // These are only mutated when resolving in toJSON
    // The branch of undoable changes
    public done: Branch | null,
    // The branch of redoable changes
    public undone: Branch | null,
    // The time at which the last done event was created, or 0 if
    // nothing should be joined to it
    readonly prevTime: number = 0,
    // The user event that was last added to this.done
    readonly prevUserEvent: string | undefined = undefined
  ) {}

  isolate() {
    return this.prevTime ? new HistoryState(this.done, this.undone) : this
  }

  addChanges(event: {changes: ChangeSet, effects: readonly Transaction.Effect<any>[]},
             time: number, userEvent: string | undefined,
             config: Required<HistoryConfig>, tr: Transaction): HistoryState {
    // Make sure the top of the done branch is resolved, so that we
    // can add changes without worrying about its mapping
    let done = this.done && this.done.resolve()
    // If possible, add the changes to the top event, otherwise start
    // a new event
    if (done && !done.changes.empty &&
        (!userEvent || joinableUserEvent.test(userEvent)) &&
        ((time - this.prevTime < config.newGroupDelay &&
          config.joinToEvent(tr, isAdjacent(done.changes, event.changes))) ||
         // For compose (but not compose.start) events, always join with previous event
         userEvent == "input.type.compose")) {
      done = done.addChanges(event.changes, event.effects)
    } else {
      done = new Branch(event.changes, event.effects, null, tr.startState.selection, done)
    }
    return new HistoryState(done, null, time, userEvent)
  }

  pop(side: BranchName, state: GardState): Transaction.Spec | false {
    let branch = side == BranchName.Done ? this.done : this.undone
    if (!branch || !(branch = branch.resolve())) return false
    return {
      changes: branch.changes,
      selection: branch.startSelection,
      effects: branch.effects,
      annotations: fromHistory.of({side, rest: branch.next, selection: state.selection}),
      filter: false,
      userEvent: side == BranchName.Done ? "undo" : "redo",
      scrollIntoView: true
    }
  }

  clip(minDepth: number) {
    let max = minDepth * 1.3
    let done = depth(this.done) > max ? this.done!.clip(minDepth) : this.done
    let undone = depth(this.undone) > max ? this.undone!.clip(minDepth) : this.undone
    if (done != this.done || undone != this.undone) return new HistoryState(done, undone, this.prevTime, this.prevUserEvent)
    return this
  }
}
