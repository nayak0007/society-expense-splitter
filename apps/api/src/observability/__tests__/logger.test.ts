import { pino, type Logger } from "pino";

import {
  LOG_REDACTION_CENSOR,
  LOG_REDACT_PATHS,
  SENSITIVE_LOG_KEYS,
} from "../logger";

/**
 * SAD §13.7 makes this test a requirement, not a nicety:
 *
 *   "A log-redaction middleware applies a deny-list before any transport, and a
 *    unit test asserts that a payload containing each forbidden key is redacted."
 *
 * The reason it must be a test is that redaction fails silently. A mistyped path
 * does not throw — pino simply does not redact it, the log line looks normal, and
 * nobody notices until a password appears in the log pipeline. So every key is
 * asserted individually rather than sampling one and trusting the config.
 *
 * Secrets are written to an in-memory stream instead of stdout, so the assertions
 * read exactly what the transport would have received.
 */
function captureLogs(write: (logger: Logger) => void): string {
  const lines: string[] = [];
  const stream = {
    write: (line: string): void => {
      lines.push(line);
    },
  };

  const logger = pino(
    {
      level: "info",
      redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACTION_CENSOR },
    },
    stream,
  );

  write(logger);
  return lines.join("\n");
}

const SECRET = "super-secret-value-that-must-never-appear";

describe("log redaction (SAD §13.7)", () => {
  it.each(SENSITIVE_LOG_KEYS)("redacts a top-level %s", (key) => {
    const output = captureLogs((logger) =>
      logger.info({ [key]: SECRET }, "test"),
    );

    expect(output).toContain(LOG_REDACTION_CENSOR);
    expect(output).not.toContain(SECRET);
  });

  it.each(SENSITIVE_LOG_KEYS)("redacts %s nested under req.body", (key) => {
    const output = captureLogs((logger) =>
      logger.info({ req: { body: { [key]: SECRET } } }, "test"),
    );

    expect(output).not.toContain(SECRET);
  });

  it("redacts the authorization and cookie headers", () => {
    const output = captureLogs((logger) =>
      logger.info(
        {
          req: {
            headers: {
              authorization: `Bearer ${SECRET}`,
              cookie: `session=${SECRET}`,
              "x-api-key": SECRET,
              // A header that is not sensitive must survive, or the redaction is
              // over-broad and destroys the diagnosis the log exists for.
              "user-agent": "ses-mobile/1.0",
            },
          },
        },
        "test",
      ),
    );

    expect(output).not.toContain(SECRET);
    expect(output).toContain("ses-mobile/1.0");
  });

  it("keeps the correlation fields a log line is read for", () => {
    const output = captureLogs((logger) =>
      logger.info({ requestId: "req-1", statusCode: 404 }, "test"),
    );

    expect(output).toContain("req-1");
    expect(output).toContain("404");
  });

  it("covers a nested form for every deny-listed key, not just the bare one", () => {
    // Guards the generation of the path list: a key added to SENSITIVE_LOG_KEYS
    // without its `req.body.` variant would be redacted at the top level and leak
    // from a request log.
    for (const key of SENSITIVE_LOG_KEYS) {
      expect(LOG_REDACT_PATHS).toContain(key);
      expect(LOG_REDACT_PATHS).toContain(`req.body.${key}`);
    }
  });
});
