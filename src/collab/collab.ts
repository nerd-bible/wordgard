import {GardState, Transaction} from "wordgard/state"
import {ChangeSet, Plot} from "wordgard/doc"

// FIXME look into server-side merging again

class LocalUpdate {
  constructor(
    readonly changes: ChangeSet,
    readonly effects: readonly Transaction.Effect<unknown>[],
  ) {}
}

class CollabState {
  constructor(
    // The version up to which changes have been confirmed.
    readonly version: number,
    // The document at version `this.version`.
    readonly syncedDoc: Plot.Doc,
    // The local updates that havent been successfully sent to the
    // server yet.
    readonly unconfirmed: readonly LocalUpdate[],
  ) {}
}

const collabConfig = GardState.Facet.define<collab.Config & {generatedID: string}, Required<collab.Config>>({
  combine(configs) {
    let combined = GardState.Facet.combineConfig(configs, {startVersion: 0, clientID: null as any, sharedEffects: () => []}, {
      generatedID: a => a
    })
    if (combined.clientID == null) combined.clientID = (configs.length && configs[0].generatedID) || ""
    return combined
  }
})

const collabReceive = Transaction.Effect.define<CollabState>({
  map(state, changes) {
    // This is used to make sure changes added to collab receive
    // transactions by extenders still get stored as unconfirmed.
    return changes.empty ? state
      : new CollabState(state.version, state.syncedDoc, state.unconfirmed.concat(new LocalUpdate(changes, [])))
  }
})

const collabField = GardState.Field.define({
  create(state) {
    return new CollabState(state.facet(collabConfig).startVersion, state.doc, [])
  },

  update(collab: CollabState, tr: Transaction) {
    for (let e of tr.effects) if (e.is(collabReceive)) return e.value
    let {sharedEffects} = tr.startState.facet(collabConfig)
    let effects = sharedEffects(tr)
    if (effects.length || !tr.changes.empty)
      return new CollabState(collab.version, collab.syncedDoc, collab.unconfirmed.concat(new LocalUpdate(tr.changes, effects)))
    return collab
  }
})

/// Create an instance of the collaborative editing plugin.
export function collab(config: collab.Config = {}): GardState.Extension {
  return [collabField, collabConfig.of({generatedID: Math.floor(Math.random() * 1e9).toString(36), ...config})]
}

function collapseUpdates(updates: readonly {changes: ChangeSet, effects?: readonly Transaction.Effect<unknown>[]}[]) {
  let {changes, effects = []} = updates[0]
  for (let i = 1; i < updates.length; i++) {
    let next = updates[i]
    effects = Transaction.Effect.mapEffects(effects, next.changes)
    if (next.effects) effects = effects.concat(next.effects)
    changes = changes.compose(next.changes)
  }
  return {changes, effects}
}

export namespace collab {
  export type Config = {
    /// The starting document version. Defaults to 0.
    startVersion?: number,
    /// This client's identifying {@link collab.getClientID ID}. Will be a
    /// randomly generated string if not provided.
    clientID?: string,
    /// It is possible to share information other than document changes
    /// through this extension. If you provide this option, your
    /// function will be called on each transaction, and the effects it
    /// returns will be sent to the server, much like changes are. Such
    /// effects are automatically remapped when conflicting remote
    /// changes come in.
    sharedEffects?: (tr: Transaction) => readonly Transaction.Effect<any>[]
  }

  /// An update is a set of changes and effects.
  export interface Update {
    /// The document version that this update starts from.
    versionBefore: number,
    /// The new version, as determined by the client creating the
    /// update.
    versionAfter: number,
    /// The changes made by this update.
    changes: ChangeSet,
    /// The effects in this update. There'll only ever be effects here
    /// when you configure your collab extension with a {@link
    /// collab.Config.sharedEffects `sharedEffects`} option.
    effects?: readonly Transaction.Effect<unknown>[]
    /// The {@link collab.Config.clientID ID} of the client who
    /// created this update.
    clientID: string
  }

  /// Create a transaction that represents a set of new updates received
  /// from the authority. Applying this transaction moves the state
  /// forward to, for remote changes, integrate them into our local
  /// state, and for our own changes, drop them from the set of
  /// unconfirmed local changes.
  export function receive(state: GardState, updates: readonly collab.Update[]) {
    let {version, syncedDoc, unconfirmed} = state.field(collabField)
    let {clientID} = state.facet(collabConfig)

    for (let {versionBefore, versionAfter} of updates) {
      if (versionBefore != version) throw new Error("Version mismatchin in received collab update")
      version = versionAfter
    }

    if (updates.length && updates[0].clientID == clientID) {
      // First update is our own
      let ours = updates[0], size = ours.versionAfter - ours.versionBefore
      unconfirmed = unconfirmed.slice(size)
      updates = updates.slice(1)
      syncedDoc = unconfirmed.length ? ours.changes.apply(syncedDoc) : state.doc
    }

    if (!updates.length) return state.update({
      annotations: Transaction.remote.of(true),
      effects: collabReceive.of(new CollabState(version, syncedDoc, unconfirmed))
    })

    let {changes, effects} = collapseUpdates(updates)
    let newSyncedDoc = changes.apply(syncedDoc)
    if (unconfirmed.length) {
      let ours = collapseUpdates(unconfirmed)
      let oursMapped = new LocalUpdate(ours.changes.map(changes, syncedDoc, false),
                                       Transaction.Effect.mapEffects(ours.effects, changes))
      unconfirmed = [oursMapped]
      changes = changes.map(ours.changes, syncedDoc, true)
      effects = Transaction.Effect.mapEffects(effects, oursMapped.changes)
    }
    syncedDoc = newSyncedDoc

    return state.update({
      changes,
      effects: effects.concat(collabReceive.of(new CollabState(version, syncedDoc, unconfirmed))),
      annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
    })
  }

  /// If there are unconfirmed local changes that need to be sent to the
  /// server,return them as an `Update` object.
  export function sendableUpdate(state: GardState): collab.Update | null {
    let {unconfirmed, version} = state.field(collabField)
    if (!unconfirmed.length) return null
    let {changes, effects} = collapseUpdates(unconfirmed)
    return {
      versionBefore: version,
      versionAfter: version + unconfirmed.length,
      changes, effects,
      clientID: state.facet(collabConfig).clientID
    }
  }

  /// Get the version up to which the collab plugin has synced with the
  /// central authority.
  export function getSyncedVersion(state: GardState) {
    return state.field(collabField).version
  }

  /// Get this editor's collaborative editing client ID.
  export function getClientID(state: GardState) {
    return state.facet(collabConfig).clientID
  }
}
