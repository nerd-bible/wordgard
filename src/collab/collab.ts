import {Facet, Annotation, EditorState, StateEffect, Transaction} from "wordgard/state"
import {ChangeSet, Plot} from "wordgard/doc"

/// An update is a set of changes and effects.
export interface Update {
  versionBefore: number,
  versionAfter: number,
  /// The changes made by this update.
  changes: ChangeSet,
  /// The effects in this update. There'll only ever be effects here
  /// when you configure your collab extension with a
  /// [`sharedEffects`](#collab.collab^config.sharedEffects) option.
  effects?: readonly StateEffect<unknown>[]
  /// The [ID](#collab.collab^config.clientID) of the client who
  /// created this update.
  clientID: string
}

class LocalUpdate {
  constructor(
    readonly changes: ChangeSet,
    readonly effects: readonly StateEffect<unknown>[],
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

type CollabConfig = {
  /// The starting document version. Defaults to 0.
  startVersion?: number,
  /// This client's identifying [ID](#collab.getClientID). Will be a
  /// randomly generated string if not provided.
  clientID?: string,
  /// It is possible to share information other than document changes
  /// through this extension. If you provide this option, your
  /// function will be called on each transaction, and the effects it
  /// returns will be sent to the server, much like changes are. Such
  /// effects are automatically remapped when conflicting remote
  /// changes come in.
  sharedEffects?: (tr: Transaction) => readonly StateEffect<any>[]
}

const collabConfig = Facet.define<CollabConfig & {generatedID: string}, Required<CollabConfig>>({
  combine(configs) {
    let combined = Facet.combineConfig(configs, {startVersion: 0, clientID: null as any, sharedEffects: () => []}, {
      generatedID: a => a
    })
    if (combined.clientID == null) combined.clientID = (configs.length && configs[0].generatedID) || ""
    return combined
  }
})

const collabReceive = Annotation.define<CollabState>()

const collabField = EditorState.Field.define({
  create(state) {
    return new CollabState(state.facet(collabConfig).startVersion, state.doc, [])
  },

  update(collab: CollabState, tr: Transaction) {
    let isSync = tr.annotation(collabReceive)
    if (isSync) return isSync
    let {sharedEffects} = tr.startState.facet(collabConfig)
    let effects = sharedEffects(tr)
    if (effects.length || !tr.changes.empty)
      return new CollabState(collab.version, collab.syncedDoc, collab.unconfirmed.concat(new LocalUpdate(tr.changes, effects)))
    return collab
  }
})

/// Create an instance of the collaborative editing plugin.
export function collab(config: CollabConfig = {}): EditorState.Extension {
  return [collabField, collabConfig.of({generatedID: Math.floor(Math.random() * 1e9).toString(36), ...config})]
}

function collapseUpdates(updates: readonly {changes: ChangeSet, effects?: readonly StateEffect<unknown>[]}[]) {
  let {changes, effects = []} = updates[0]
  for (let i = 1; i < updates.length; i++) {
    let next = updates[i]
    effects = StateEffect.mapEffects(effects, next.changes)
    if (next.effects) effects = effects.concat(next.effects)
    changes = changes.compose(next.changes)
  }
  return {changes, effects}
}

/// Create a transaction that represents a set of new updates received
/// from the authority. Applying this transaction moves the state
/// forward to, for remote changes, integrate them into our local
/// state, and for our own changes, drop them from the set of
/// unconfirmed local changes.
export function receiveUpdates(state: EditorState, updates: readonly Update[]) {
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
    annotations: [
      Transaction.remote.of(true),
      collabReceive.of(new CollabState(version, syncedDoc, unconfirmed))
    ],
    filter: false
  })

  let {changes, effects} = collapseUpdates(updates)
  let newSyncedDoc = changes.apply(syncedDoc)
  if (unconfirmed.length) {
    let ours = collapseUpdates(unconfirmed)
    let oursMapped = new LocalUpdate(ours.changes.map(changes, syncedDoc, false),
                                     StateEffect.mapEffects(ours.effects, changes))
    unconfirmed = [oursMapped]
    changes = changes.map(ours.changes, syncedDoc, true)
    effects = StateEffect.mapEffects(effects, oursMapped.changes)
  }
  syncedDoc = newSyncedDoc

  return state.update({
    changes,
    effects,
    annotations: [
      Transaction.addToHistory.of(false),
      Transaction.remote.of(true),
      collabReceive.of(new CollabState(version, syncedDoc, unconfirmed))
    ],
    filter: false
  })
}

/// If there are unconfirmed local changes that need to be sent to the
/// server,return them as an `Update` object.
export function sendableUpdate(state: EditorState): Update | null {
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
export function getSyncedVersion(state: EditorState) {
  return state.field(collabField).version
}

/// Get this editor's collaborative editing client ID.
export function getClientID(state: EditorState) {
  return state.facet(collabConfig).clientID
}
