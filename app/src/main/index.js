"use strict"

let { app, BrowserWindow, ipcMain } = require("electron")
let fs = require("fs-extra")
let { join } = require("path")
let { spawn } = require("child_process")
let home = require("user-home")
let semver = require("semver")
let toml = require("toml")
let axios = require("axios")
let Raven = require("raven")

let pkg = require("../../../package.json")
let addMenu = require("./menu.js")
let config = require("../../../config.js")

let shuttingDown = false
let mainWindow
let lcdProcess
let streams = []
let nodeIP
let connecting = true
let seeds = null
let booted = false

const root = require("../root.js")
const networkPath = require("../network.js").path

const lcdHome = join(root, "lcd")
const WIN = /^win/.test(process.platform)
const DEV = process.env.NODE_ENV === "development"
const TEST = process.env.NODE_ENV === "testing"
// TODO default logging or default disable logging?
const LOGGING = JSON.parse(process.env.LOGGING || "true") !== false
const winURL = DEV
  ? `http://localhost:${config.wds_port}`
  : `file://${__dirname}/index.html`
const LCD_PORT = DEV ? config.lcd_port : config.lcd_port_prod
const NODE = process.env.COSMOS_NODE

let SERVER_BINARY = "gaia" + (WIN ? ".exe" : "")

function log(...args) {
  if (LOGGING) {
    console.log(...args)
  }
}
function logError(...args) {
  if (LOGGING) {
    console.log(...args)
  }
}

function logProcess(process, logPath) {
  fs.ensureFileSync(logPath)
  // Writestreams are blocking fs cleanup in tests, if you get errors, disable logging
  if (LOGGING) {
    let logStream = fs.createWriteStream(logPath, { flags: "a" }) // 'a' means appending (old data will be preserved)
    streams.push(logStream)
    process.stdout.pipe(logStream)
    process.stderr.pipe(logStream)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function expectCleanExit(process, errorMessage = "Process exited unplanned") {
  return new Promise((resolve, reject) => {
    process.on("exit", code => {
      if (code !== 0 && !shuttingDown) {
        reject(Error(errorMessage))
      }
      resolve()
    })
  })
}

function handleCrash(error) {
  afterBooted(() => {
    mainWindow.webContents.send("error", error)
  })
}

function shutdown() {
  if (shuttingDown) return

  mainWindow = null
  shuttingDown = true

  if (lcdProcess) {
    log("killing lcd")
    lcdProcess.kill("SIGKILL")
    lcdProcess = null
  }

  return Promise.all(
    streams.map(stream => new Promise(resolve => stream.close(resolve)))
  )
}

function createWindow() {
  mainWindow = new BrowserWindow({
    minWidth: 320,
    minHeight: 480,
    width: 1024,
    height: 768,
    center: true,
    title: "Cosmos Voyager",
    darkTheme: true,
    titleBarStyle: "hidden",
    webPreferences: { webSecurity: false }
  })

  // start vue app
  mainWindow.loadURL(winURL + "?lcd_port=" + LCD_PORT)

  if (DEV || JSON.parse(process.env.COSMOS_DEVTOOLS || "false")) {
    mainWindow.webContents.openDevTools()
  }
  if (DEV) {
    mainWindow.maximize()
  }

  mainWindow.on("closed", shutdown)

  // eslint-disable-next-line no-console
  log("mainWindow opened")

  // handle opening external links in OS's browser
  let webContents = mainWindow.webContents
  let handleRedirect = (e, url) => {
    if (url !== webContents.getURL()) {
      e.preventDefault()
      require("electron").shell.openExternal(url)
    }
  }
  webContents.on("will-navigate", handleRedirect)
  webContents.on("new-window", handleRedirect)

  if (!WIN) addMenu()
}

function startProcess(name, args, env) {
  let binPath
  if (process.env.BINARY_PATH) {
    binPath = process.env.BINARY_PATH
  } else if (DEV) {
    // in dev mode or tests, use binaries installed in GOPATH
    let GOPATH = process.env.GOPATH
    if (!GOPATH) GOPATH = join(home, "go")
    binPath = join(GOPATH, "bin", name)
  } else {
    // in production mode, use binaries packaged with app
    binPath = join(__dirname, "..", "bin", name)
  }

  let argString = args.map(arg => JSON.stringify(arg)).join(" ")
  log(`spawning ${binPath} with args "${argString}"`)
  let child
  try {
    child = spawn(binPath, args, env)
  } catch (err) {
    log(`Err: Spawning ${name} failed`, err)
    throw err
  }
  child.stdout.on("data", data => !shuttingDown && log(`${name}: ${data}`))
  child.stderr.on("data", data => !shuttingDown && log(`${name}: ${data}`))
  child.on(
    "exit",
    code => !shuttingDown && log(`${name} exited with code ${code}`)
  )
  child.on("error", async function(err) {
    if (!(shuttingDown && err.code === "ECONNRESET")) {
      // if we throw errors here, they are not handled by the main process
      console.error(
        "[Uncaught Exception] Child",
        name,
        "produced an unhandled exception:",
        err
      )
      handleCrash(err)

      Raven.captureException(err)
    }
  })
  return child
}

app.on("window-all-closed", () => {
  app.quit()
})

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow()
  }
})

