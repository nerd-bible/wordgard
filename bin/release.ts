#!/usr/bin/env node

import {execFileSync} from "node:child_process"
import {existsSync, readFileSync, writeFileSync, unlinkSync} from "node:fs"
import {join} from "node:path"

const root = join(import.meta.dirname, "..")

function run(cmd: string, args: string[]) {
  return execFileSync(cmd, args, {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", process.stderr]})
}

function getCurrentVersion() {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
}

type Changes = {breaking: string[], feature: string[], fix: string[]}

function release(conf: {edit?: boolean, version?: string} = {}) {
  run("git", ["pull"])
  let {edit, version} = conf

  let log = join(root, "CHANGELOG.md")
  let newPackage = !existsSync(log)
  let currentVersion = getCurrentVersion()
  let changes: Changes = newPackage ? {fix: [], feature: [], breaking: ["First numbered release."]} : changelog(currentVersion)
  if (!version) version = newPackage ? "0.1.0" : bumpVersion(currentVersion, changes)
  console.log(`Creating wordgard ${version}`)

  let notes = releaseNotes(changes, version)
  if (edit) notes = editReleaseNotes(notes)

  setModuleVersion(version)
  writeFileSync(log, notes.head + notes.body + (newPackage ? "" : readFileSync(log, "utf8")))
  run("git", ["add", "package.json"])
  run("git", ["add", "CHANGELOG.md"])
  run("git", ["commit", "-m", `Mark version ${version}`])
  run("git", ["tag", version, "-m", `Version ${version}\n\n${notes.body}`, "--cleanup=verbatim"])
}

function editReleaseNotes(notes: {head: string, body: string}) {
  let noteFile = join(root, "notes.txt")
  writeFileSync(noteFile, notes.head + notes.body)
  run(process.env.EDITOR || "emacs", [noteFile])
  let edited = readFileSync(noteFile, "utf8")
  unlinkSync(noteFile)
  if (!/\S/.test(edited)) process.exit(0)
  let split = /^(.*)\n+([^]*)/.exec(edited)!
  return {head: split[1] + "\n\n", body: split[2]}
}

function changelog(since: string) {
  let commits = run("git", ["log", "--format=%B%n", "--reverse", since + "..main"])
  let result = {fix: [], feature: [], breaking: []}
  let re = /\n\r?\n(BREAKING|FIX|FEATURE):\s*([^]*?)(?=\r?\n\r?\n|\r?\n?$)/g, match
  while (match = re.exec(commits))
    (result as any)[match[1].toLowerCase()].push(match[2].replace(/\r?\n/g, " "))
  return result
}

function bumpVersion(version: string, changes: Changes) {
  let [major, minor, patch] = version.split(".")
  if (major == "0") return changes.breaking.length ? `0.${Number(minor) + 1}.0` : `0.${minor}.${Number(patch) + 1}`
  if (changes.breaking.length) return `${Number(major) + 1}.0.0`
  if (changes.feature.length) return `${major}.${Number(minor) + 1}.0`
  if (changes.fix.length) return `${major}.${minor}.${Number(patch) + 1}`
  throw new Error("No new release notes!")
}

function releaseNotes(changes: Changes, version: string) {
  let pad = (n: number) => n < 10 ? "0" + n : n
  let d = new Date, date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())

  let types: Record<string, string> = {breaking: "Breaking changes", fix: "Bug fixes", feature: "New features"}

  let head = `## ${version} (${date})\n\n`, body = ""
  for (let type in types) {
    let messages = (changes as Record<string, string[]>)[type]
    if (messages.length) body += `### ${types[type]}\n\n`
    for (let msg of messages) body += msg + "\n\n"
  }
  return {head, body}
}

function setModuleVersion(version: string) {
  let file = join(root, "package.json")
  writeFileSync(file, readFileSync(file, "utf8").replace(/"version":\s*".*?"/, `"version": "${version}"`))
}

let edit = false, setVersion: string | undefined
for (let i = 2; i < process.argv.length; i++) {
  let arg = process.argv[i]
  if (arg == "--edit") edit = true
  else if (arg == "--version" && i < process.argv.length - 1) setVersion = process.argv[++i]
  else throw new Error("Unrecognized argument " + arg)
}
release({edit, version: setVersion})
