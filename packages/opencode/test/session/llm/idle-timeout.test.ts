import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { withIdleTimeout } from "@/session/llm/idle-timeout"

// Builds a stream that emits `first` values quickly, then waits on the abort
// signal forever (simulating a hung LLM provider connection: TCP alive, no
// data, no error, no close).
function makeHungStream(emit: number[], ctrl: AbortController): Stream.Stream<number, Error> {
  const iter = async function* () {
    for (const v of emit) {
      await Bun.sleep(5)
      yield v
    }
    // "Hang": park until aborted. Never yields, never returns.
    await new Promise<void>((_, reject) => {
      ctrl.signal.addEventListener("abort", () => reject(new Error("aborted")))
    })
  }
  return Stream.fromAsyncIterable(iter(), (e) => (e instanceof Error ? e : new Error(String(e))))
}

describe("withIdleTimeout", () => {
  test("fires onIdle and ends a hung stream within the timeout window", async () => {
    const ctrl = new AbortController()
    let idleFired = false
    const hung = makeHungStream([1, 2, 3], ctrl)

    const wrapped = withIdleTimeout(hung, 80, () => {
      idleFired = true
      ctrl.abort()
    })

    const start = Date.now()
    await Effect.runPromise(wrapped.pipe(Stream.runDrain)).catch(() => {})
    const elapsed = Date.now() - start

    // Idle detected well under a sane bound (not the 12h script deadline).
    expect(idleFired).toBe(true)
    expect(elapsed).toBeLessThan(2000)
  })

  test("does not abort a stream that keeps emitting within the timeout", async () => {
    let idleFired = false
    // Emits one value every 20ms; idle timeout 200ms. Always busy.
    const slow = Stream.make(1, 2, 3, 4, 5).pipe(
      Stream.tap(() => Effect.sleep("20 millis")),
    )

    const wrapped = withIdleTimeout(slow, 200, () => {
      idleFired = true
    })

    const result = await Effect.runPromise(wrapped.pipe(Stream.runCollect))
    const values = Array.from(result)

    expect(values).toEqual([1, 2, 3, 4, 5])
    expect(idleFired).toBe(false)
  })

  test("clears the timer when the stream completes normally", async () => {
    let idleFired = false
    const quick = Stream.make(1, 2, 3).pipe(
      Stream.tap(() => Effect.sleep("5 millis")),
    )

    const wrapped = withIdleTimeout(quick, 500, () => {
      idleFired = true
    })
    await Effect.runPromise(wrapped.pipe(Stream.runCollect))

    // Wait past the idle window AFTER completion; the timer must have been
    // cleared so it never fires on a completed stream.
    await Bun.sleep(80)
    expect(idleFired).toBe(false)
  })

  test("does not fire onIdle while suppress() reports an expected quiet period", async () => {
    const ctrl = new AbortController()
    let idleFired = false
    // Emits one value then hangs: simulates a tool-call being emitted followed
    // by tool execution, during which the provider connection is quiet *by
    // design* (not stalled). The watchdog must not abort that window.
    const hung = makeHungStream([1], ctrl)

    const wrapped = withIdleTimeout(
      hung,
      60,
      () => {
        idleFired = true
        ctrl.abort()
      },
      { suppress: () => true },
    )

    const draining = Effect.runPromise(wrapped.pipe(Stream.runDrain)).catch(() => {})
    // Wait well past several timeout windows; suppress() must keep re-arming
    // instead of aborting.
    await Bun.sleep(220)
    expect(idleFired).toBe(false)

    // End the still-hung stream so the test can complete.
    ctrl.abort()
    await draining
  })

  test("fires onIdle once suppress() lifts and the stream is still hung", async () => {
    const ctrl = new AbortController()
    let idleFired = false
    let suppressed = true
    const hung = makeHungStream([1], ctrl)

    const wrapped = withIdleTimeout(
      hung,
      60,
      () => {
        idleFired = true
        ctrl.abort()
      },
      { suppress: () => suppressed },
    )

    const start = Date.now()
    const draining = Effect.runPromise(wrapped.pipe(Stream.runDrain)).catch(() => {})
    // Suppressed window: idle must not fire even past the timeout.
    await Bun.sleep(150)
    expect(idleFired).toBe(false)

    // Tool finishes — lift suppression. The still-hung stream should now trip
    // the watchdog within another window.
    suppressed = false
    await draining
    const elapsed = Date.now() - start

    expect(idleFired).toBe(true)
    expect(elapsed).toBeLessThan(2000)
  })
})