app.on("ready", () => createWindow())

// start lcd REST API
async function startLCD(home, nodeIP) {
  return new Promise((resolve, reject) => {
    log("startLCD", home)
    let child = startProcess(SERVER_BINARY, [
      "rest-server",
      "--port",
      LCD_PORT,
      "--home",
      home,
      "--node",
      nodeIP
      // '--trust-node'
    ])
    logProcess(child, join(home, "lcd.log"))

    child.stdout.on("data", data => {
      if (data.includes("Serving on")) resolve(child)
    })
    child.on("exit", () => {
      afterBooted(() => {
        mainWindow.webContents.send(
          "error",
          Error("The Gaia REST-server (LCD) exited unplanned")
        )
      })
    })
  })
}

async function getGaiaVersion() {
  let child = startProcess(SERVER_BINARY, ["version"])
  let data = await new Promise(resolve => {
    child.stdout.on("data", resolve)
  })
  return data.toString("utf8").trim()
}

function exists(path) {
  try {
    fs.accessSync(path)
    return true
  } catch (err) {
    if (err.code !== "ENOENT") throw err
    return false
  }
}

function handleHashVerification(nodeHash) {
  return new Promise((resolve, reject) => {
    ipcMain.once("hash-approved", (event, hash) => {
      ipcMain.removeAllListeners("hash-disapproved")

      if (hash === nodeHash) {
        resolve()
      } else {
        reject()
      }
    })
    ipcMain.once("hash-disapproved", (event, hash) => {
      ipcMain.removeAllListeners("hash-approved")

      reject()
    })
  })
}

async function initLCD(chainId, home, node) {
  // let the user in the view approve the hash we get from the node
  return new Promise((resolve, reject) => {
    // `gaia client init` to generate config
    let child = startProcess(SERVER_BINARY, [
      "client",
      "init",
      "--home",
      home,
      "--chain-id",
      chainId,
      "--node",
      node
    ])

    child.stdout.on("data", async data => {
      let hashMatch = /\w{40}/g.exec(data)
      if (hashMatch) {
        afterBooted(() => {
          mainWindow.webContents.send("approve-hash", hashMatch[0])
        })

        handleHashVerification(hashMatch[0])
          .then(
            async () => {
              log("approved hash", hashMatch[0])
              if (shuttingDown) return
              // answer 'y' to the prompt about trust seed.
              child.stdin.write("y\n")

              expectCleanExit(child, "gaia init exited unplanned").then(
                resolve,
                reject
              )
            },
            () => {
              // kill process as we will spin up a new init process
              child.kill("SIGTERM")

              if (shuttingDown) return

              // select a new node to try out
              nodeIP = pickNode(seeds)

              initLCD(chainId, home, nodeIP).then(resolve, reject)
            }
          )
          .catch(reject)
      }
    })
  })
  await expectCleanExit(child, "gaia init exited unplanned")
}

