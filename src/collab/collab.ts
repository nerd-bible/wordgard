import {GardState, Transaction, Correction} from "wordgard/state"
import {ChangeSet, Plot, Node} from "wordgard/doc"
import {Wordgard} from "wordgard/editor"

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

function mapUpdate(update: LocalUpdate, doc: Plot.Doc, over: ChangeSet) {
  let {a, b} = ChangeSet.transform(doc, over, update.changes)
  return new LocalUpdate(b, Transaction.Effect.mapEffects(update.effects, a))
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
    let combined = GardState.Facet.combineConfig(configs, {
      startVersion: 0,
      clientID: null as any,
      sharedEffects: () => [],
      corrections: []
    }, {
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
    /// A set of corrections to apply to transformed changes. Can be
    /// used to enforce document shapes even in merged changes.
    /// Requires the exact same set, in the same order, to be used on
    /// the server.
    corrections?: readonly Correction[],
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
    let {clientID, corrections} = state.facet(collabConfig)

    let changes = ChangeSet.empty(state.doc.length)
    let effects: readonly Transaction.Effect<unknown>[] = []

    let haveRemote = false
    for (let update of updates) {
      if (update.version != version)
        throw new Error("Version mismatch in in received collab update")
      if (update.clientID == clientID) {
        if (!nextUpdate)
          throw new Error("Received unknown update with our client ID")
        syncedDoc = (openUpdate || haveRemote) ? nextUpdate.changes.apply(syncedDoc) : state.doc
        mismatch: if (!nextUpdate.changes.eq(update.changes)) {
          if (haveRemote && nextUpdate && corrections.length) {
            let correct = Correction.check(nextUpdate.changes, syncedDoc, corrections)
            if (correct && nextUpdate.changes.compose(correct).eq(update.changes)) {
              if (openUpdate) openUpdate = mapUpdate(openUpdate, syncedDoc, correct)
              syncedDoc = correct.apply(syncedDoc)
              break mismatch
            }
          }
          throw new Error("Received update with our client ID doesn't match our own local update")
        }
        nextUpdate = null
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
        haveRemote = true
      }
      version++
    }

    if (haveRemote && corrections.length && nextUpdate) {
      let after = openUpdate ? nextUpdate.changes.apply(syncedDoc) : state.doc
      let correct = Correction.check(nextUpdate.changes, after, corrections)
      if (correct) {
        nextUpdate = addUpdate(nextUpdate, correct)
        if (openUpdate) openUpdate = mapUpdate(openUpdate, after, correct)
      }
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

  export function hasUnsentUpdate(state: GardState): boolean {
    let collab = state.field(collabField)
    return !!(collab.nextUpdate || collab.openUpdate)
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
    over: readonly {doc: Plot.Doc, changes: ChangeSet, clientID: string}[],
    corrections?: readonly Correction[]
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
    if (corrections && corrections.length) {
      let corrected = Correction.check(changes, changes.apply(over[over.length - 1].doc), corrections)
      if (corrected) {
        changes = changes.compose(corrected)
        if (effects) effects = Transaction.Effect.mapEffects(effects, corrected)
      }
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
  /// Close the socket.
  close(): void
}

function isNatNum(n: any): n is number {
  return typeof n == "number" && Math.floor(n) == n && n >= 0
}

export class Server {
  clients: {id: string, socket: Socket}[] = []

  private constructor(
    public doc: Plot.Doc,
    public version: number,
    public updates: Server.Update[],
  ) {}

  static create(config: {
    doc: Plot.Doc,
    version?: number,
    updates?: Server.Update[],
  }) {
    return new Server(config.doc, config.version ?? 0, config.updates ?? [])
  }

  get startVersion() {
    return this.version - this.updates.length
  }

  connect(create: (event: (type: "message" | "close", data: string) => void) => Socket) {
    let client = {id: "", socket: create((type, data) => this.socketEvent(client, type, data))}
    this.clients.push(client)
  }

  send(client: {id: string, socket: Socket}, message: Server.Message) {
    try {
      client.socket.send(JSON.stringify(message))
    } catch {
      this.dropClient(client)
    }
  }

  sendUpdate(client: {id: string, socket: Socket}, update: Server.Update) {
    this.send(client, {
      type: "update",
      changes: update.changes.toJSON(),
      clientID: update.clientID,
      version: update.version
    })
  }

  socketEvent(client: {id: string, socket: Socket}, type: "message" | "close", data: string) {
    if (type == "close") return this.dropClient(client)

    let err = (error: string) => client.socket.send(JSON.stringify({type: "error", error}))

    let msg: Client.Message | undefined
    try { msg = JSON.parse(data) } catch {}
    if (!msg) return err("Invalid JSON")
    if (msg.type == "init") {
      if (typeof msg.clientID == "string") client.id = msg.clientID
      if (isNatNum(msg.version) && msg.version <= this.version && msg.version >= this.startVersion) {
        for (let v = msg.version; v < this.version; v++)
          this.sendUpdate(client, this.updates[this.updates.length - (this.version - v)])
      } else {
        this.send(client, {type: "state", doc: this.doc.toJSON(), version: this.version})
      }
    } else if (msg.type == "update" && client.id) {
      let changes: ChangeSet
      try { changes = ChangeSet.fromJSON(this.doc.schema, msg.changes) }
      catch { return err("Invalid change") }
      if (!isNatNum(msg.version) || msg.version > this.version || msg.version < this.startVersion)
        return err("Bad version")
      this.receive(client, changes, msg.version, client.id)
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
    version: number,
    clientID: string
  ) {
    if (this.version > version) {
      let mapped: collab.Update | null
      try {
        mapped = collab.transformUpdate({changes, version, clientID},
                                        this.updates.slice(this.updates.length - (this.version - version)))
      } catch (e) {
        this.send(client, {type: "error", error: String(e)})
        return
      }
      if (!mapped) return
      ;({changes, version, clientID} = mapped)
    }
    if (changes.length != this.doc.length) {
      this.send(client, {type: "error", error: "Length mismatch"})
      return
    }
    let update: Server.Update = {doc: this.doc, clientID, changes, version: this.version}
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
    clientID: string
    version: number
  }

  export type Message = {type: "error", error: string} |
    {type: "state", doc: Node.JSON, version: number} |
    {type: "update", changes: ChangeSet.JSON, clientID: string, version: number}
}

export class Client {
  socket: Socket | null = null
  editor: Wordgard | null = null
  pendingUpdate = -1
  reconnecting = -1

  constructor(
    readonly clientID: string,
    readonly connection: (onevent: (type: "message" | "close", data: string) => void) => Socket,
    readonly editorConfig: Wordgard.Spec | ((collab: GardState.Extension, doc: Node.JSON) => Wordgard)
  ) {}

  connect(): Promise<Wordgard> {
    if (this.socket) {
      try { this.socket.close() } catch {}
      this.socket = null
    }
    return new Promise<Wordgard>((resolve, reject) => {
      let socket = this.socket = this.connection((type, data) => {
        if (socket != this.socket) return
        if (type == "close") {
          this.socket = null
          if (this.editor) this.disconnected()
          else reject(data)
          return
        }

        try {
          let msg = JSON.parse(data) as Server.Message
          if (msg.type == "error") {
            reject(msg.error)
          } else if (msg.type == "state" && !this.editor) {
            this.editor = this.createEditor(msg.version, msg.doc)
            resolve(this.editor)
          } else if (msg.type == "update" && this.editor) {
            if (version != null) {
              resolve(this.editor)
              version = undefined
            }
            this.receiveUpdate(ChangeSet.fromJSON(this.editor.state.schema, msg.changes),
                               msg.clientID, msg.version)
          }
        } catch(e) {
          reject(e)
        }
      })
      let version = this.editor ? collab.getSyncedVersion(this.editor.state) : undefined
      socket.send(JSON.stringify({type: "init", clientID: this.clientID, version}))
    })
  }

  createEditor(version: number, docJSON: Node.JSON) {
    let ext = [
      collab({clientID: this.clientID, startVersion: version}),
      Wordgard.updateListener.of(update => this.scheduleUpdate())
    ]
    let conf = this.editorConfig
    if (typeof conf == "function") return conf(ext, docJSON)
    if (conf.config instanceof GardState.Configuration)
      throw new Error("Cannot pass a resolved configuration to collab Client")
    return Wordgard.create({...this.editorConfig, config: [ext, conf.config || []], doc: docJSON})
  }

  receiveUpdate(changes: ChangeSet, clientID: string, version: number) {
    if (!this.editor) return
    this.editor.dispatch(collab.receive(this.editor.state, [{changes, clientID, version}]))
    if (collab.hasUnsentUpdate(this.editor.state)) this.scheduleUpdate()
  }

  scheduleUpdate() {
    if (this.pendingUpdate == -1 && this.editor)
      this.pendingUpdate = this.editor.win.setTimeout(() => this.sendUpdate(), 50)
  }

  sendUpdate() {
    this.pendingUpdate = -1
    if (this.editor && this.socket) {
      let update = collab.sendableUpdate(this.editor.state)
      if (update) try {
        this.socket.send(JSON.stringify({
          type: "update",
          changes: update.changes.toJSON(),
          version: update.version
        }))
        // In case these get dropped, schedule another attempt
        this.editor.win.setTimeout(() => this.scheduleUpdate(), 5000)
      } catch (e) {
        this.disconnected()
      }
    }
  }

  disconnected() {
    if (this.socket) {
      try { this.socket.close() } catch {}
      this.socket = null
    }
    this.scheduleReconnect(200)
  }

  scheduleReconnect(delay: number) {
    if (this.editor && this.reconnecting < 0) {
      this.reconnecting = this.editor.win.setTimeout(() => {
        this.reconnecting = -1
        this.connect().catch(() => {
          this.scheduleReconnect(Math.min(5000, delay * 2))
        })
      }, delay)
    }
  }
}

export namespace Client {
  export type Message = {type: "init", clientID: string, version?: string} |
    {type: "update", changes: ChangeSet.JSON, version: string}
}
