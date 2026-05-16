import {Facet, GardState} from "wordgard/state"

const phraseOverride = Facet.define<
  {set: PhraseSet<any>, phrases: Record<string, string>},
  Map<PhraseSet<any>, Record<string, string>>
>({
  combine(records) {
    let map = new Map<PhraseSet<any>, Record<string, string>>()
    for (let i = records.length - 1; i >= 0; i--) {
      let {set, phrases} = records[i]
      let known = map.get(set)
      map.set(set, known ? {...known, ...phrases} : phrases)
    }
    return map
  }
})

export class PhraseSet<Tags extends string> {
  private constructor(readonly phrases: {[tag in Tags]: string}) {}

  /// Look up a translation for phrase with the given tag.
  ///
  /// If additional arguments are passed, they will be inserted in
  /// place of markers like `$1` (for the first value) and `$2`, etc.
  /// A single `$` is equivalent to `$1`, and `$$` will produce a
  /// literal dollar sign.
  get<Tag extends Tags>(state: GardState, tag: Tag, ...insert: any[]) {
    let override = state.facet(phraseOverride).get(this)
    let phrase = (override && override[tag]) ?? this.phrases[tag]
    if (insert.length) phrase = phrase.replace(/\$(\$|\d*)/g, (m, i) => {
      if (i == "$") return "$"
      let n = +(i || 1)
      return !n || n > insert.length ? m : insert[n - 1]
    })
    return phrase
  }

  ref<Tag extends Tags>(tag: Tag): PhraseSet.Ref {
    return (state, ...insert) => this.get(state, tag, ...insert)
  }

  translate(phrases: {[tag in Tags]: string}): GardState.Extension {
    return phraseOverride.of({set: this, phrases})
  }

  translatePartial(phrases: {[tag in Tags]?: string}): GardState.Extension {
    return phraseOverride.of({set: this, phrases: phrases as Record<string, string>})
  }

  static define<Tags extends string>(phrases: {[tag in Tags]: string}) {
    return new PhraseSet<Tags>(phrases)
  }

  static didChange(a: GardState, b: GardState) {
    return a.facet(phraseOverride) != b.facet(phraseOverride)
  }
}

export namespace PhraseSet {
  export type Ref = (state: GardState, ...insert: any[]) => string

  export type Tag<Set extends PhraseSet<any>> = Set extends PhraseSet<infer T> ? T : never
}
