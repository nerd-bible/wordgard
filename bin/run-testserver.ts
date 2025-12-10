import {testServer} from "./testserver.ts"

let port = 8111
testServer(port, !!process.env.OPEN)
console.log(`Dev server listening on ${port}`)
