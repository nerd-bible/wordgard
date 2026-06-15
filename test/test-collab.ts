import {GardState, Transaction, Correction} from "wordgard/state"
import {Leaf, type ChangeSet} from "wordgard/doc"
import {Paragraph} from "wordgard/schema-def"
import {basicBuilders, eq} from "./schema.ts"
import {history, undo, redo} from "wordgard/history"
import ist from "ist"
import {collab} from "wordgard/collab"

let {doc, p} = basicBuilders

class DummyServer {
  states: GardState[] = []
  updates: collab.Update[] = []
  version = 0
  delayed: number[] = []

  constructor(d: string = "", config: {n?: number, extensions?: GardState.Extension[], collabConf?: any} = {}) {
    let {n = 2, extensions = [], collabConf = {}} = config
    for (let i = 0; i < n; i++)
      this.states.push(GardState.create({doc: doc(p(d)), config: [history(), collab(collabConf), ...extensions]}))
  }

  sync(client: number) {
    let state = this.states[client], version = collab.getSyncedVersion(state)
    if (version != this.version) {
      let i = this.updates.length
      while (i && this.updates[i - 1].versionBefore >= version) i--
      this.states[client] = collab.receive(state, this.updates.slice(i)).state
    }
  }

  send(client: number) {
    let state = this.states[client], sendable = collab.sendableUpdate(state)
    if (sendable && sendable.versionBefore != this.version) return false
    if (sendable) {
      this.updates = this.updates.concat(sendable)
      this.version = sendable.versionAfter
    }
    return true
  }

  broadcast(client: number) {
    if (this.delayed.indexOf(client) > -1) return
    this.sync(client)
    this.send(client)
    for (let i = 0; i < this.states.length; i++) if (i != client) this.sync(i)
  }

  update(client: number, f: (state: GardState) => Transaction | Transaction.Spec) {
    let state = this.states[client], tr = f(state)
    if (!(tr instanceof Transaction)) tr = state.update(tr)
    this.states[client] = (tr as Transaction).state
    this.broadcast(client)
  }

  type(client: number, text: string, pos: number = this.states[client].selection.head) {
    this.update(client, s => s.update({changes: {from: pos, insert: [Leaf.text(text)]}, selection: {anchor: pos + text.length}}))
  }

  undo(client: number) {
    let tr = undo({state: this.states[client]}, null)
    if (tr) this.update(client, () => tr)
  }

  redo(client: number) {
    let tr = redo({state: this.states[client]}, null)
    if (tr) this.update(client, () => tr)
  }

  conv(expect: string) {
    this.states.forEach(state => ist(state.doc, doc(expect ? p(expect) : p()), eq))
  }

  delay(client: number, f: () => void) {
    this.delayed.push(client)
    f()
    this.delayed.pop()
    this.broadcast(client)
  }
}

