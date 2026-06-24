import { afterEach, describe, expect, test } from "bun:test"
import { Logging } from "@opencode-ai/core/observability/logging"

const saved = process.env.OPENCODE_PRINT_LOGS

afterEach(() => {
  if (saved === undefined) delete process.env.OPENCODE_PRINT_LOGS
  else process.env.OPENCODE_PRINT_LOGS = saved
})

describe("loggers", () => {
  test("returns only fileLogger when OPENCODE_PRINT_LOGS is unset", () => {
    delete process.env.OPENCODE_PRINT_LOGS
    expect(Logging.loggers()).toHaveLength(1)
  })

  test("returns fileLogger + stderrLogger when OPENCODE_PRINT_LOGS=1", () => {
    process.env.OPENCODE_PRINT_LOGS = "1"
    expect(Logging.loggers()).toHaveLength(2)
  })

  test("returns only fileLogger after suppressStderrLogger even with OPENCODE_PRINT_LOGS=1", () => {
    process.env.OPENCODE_PRINT_LOGS = "1"
    Logging.suppressStderrLogger()
    expect(Logging.loggers()).toHaveLength(1)
  })

  test("fileLogger is always present", () => {
    delete process.env.OPENCODE_PRINT_LOGS
    expect(Logging.loggers()[0]).toBeDefined()
    process.env.OPENCODE_PRINT_LOGS = "1"
    expect(Logging.loggers()[0]).toBeDefined()
  })
})