/*
* log to file
*/
function setupLogging(root) {
  if (!LOGGING) return

  // initialize log file
  let logFilePath = join(root, "main.log")
  fs.ensureFileSync(logFilePath)
  let mainLog = fs.createWriteStream(logFilePath, { flags: "a" }) // 'a' means appending (old data will be preserved)
  mainLog.write(`${new Date()} Running Cosmos-UI\r\n`)
  // mainLog.write(`${new Date()} Environment: ${JSON.stringify(process.env)}\r\n`) // TODO should be filtered before adding it to the log
  streams.push(mainLog)

  log("Redirecting console output to logfile", logFilePath)
  // redirect stdout/err to logfile
  // TODO overwriting console.log sounds like a bad idea, can we find an alternative?
  // eslint-disable-next-line no-func-assign
  log = function(...args) {
    if (DEV) {
      console.log(...args)
    }
    mainLog.write(`main-process: ${args.join(" ")}\r\n`)
  }
  // eslint-disable-next-line no-func-assign
  logError = function(...args) {
    if (DEV) {
      console.error(...args)
    }
    mainLog.write(`main-process: ${args.join(" ")}\r\n`)
  }
}

if (!TEST) {
  process.on("exit", shutdown)
  // on uncaught exceptions we wait so the sentry event can be sent
  process.on("uncaughtException", async function(err) {
    logError("[Uncaught Exception]", err)
    Raven.captureException(err)
    handleCrash(err)
  })
  process.on("unhandledRejection", async function(err) {
    logError("[Unhandled Promise Rejection]", err)
    Raven.captureException(err)
    handleCrash(err)
  })
}

function consistentConfigDir(
  appVersionPath,
  genesisPath,
  configPath,
  gaiaVersionPath
) {
  return (
    exists(genesisPath) &&
    exists(appVersionPath) &&
    exists(configPath) &&
    exists(gaiaVersionPath)
  )
}

function handleIPC() {
  ipcMain.on("successful-launch", () => {
    console.log("[START SUCCESS] Vue app successfuly started")
  })
  ipcMain.on("reconnect", () => reconnect(seeds))
  ipcMain.on("booted", () => {
    booted = true
  })
  ipcMain.on("error-collection", (event, optin) => {
    Raven.uninstall()
      .config(optin ? config.sentry_dsn : "", {
        captureUnhandledRejections: false
      })
      .install()
  })
}

// check if LCD is initialized as the configs could be corrupted
// we need to parse the error on initialization as there is no way to just get this status programmatically
function lcdInitialized(home) {
  log("Testing if LCD is already initialized")
  return new Promise((resolve, reject) => {
    let child = startProcess(SERVER_BINARY, [
      "client",
      "init",
      "--home",
      home
      // '--trust-node'
    ])
    child.stderr.on("data", data => {
      if (data.toString().includes("already is initialized")) {
        return resolve(true)
      }
      if (data.toString().includes('"--chain-id" required')) {
        return resolve(false)
      }
      reject("Unknown state for Gaia initialization: " + data.toString())
    })
  })
}

function pickNode(seeds) {
  let nodeIP = NODE || seeds[Math.floor(Math.random() * seeds.length)]
  // let nodeRegex = /([http[s]:\/\/]())/g
  log("Picked seed:", nodeIP, "of", seeds)
  // replace port with default RPC port
  nodeIP = `${nodeIP.split(":")[0]}:46657`

  return nodeIP
}

async function connect(seeds, nodeIP) {
  log(`starting gaia server with nodeIP ${nodeIP}`)
  lcdProcess = await startLCD(lcdHome, nodeIP).catch(console.error)
  log("gaia server ready")

  afterBooted(() => {
    mainWindow.webContents.send("connected", nodeIP)
  })

  connecting = false

  // signal new node to view
  return nodeIP
}

async function reconnect(seeds) {
  if (connecting) return
  connecting = true

  let nodeAlive = false
  while (!nodeAlive) {
    let nodeIP = pickNode(seeds)
    nodeAlive = await axios
      .get("http://" + nodeIP, { timeout: 3000 })
      .then(() => true, () => false)
    log(
      `${new Date().toLocaleTimeString()} ${nodeIP} is ${
        nodeAlive ? "alive" : "down"
      }`
    )

    if (!nodeAlive) await sleep(2000)
  }

  log("quitting running LCD")
  lcdProcess.kill("SIGKILL")

  await connect(seeds, nodeIP)

  return nodeIP
}