describe("collab", () => {
  it("converges for simple changes", () => {
    let s = new DummyServer
    s.type(0, "hi")
    s.type(1, "ok", 3)
    s.type(0, "!", 5)
    s.type(1, "...", 1)
    s.conv("...hiok!")
  })

  it("converges for multiple local changes", () => {
    let s = new DummyServer
    s.type(0, "hi")
    s.delay(0, () => {
      s.type(0, "A")
      s.type(1, "X", 3)
      s.type(0, "B")
      s.type(1, "Y")
    })
    s.conv("hiXYAB")
  })

  it("converges with three peers", () => {
    let s = new DummyServer(undefined, {n: 3})
    s.type(0, "A")
    s.type(1, "U")
    s.type(2, "X")
    s.type(0, "B")
    s.type(1, "V")
    s.type(2, "Y")
    s.conv("XYUVAB")
  })

  it("converges with three peers with multiple steps", () => {
    let s = new DummyServer(undefined, {n: 3})
    s.type(0, "A")
    s.delay(1, () => {
      s.type(1, "U")
      s.type(2, "X")
      s.type(0, "B")
      s.type(1, "V")
      s.type(2, "Y")
    })
    s.conv("XYUVAB")
  })

  it("supports undo", () => {
    let s = new DummyServer
    s.type(0, "A")
    s.type(1, "a")
    s.type(0, "B")
    s.undo(1)
    s.conv("AB")
    s.type(1, "b")
    s.type(0, "C")
    s.conv("bABC")
  })

  it("supports redo", () => {
    let s = new DummyServer
    s.type(0, "A")
    s.type(1, "a")
    s.type(0, "B")
    s.undo(1)
    s.redo(1)
    s.type(1, "b")
    s.type(0, "C")
    s.conv("abABC")
  })

  it("supports deep undo", () => {
    let s = new DummyServer("hello bye")
    s.update(0, s => s.update({selection: {anchor: 6}}))
    s.update(1, s => s.update({selection: {anchor: 10}}))
    s.type(0, "!")
    s.type(1, "!")
    s.update(0, s => s.update({annotations: history.isolate.of(true)}))
    s.delay(0, () => {
      s.type(0, " ...")
      s.type(1, " ,,,")
    })
    s.update(0, s => s.update({annotations: history.isolate.of(true)}))
    s.type(0, "*")
    s.type(1, "*")
    s.undo(0)
    s.conv("hello! ... bye! ,,,*")
    s.undo(0)
    s.undo(0)
    s.conv("hello bye! ,,,*")
    s.redo(0)
    s.redo(0)
    s.redo(0)
    s.conv("hello! ...* bye! ,,,*")
    s.undo(0)
    s.undo(0)
    s.conv("hello! bye! ,,,*")
    s.undo(1)
    s.conv("hello! bye")
  })

  it("support undo with clashing events", () => {
    let s = new DummyServer("okay!")
    s.type(0, "A", 6)
    s.delay(0, () => {
      s.type(0, "B", 4)
      s.type(0, "C", 5)
      s.type(0, "D", 1)
      s.update(1, s => s.update({changes: {from: 2, to: 5}}))
    })
    s.conv("DoBC!A")
    s.undo(0)
    s.undo(0)
    s.conv("o!A")
    ist(s.states[0].selection.head, 4)
  })

  it("handles conflicting steps", () => {
    let s = new DummyServer("abcde")
    s.delay(0, () => {
      s.update(0, s => s.update({changes: {from: 3, to: 4}}))
      s.type(0, "x")
      s.update(1, s => s.update({changes: {from: 2, to: 5}}))
    })
    s.undo(0)
    s.undo(0)
    s.conv("ace")
  })

  it("can undo simultaneous typing", () => {
    let s = new DummyServer("A B")
    s.delay(0, () => {
      s.type(0, "1", 2)
      s.type(0, "2")
      s.type(1, "x", 4)
      s.type(1, "y")
    })
    s.conv("A12 Bxy")
    s.undo(0)
    s.conv("A Bxy")
    s.undo(1)
    s.conv("A B")
  })

  it("allows you to set the initial version", () => {
    ist(collab.getSyncedVersion(GardState.create({doc: doc(p()), config: [collab({startVersion: 20})]})), 20)
  })

  it("client ids survive reconfiguration", () => {
    let ext = collab()
    let state = GardState.create({doc: doc(p()), config: [ext]})
    let state2 = state.update({effects: GardState.reconfigure.of(ext)}).state
    ist(collab.getClientID(state), collab.getClientID(state2))
  })

  it("supports shared effects", () => {
    class Mark {
      from: number
      to: number
      id: string

      constructor(from: number, to: number, id: string) {
        this.from = from; this.to = to; this.id = id
      }

      map(mapping: ChangeSet) {
        let from = mapping.mapPos(this.from, 1), to = mapping.mapPos(this.to, -1)
        return from >= to ? undefined : new Mark(from, to, this.id)
      }

      toString() { return `${this.from}-${this.to}=${this.id}` }
    }
    let addMark = Transaction.Effect.define<Mark>({map: (v, m) => v.map(m)})
    let marks = GardState.Field.define<Mark[]>({
      create: () => [],
      update(value, tr) {
        value = value.map(m => m.map(tr.changes)).filter(x => x) as any
        for (let effect of tr.effects) if (effect.is(addMark)) value = value.concat(effect.value)
        return value.sort((a, b) => a.id < b.id ? -1 : 1)
      }
    })

    let s = new DummyServer("hello", {
      extensions: [marks],
      collabConf: {sharedEffects(tr: Transaction) { return tr.effects.filter(e => e.is(addMark)) }}
    })
    s.delay(0, () => {
      s.delay(1, () => {
        s.update(0, s => s.update({effects: addMark.of(new Mark(2, 4, "a"))}))
        s.update(1, s => s.update({effects: addMark.of(new Mark(4, 6, "b"))}))
        s.type(0, "A", 5)
        s.type(1, "B", 1)
        ist(s.states[0].field(marks).join(), "2-4=a")
        ist(s.states[1].field(marks).join(), "5-7=b")
      })
    })
    s.conv("BhellAo")
    ist(s.states[0].field(marks).join(), "3-5=a,5-8=b")
    ist(s.states[1].field(marks).join(), "3-5=a,5-8=b")
  })

  it("holds up on random input", () => {
    let r = (n: number) => Math.floor(Math.random() * n)
    for (let i = 0; i < 100; i++) {
      let n = 3, s = new DummyServer("abcd", {n})
      for (let c = 0; c < n; c++) s.delayed.push(c)
      for (let j = 0; j < 25; j++) {
        let client = r(n), sel = r(4), len = s.states[client].doc.length
        if (sel == 0) {
          s.send(client)
        } else if (sel == 1) {
          s.sync(client)
        } else if (sel == 2) {
          s.type(client, String.fromCharCode(65 + r(26)), 1 + r(len - 2))
        } else if (len > 2) {
          let from = 1 + r(len - 3), to = from + 1 + r(len - 2 - from)
          s.update(client, s => s.update({changes: {from, to}}))
        }
      }
      for (;;) {
        let done = true
        for (let c = 0; c < n; c++) if (!s.send(c)) done = false
        for (let c = 0; c < n; c++) s.sync(c)
        if (done) break
      }
      for (let c = 1; c < n; c++) s.conv(s.states[0].doc.textContent())
    }
  })

  it("can handle corrections kicking in for merged steps", () => {
    let shortPara = Correction.onChildList(Paragraph, plot => {
      return plot.node.contentLength <= 5 ? null : {from: plot.start + 5, to: plot.end}
    })
    let s = new DummyServer("abcd", {extensions: [shortPara]})
    s.delay(0, () => {
      s.type(0, "x", 5)
      s.type(1, "y", 5)
    })
    s.conv("abcdy")
  })
})
