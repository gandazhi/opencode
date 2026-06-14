export const meta = {
  name: "hello-world",
  description: "最简 workflow 示例：演示 if/else 分支 + for 循环",
  whenToUse: "学习 workflow 语法时使用",
  phases: [
    { title: "Decide", detail: "根据 args 决定走哪条分支" },
    { title: "Loop", detail: "循环派发子 agent" },
  ],
}

phase("Decide")

// args 是启动时传入的任意 JSON 值；这里取 count 和 mode
const count = (args && args.count) ? Number(args.count) : 3
const mode = (args && args.mode === "fast") ? "fast" : "normal"

log("hello from workflow! count=" + count + " mode=" + mode)

let prefix
if (mode === "fast") {
  prefix = "[fast] "
} else {
  prefix = "[normal] "
}

phase("Loop")

const greetings = []
for (let i = 0; i < count; i++) {
  const msg = prefix + "step " + (i + 1)
  const reply = await agent("用一句中文回复这句话：" + msg, {
    label: "greet-" + (i + 1),
    phase: "Loop",
  })
  greetings.push(reply)
}

log("done, got " + greetings.length + " replies")

return {
  mode: mode,
  greetings: greetings,
}
