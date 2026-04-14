const runtimeLogStore = {
  initialized: false,
  maxEntries: 600,
  entries: [],
  originals: null,
};

function serializeArg(arg) {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  }
  if (typeof arg === "object" && arg !== null) {
    try {
      return JSON.stringify(arg, null, 2);
    } catch (error) {
      return String(arg);
    }
  }
  return String(arg);
}

function pushLog(type, args) {
  const message = args.map(serializeArg).join(" ");
  runtimeLogStore.entries.push({
    ts: Date.now(),
    type,
    message,
  });
  if (runtimeLogStore.entries.length > runtimeLogStore.maxEntries) {
    runtimeLogStore.entries.splice(0, runtimeLogStore.entries.length - runtimeLogStore.maxEntries);
  }
}

function initLogCapture(options = {}) {
  if (runtimeLogStore.initialized) {
    return;
  }

  runtimeLogStore.maxEntries = Number(options.maxEntries) || runtimeLogStore.maxEntries;
  runtimeLogStore.originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args) => {
    pushLog("log", args);
    runtimeLogStore.originals.log(...args);
  };

  console.warn = (...args) => {
    pushLog("warn", args);
    runtimeLogStore.originals.warn(...args);
  };

  console.error = (...args) => {
    pushLog("error", args);
    runtimeLogStore.originals.error(...args);
  };

  window.addEventListener("error", (event) => {
    pushLog("error", ["window.error", event?.message || "Unknown error", event?.error || ""]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    pushLog("error", ["unhandledrejection", event?.reason || "Unknown rejection"]);
  });

  runtimeLogStore.initialized = true;
}

function getCapturedLogs() {
  return [...runtimeLogStore.entries];
}

function clearCapturedLogs() {
  runtimeLogStore.entries = [];
}

function setupDebugOverlay() {
  const urlParams = new URLSearchParams(window.location.search);
  const debug = urlParams.get("debug");

  if (debug !== "true") {
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "debug-overlay";

  Object.assign(overlay.style, {
    position: "fixed",
    bottom: "0",
    left: "0",
    width: "100%",
    maxHeight: "40vh",
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    color: "white",
    fontSize: "14px",
    padding: "10px",
    zIndex: "9999",
    boxSizing: "border-box",
    whiteSpace: "pre-wrap",
    lineHeight: "1.4",
    userSelect: "text",
    pointerEvents: "auto",
    touchAction: "auto",
  });

  document.body.appendChild(overlay);

  const render = () => {
    const logs = getCapturedLogs();
    overlay.innerHTML = "";
    logs.slice(-250).forEach((entry) => {
      const row = document.createElement("div");
      row.textContent = `[${entry.type}] ${entry.message}`;
      row.style.color = entry.type === "warn" ? "yellow" : entry.type === "error" ? "#ff6b6b" : "white";
      overlay.appendChild(row);
    });
    overlay.scrollTop = overlay.scrollHeight;
  };

  setInterval(render, 500);
  render();
}

  function buildStorageKey(key) {
    return "piano-trainer-" + key;
  }

  function writeCookie(name, value, days = 365) {
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    const parts = document.cookie.split(";").map((part) => part.trim());
    const match = parts.find((part) => part.startsWith(prefix));
    if (!match) {
      return null;
    }
    return decodeURIComponent(match.slice(prefix.length));
  }

  function writeToStorage(key, value) {
    if (typeof key === "string") {
        const storageKey = buildStorageKey(key);
        const serialized = JSON.stringify(value);
        localStorage.setItem(storageKey, serialized);
        writeCookie(storageKey, serialized);
    } else {
      console.error("Key must be a string.");
    }
  }
  
  function readFromStorage(key) {
    if (typeof key === "string") {
        const storageKey = buildStorageKey(key);
        const localValue = localStorage.getItem(storageKey);
        if (localValue) {
          return JSON.parse(localValue);
        }

        const cookieValue = readCookie(storageKey);
        if (cookieValue) {
          try {
            const parsed = JSON.parse(cookieValue);
            localStorage.setItem(storageKey, cookieValue);
            return parsed;
          } catch (error) {
            console.warn("Failed to parse cookie storage value", error);
          }
        }

        return null;
    } else {
      console.error("Key must be a string.");
      return null;
    }
  }

export {
  initLogCapture,
  getCapturedLogs,
  clearCapturedLogs,
  setupDebugOverlay,
  writeToStorage,
  readFromStorage,
};