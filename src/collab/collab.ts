import {GardState, Transaction} from "wordgard/state"
import {ChangeSet, Plot, Node} from "wordgard/doc"

class LocalUpdate {
  constructor(
    readonly changes: ChangeSet,
    readonly effects: readonly Transaction.Effect<unknown>[],
  ) {}
}

function addUpdate(to: LocalUpdate | null, changes: ChangeSet, effects: readonly Transaction.Effect<unknown>[] = []) {
  if (changes.empty && !effects.length) return to
  if (!to) return new LocalUpdate(changes, effects)
  return new LocalUpdate(to.changes.compose(changes),
                         Transaction.Effect.mapEffects(to.effects, changes).concat(effects))
}

class CollabState {
  constructor(
    // The version up to which changes have been confirmed.
    readonly version: number,
    // The document at version `this.version`.
    readonly syncedDoc: Plot.Doc,
    // A set of local unconfirmed changes that may have been sent to
    // the server. Because we cannot compose these with other changes
    // anymore once they may have been sent, reading these with
    // `sendableUpdate` will, via a side effect, lock them.
    public nextUpdate: LocalUpdate | null,
    // Local unconfirmed changes that have not been locked yet. New
    // transactions will be added to this.
    public openUpdate: LocalUpdate | null
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
      : new CollabState(state.version, state.syncedDoc, state.nextUpdate, addUpdate(state.openUpdate, changes))
  }
})

const collabField = GardState.Field.define({
  create(state) {
    return new CollabState(state.facet(collabConfig).startVersion, state.doc, null, null)
  },

  update(collab: CollabState, tr: Transaction) {
    for (let e of tr.effects) if (e.is(collabReceive)) return e.value
    let {sharedEffects} = tr.startState.facet(collabConfig)
    let effects = sharedEffects(tr)
    if (effects.length || !tr.changes.empty)
      return new CollabState(collab.version, collab.syncedDoc, collab.nextUpdate,
                             addUpdate(collab.openUpdate, tr.changes, effects))
    return collab
  }
})

/// Create an instance of the collaborative editing plugin.
export function collab(config: collab.Config = {}): GardState.Extension {
  return [collabField, collabConfig.of({generatedID: Math.floor(Math.random() * 1e9).toString(36), ...config})]
}

