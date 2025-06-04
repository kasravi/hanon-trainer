function setupDebugOverlay() {
    const urlParams = new URLSearchParams(window.location.search);
    const debug = urlParams.get("debug");
  
    if (debug === "true") {
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
  
      const originalLog = console.log;
      const originalWarn = console.warn;
      const originalError = console.error;
  
      function appendLog(type, args) {
        const message = args
          .map((arg) =>
            typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
          )
          .join(" ");
  
        const logEntry = document.createElement("div");
        logEntry.textContent = `[${type}] ${message}`;
        logEntry.style.color =
          type === "warn" ? "yellow" : type === "error" ? "red" : "white";
  
        overlay.appendChild(logEntry);
        overlay.scrollTop = overlay.scrollHeight;
  
        if (overlay.children.length > 500) {
          overlay.removeChild(overlay.firstChild);
        }
      }
  
      console.log = function (...args) {
        appendLog("log", args);
        originalLog.apply(console, args);
      };
  
      console.warn = function (...args) {
        appendLog("warn", args);
        originalWarn.apply(console, args);
      };
  
      console.error = function (...args) {
        appendLog("error", args);
        originalError.apply(console, args);
      };
    }
  }

  function writeToStorage(key, value) {
    if (typeof key === "string") {
      localStorage.setItem("piano-trainer-" + key, JSON.stringify(value));
    } else {
      console.error("Key must be a string.");
    }
  }
  
  function readFromStorage(key) {
    if (typeof key === "string") {
      const value = localStorage.getItem("piano-trainer-" + key);
      return value ? JSON.parse(value) : null;
    } else {
      console.error("Key must be a string.");
      return null;
    }
  }

export { setupDebugOverlay, writeToStorage, readFromStorage };