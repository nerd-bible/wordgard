let headless = /[?&]headless\b/.test(location.search)

mocha.setup(headless ? {
  ui: "bdd",
  reporter: function(runner) {
    // This collects test results and puts them into a JSON structure,
    // so that the process that starts the headless browser can easily
    // pick the result out of the dumped DOM.
    let output = []
    let add = (test, data) => {
      data.name = test.title
      data.scope = []
      for (let obj = test.parent; obj; obj = obj.parent) if (obj.title) data.scope.unshift(obj.title)
      output.push(data)
    }
    runner.on("pass", test => add(test, {}))
    runner.on("fail", (test, err) => add(test, {fail: String(err)}))
    runner.on("pending", test => add(test, {pending: true}))
    window.onerror = e => output.push({name: "#" + (output.length + 1), scope: ["Top errors"], fail: String(e)})
    runner.once("end", () => {
      document.head.remove()
      document.body.innerHTML = ""
      let out = document.body.appendChild(document.createElement("pre"))
      out.textContent = JSON.stringify(output, null, 2)
    })
  }
} : {
  ui: "bdd"
})

onload = () => mocha.run()
