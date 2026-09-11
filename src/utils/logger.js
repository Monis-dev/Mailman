function log(level, event, meta = {}) {
    const logEntry = {
      level,
      event,
      ...meta
    };
    if (level === "ERROR") {
        console.error(JSON.stringify(logEntry))
    } else {
        console.log(JSON.stringify(logEntry))
    }
}
const logger = {
  info: (event, meta) => log("INFO", event, meta),
  warn: (event, meta) => log("WARN", event, meta),
  error: (event, meta) => log("ERROR", event, meta),
};

export default logger