export namespace collab {
  /// Options to {@link collab}.
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
    version: number
    /// The {@link collab.Config.clientID ID} of the client who
    /// created this update.
    clientID: string
    /// The changes made by this update.
    changes: ChangeSet
    /// The effects in this update. There'll only ever be effects here
    /// when you configure your collab extension with a {@link
    /// collab.Config.sharedEffects `sharedEffects`} option.
    effects?: readonly Transaction.Effect<unknown>[]
  }

  /// Create a transaction that represents a set of new updates received
  /// from the authority. Applying this transaction moves the state
  /// forward to, for remote changes, integrate them into our local
  /// state, and for our own changes, drop them from the set of
  /// unconfirmed local changes.
  export function receive(state: GardState, updates: readonly collab.Update[]) {
    let {version, syncedDoc, nextUpdate, openUpdate} = state.field(collabField)
    let {clientID} = state.facet(collabConfig)

    let changes = ChangeSet.empty(state.doc.length)
    let effects: readonly Transaction.Effect<unknown>[] = []

    for (let update of updates) {
      if (update.version != version)
        throw new Error("Version mismatch in in received collab update")
      if (update.clientID == clientID) {
        if (!nextUpdate || !nextUpdate.changes.eq(update.changes))
          throw new Error("Received update with our client ID doesn't match our own local update")
        nextUpdate = null
        syncedDoc = openUpdate ? update.changes.apply(syncedDoc) : state.doc
      } else {
        let newChanges = update.changes, newEffects = update.effects || []
        let baseDoc = syncedDoc
        if (nextUpdate) {
          let {a, b} = ChangeSet.transform(baseDoc, newChanges, nextUpdate.changes)
          if (openUpdate) baseDoc = nextUpdate.changes.apply(baseDoc)
          nextUpdate = new LocalUpdate(b, Transaction.Effect.mapEffects(nextUpdate.effects, a))
          newChanges = a
          newEffects = Transaction.Effect.mapEffects(newEffects, b)
        }
        if (openUpdate) {
          let {a, b} = ChangeSet.transform(baseDoc, newChanges, openUpdate.changes)
          openUpdate = new LocalUpdate(b, Transaction.Effect.mapEffects(openUpdate.effects, a))
          newChanges = a
          newEffects = Transaction.Effect.mapEffects(newEffects, b)
        }
        changes = changes.compose(newChanges)
        effects = Transaction.Effect.mapEffects(effects, newChanges).concat(newEffects)
        syncedDoc = update.changes.apply(syncedDoc)
      }
      version++
    }

    return state.update({
      changes,
      effects: effects.concat(collabReceive.of(new CollabState(version, syncedDoc, nextUpdate, openUpdate))),
      annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
    })
  }

  /// If there are unconfirmed local changes that need to be sent to the
  /// server,return them as an `Update` object.
  export function sendableUpdate(state: GardState): collab.Update | null {
    let collab = state.field(collabField)
    if (!collab.nextUpdate) {
      if (!collab.openUpdate) return null
      collab.nextUpdate = collab.openUpdate
      collab.openUpdate = null
    }
    return {
      version: collab.version,
      clientID: getClientID(state),
      changes: collab.nextUpdate.changes,
      effects: collab.nextUpdate.effects
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

  /// Transform an update that arrives on the server with an outdated
  /// start version. Being able to do this requires tracking a
  /// document history server-side. It is not necessary to do this,
  /// but it helps a lot with “starvation” problems, where slower
  /// clients or clients with a high ping can, in a busy document,
  /// keep losing the race to submit their changes to other, faster
  /// clients.
  export function transformUpdate(
    update: collab.Update,
    over: readonly {doc: Plot.Doc, changes: ChangeSet, clientID: string}[]
  ): collab.Update | null {
    if (!over.length) return update
    let {clientID, version, changes, effects} = update
    for (let other of over) {
      if (other.clientID == clientID) return null
      if (effects && effects.length)
        effects = Transaction.Effect.mapEffects(effects, other.changes.transform(other.doc, changes, true))
      changes = changes.transform(other.doc, other.changes)
      version++
    }
    return {clientID, version, changes, effects}
  }
}

/// An object of this type should be used to wrap whatever transport
/// layer you use to talk to your language server. Messages should
/// contain only the JSON messages, no LSP headers.
export type Socket = {
  /// Send a message over the transport.
  send(message: string): void
  /// If set to a function, call that function when a message comes
  /// in.
  onmessage: ((ev: {data: string}) => void) | null
  /// If a function, call that function when the socket is closed.
  onclose: (() => void) | null
}

function isNatNum(n: any): n is number {
  return typeof n == "number" && Math.floor(n) == n && n >= 0
}

export class Server<EffectJSON = any> {
  clients: {id: string, socket: Socket}[] = []

  constructor(
    public doc: Plot.Doc,
    public version: number,
    public updates: Server.Update[],
    readonly serializeEffect: ((effect: Transaction.Effect<unknown>) => EffectJSON | null) | undefined,
    readonly deserializeEffect: ((json: EffectJSON, doc: Plot.Doc) => Transaction.Effect<unknown>) | undefined
  ) {
  }

  static create<EffectJSON = unknown>(config: {
    doc: Plot.Doc,
    version?: number,
    updates?: Server.Update[],
    serializeEffect?: (effect: Transaction.Effect<unknown>) => EffectJSON | null,
    deserializeEffect?: (json: EffectJSON) => Transaction.Effect<unknown>
  }) {
    return new Server(config.doc, config.version ?? 0, config.updates ?? [],
                      config.serializeEffect, config.deserializeEffect)
  }

  get startVersion() {
    return this.version - this.updates.length
  }

  connect(socket: Socket) {
    let client = {id: "", socket}
    socket.onmessage = this.onMessage.bind(this, client)
    socket.onclose = this.dropClient.bind(this, client)
    this.clients.push(client)
    socket.send(JSON.stringify({type: "connected"}))
  }

  send(client: {id: string, socket: Socket}, message: Server.Message<EffectJSON>) {
    try {
      client.socket.send(JSON.stringify(message))
    } catch {
      this.dropClient(client)
    }
  }

  sendUpdate(client: {id: string, socket: Socket}, update: Server.Update) {
    let effects: EffectJSON[] | undefined
    if (update.effects && this.serializeEffect) {
      for (let e of update.effects) {
        let json = this.serializeEffect(e)
        if (json) (effects || (effects = [])).push(json)
      }
    }
    this.send(client, {
      type: "update",
      changes: update.changes.toJSON(),
      effects,
      clientID: update.clientID
    })
  }

  onMessage(client: {id: string, socket: Socket}, message: {data: string}) {
    let err = (error: string) => client.socket.send(JSON.stringify({type: "error", error}))

    let msg: Client.Message<EffectJSON> | undefined
    try { msg = JSON.parse(message.data) } catch {}
    if (!msg) return err("Invalid JSON")
    if (msg.type == "init") {
      if (msg.clientID == "string") client.id = msg.clientID
      if (isNatNum(msg.version) && msg.version <= this.version && msg.version >= this.startVersion) {
        for (let v = msg.version; v < this.version; v++)
          this.sendUpdate(client, this.updates[this.updates.length - (this.version - v)])
      } else {
        this.send(client, {type: "state", doc: this.doc.toJSON(), version: this.version})
      }
    } else if (msg.type == "update" && client.id) {
      let changes: ChangeSet, effects: readonly Transaction.Effect<unknown>[] | undefined
      try { changes = ChangeSet.fromJSON(this.doc.schema, msg.changes) }
      catch { return err("Invalid change") }
      if (!isNatNum(msg.version) || msg.version > this.version || msg.version < this.startVersion)
        return err("Bad version")
      if (Array.isArray(msg.effects) && this.deserializeEffect) {
        let baseDoc = msg.version == this.version ? this.doc
          : this.updates[this.updates.length - (this.version - msg.version)].doc
        try { effects = msg.effects.map(e => this.deserializeEffect!(e, baseDoc)) }
        catch(e) { return err(String(e)) }
      }
      this.receive(client, changes, effects, msg.version, client.id)
    } else {
      err("Invalid message")
    }
  }

  dropClient(client: {id: string, socket: Socket}) {
    let found = this.clients.indexOf(client)
    if (found > -1) this.clients.splice(found, 1)
  } 

  receive(
    client: {id: string, socket: Socket},
    changes: ChangeSet,
    effects: readonly Transaction.Effect<unknown>[] | undefined,
    version: number,
    clientID: string
  ) {
    if (this.version > version) {
      let mapped: collab.Update | null
      try {
        mapped = collab.transformUpdate({changes, effects, version, clientID},
                                        this.updates.slice(this.updates.length - (this.version - version)))
      } catch (e) {
        this.send(client, {type: "error", error: String(e)})
        return
      }
      if (!mapped) return
      ;({changes, effects, version, clientID} = mapped)
    }
    if (changes.length != this.doc.length) {
      this.send(client, {type: "error", error: "Length mismatch"})
      return
    }
    let update: Server.Update = {doc: this.doc, clientID, changes, effects}
    this.updates.push(update)
    this.doc = changes.apply(this.doc)
    this.version++
    for (let client of this.clients) if (client.id) this.sendUpdate(client, update)
  }
}

export namespace Server {
  export type Update = {
    doc: Plot.Doc
    changes: ChangeSet
    effects: readonly Transaction.Effect<unknown>[] | undefined
    clientID: string
  }

  export type Message<EffectJSON> = {type: "connected"} |
    {type: "error", error: string} |
    {type: "state", doc: Node.JSON, version: number} |
    {type: "update", changes: ChangeSet.JSON, effects?: EffectJSON[], clientID: string}
}

export class Client<EffectJSON = unknown> {
  socket: Socket | null = null

  constructor(
    readonly connection: (onevent: (type: "message" | "close", data: string) => void) => Socket,
    readonly clientID: string,
  ) {
  }

  connect() {
    if (this.socket) {
      // FIXME this.socket.close()
      this.socket = null
    }
    let socket = this.connection((type, data) => {
      if (type == "close") {
        if (socket == this.socket) this.socket = null
      } else {
        let msg = JSON.parse(data) as Server.Message<EffectJSON>
        if (msg.type == "connected") {
          socket.send(JSON.stringify({type: "init", clientID: this.clientID}))
        } else if (msg.type == "error") {
          // FIXME
        } else if (msg.type == "state") {
        } else if (msg.type == "update") {
          
        }
      }
    })
  }
}

export namespace Client {
  export type Message<EffectJSON> = {type: "init", clientID: string, version?: string} |
    {type: "update", changes: ChangeSet.JSON, effects: EffectJSON[], version: string}
}