async function main() {
  // we only enable error collection after users opted in
  Raven.config("", { captureUnhandledRejections: false }).install()

  let appVersionPath = join(root, "app_version")
  let genesisPath = join(root, "genesis.json")
  let configPath = join(root, "config.toml")
  let gaiaVersionPath = join(root, "gaiaversion.txt")

  let rootExists = exists(root)
  await fs.ensureDir(root)

  setupLogging(root)

  // handle ipc messages from the renderer process
  handleIPC()

  let init = true
  if (rootExists) {
    log(`root exists (${root})`)

    // NOTE: when changing this code, always make sure the app can never
    // overwrite/delete existing data without at least backing it up,
    // since it may contain the user's private keys and they might not
    // have written down their seed words.
    // they might get pretty mad if the app deletes their money!

    // check if the existing data came from a compatible app version
    // if not, fail with an error
    if (
      consistentConfigDir(
        appVersionPath,
        genesisPath,
        configPath,
        gaiaVersionPath
      )
    ) {
      let existingVersion = fs.readFileSync(appVersionPath, "utf8").trim()
      let compatible = semver.diff(existingVersion, pkg.version) !== "major"
      if (compatible) {
        log("configs are compatible with current app version")
        init = false
      } else {
        // TODO: versions of the app with different data formats will need to learn how to
        // migrate old data
        throw Error(`Data was created with an incompatible app version
        data=${existingVersion} app=${pkg.version}`)
      }
    } else {
      throw Error(`The data directory (${root}) has missing files`)
    }

    // check to make sure the genesis.json we want to use matches the one
    // we already have. if it has changed, exit with an error
    if (!init) {
      let existingGenesis = fs.readFileSync(genesisPath, "utf8")
      let genesisJSON = JSON.parse(existingGenesis)
      // skip this check for local testnet
      if (genesisJSON.chain_id !== "local") {
        let specifiedGenesis = fs.readFileSync(
          join(networkPath, "genesis.json"),
          "utf8"
        )
        if (existingGenesis.trim() !== specifiedGenesis.trim()) {
          throw Error("Genesis has changed")
        }
      }
    }
  }

  if (init) {
    log(`initializing data directory (${root})`)
    await fs.ensureDir(root)

    // copy predefined genesis.json and config.toml into root
    fs.accessSync(networkPath) // crash if invalid path
    fs.copySync(networkPath, root)

    fs.writeFileSync(appVersionPath, pkg.version)
  }

  log("starting app")
  log(`dev mode: ${DEV}`)
  log(`winURL: ${winURL}`)

  let gaiaVersion = await getGaiaVersion()
  let expectedGaiaVersion = fs.readFileSync(gaiaVersionPath, "utf8").trim()
  log(`gaia version: "${gaiaVersion}", expected: "${expectedGaiaVersion}"`)
  // TODO: semver check, or exact match?
  if (gaiaVersion !== expectedGaiaVersion) {
    throw Error(`Requires gaia ${expectedGaiaVersion}, but got ${gaiaVersion}.
    Please update your gaia installation or build with a newer binary.`)
  }

  // read chainId from genesis.json
  let genesisText = fs.readFileSync(genesisPath, "utf8")
  let genesis = JSON.parse(genesisText)
  let chainId = genesis.chain_id

  // pick a random seed node from config.toml
  // TODO: user-specified nodes, support switching?
  let configText = fs.readFileSync(configPath, "utf8") // checked before if the file exists
  let configTOML = toml.parse(configText)
  seeds = configTOML.p2p.seeds.split(",").filter(x => x !== "")
  if (seeds.length === 0) {
    throw new Error("No seeds specified in config.toml")
  }

  // choose one random node to start from
  nodeIP = pickNode(seeds)

  let _lcdInitialized = await lcdInitialized(join(root, "lcd"))
  log("LCD is" + (_lcdInitialized ? "" : " not") + " initialized")
  if (init || !_lcdInitialized) {
    log(`Trying to initialize lcd with remote node ${nodeIP}`)
    await initLCD(chainId, lcdHome, nodeIP)
  }
  await connect(seeds, nodeIP)
}
module.exports = main()
  .catch(err => {
    logError(err)
    handleCrash(err)
  })
  .then(() => ({
    shutdown,
    processes: { lcdProcess }
  }))

function afterBooted(cb) {
  if (booted) {
    cb()
  } else {
    ipcMain.once("booted", event => {
      cb()
    })
  }
}
