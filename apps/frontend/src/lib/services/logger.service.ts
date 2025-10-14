export class LoggerService {
  constructor(private tag: string) {
    this.tag = tag;
  }

  logInfo(message: string) {
    console.log(`[${this.tag}] ${message}`);
  }

  logError(message: string): never {
    console.error(`[${this.tag}] ${message}`);
    throw new Error(message);
  }

  logWarning(message: string) {
    console.warn(`[${this.tag}] ${message}`);
  }

  logDebug(message: string) {
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[${this.tag}] ${message}`);
    }
  }

  logTrace(message: string) {
    if (process.env.NODE_ENV !== "production") {
      console.trace(`[${this.tag}] ${message}`);
    }
  }
}
