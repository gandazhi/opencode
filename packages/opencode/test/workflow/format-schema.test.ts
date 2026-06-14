import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"

describe("workflow format schema regression", () => {
  // Regression: workflow runtime builds `{ type: "json_schema", schema: ... }`
  // as a plain object and passes it to PromptInput.format. Effect Schema's
  // nominal OutputFormatJsonSchema class guard rejects plain objects, so the
  // agent's structured-output prompt failed at publish time with
  // "Expected OutputFormatJsonSchema, got {...}". The fix decodes the plain
  // object via Schema.decodeSync(SessionV1.Format) first.
  it("decodes a plain json_schema object into a valid Format instance", () => {
    const plain = {
      type: "json_schema" as const,
      schema: {
        type: "object",
        required: ["question", "lines"],
        properties: { question: { type: "string" }, lines: { type: "array" } },
      },
    }
    const decoded = Schema.decodeSync(SessionV1.Format)(plain)
    // The decoded instance must pass the nominal class guard that rejected the
    // plain object (this is the exact check that failed in production).
    expect(Schema.is(SessionV1.OutputFormatJsonSchema)(decoded)).toBe(true)
    expect(Schema.is(SessionV1.OutputFormatJsonSchema)(plain)).toBe(false)
  })

  it("rejects an unknown format type", () => {
    expect(() => Schema.decodeSync(SessionV1.Format)({ type: "xml", schema: {} } as never)).toThrow()
  })
})
