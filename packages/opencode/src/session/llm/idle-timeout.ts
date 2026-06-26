import { Effect, Stream } from "effect"

/**
 * Watchdog that fires `onIdle` when a stream emits nothing for `timeoutMs`.
 *
 * Motivation: an LLM provider's HTTP stream can stall — TCP connection alive,
 * no data, no error, no close. Without a watchdog the await hangs forever (in a
 * workflow, up to the 12h script deadline), stalling any parallel/pipeline
 * barrier waiting on it. A slow-but-progressing agent (tokens arriving
 * continuously) keeps re-arming the timer and is never interrupted; only a
 * genuinely idle connection trips it.
 *
 * The timer arms when consumption begins (scope acquire), re-arms on every
 * emitted value, and is cleared when the stream ends (success, error, or
 * interruption). `onIdle` is expected to abort the underlying source so the
 * stream actually terminates — this helper only detects idleness.
 *
 * `options.suppress`, when it returns `true`, marks the current quiet period as
 * expected (e.g. a tool is executing, so the provider connection is idle by
 * design). The watchdog then re-arms instead of firing `onIdle`, so legitimate
 * long-running tool execution is never mistaken for a stalled connection.
 */
export function withIdleTimeout<A, E, R>(
  self: Stream.Stream<A, E, R>,
  timeoutMs: number,
  onIdle: () => void = () => {},
  options?: { suppress?: () => boolean },
): Stream.Stream<A, E, R> {
  const suppressed = options?.suppress ?? (() => false)
  return Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        let timer: ReturnType<typeof setTimeout> | undefined
        const arm = () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(fire, timeoutMs)
        }
        // A suppressed quiet period is expected (a tool is executing); re-arm
        // and keep waiting rather than aborting a connection that is idle by design.
        const fire = () => {
          if (timer === undefined) return
          timer = undefined
          if (suppressed()) {
            arm()
            return
          }
          onIdle()
        }
        const disarm = () => {
          if (timer) {
            clearTimeout(timer)
            timer = undefined
          }
        }
        yield* Effect.acquireRelease(Effect.sync(arm), () => Effect.sync(disarm))
        return self.pipe(Stream.tap(() => Effect.sync(arm)))
      }),
    ),
  )
}
