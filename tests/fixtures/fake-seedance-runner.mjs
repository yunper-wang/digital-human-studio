// 伪 Seedance 工具链：模拟 tool-vault 入口，按真实 runner 约定输出事件行并落 final_report.json
// 用法：node fake-seedance-runner.mjs run seedance2 -- <任意参数，含 --out-dir>
// 环境变量 FAKE_RUNNER_MODE=fail 时模拟生成失败（退出码 1 + failed 报告）
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outDir = args[args.indexOf("--out-dir") + 1];
const fail = process.env.FAKE_RUNNER_MODE === "fail";
mkdirSync(outDir, { recursive: true });

console.log(JSON.stringify({ phase: "submitted_once", task_id: "fake-task-1" }));
console.log(JSON.stringify({ phase: "poll", status: "running" }));
console.log(JSON.stringify({ phase: "poll", status: "running" }));

if (fail) {
  writeFileSync(`${outDir}/final_report.json`, JSON.stringify({ status: "failed", task_id: "fake-task-1" }));
  process.exit(1);
}

const videoPath = `${outDir}/fake-video.mp4`;
writeFileSync(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])); // 伪 mp4 头
writeFileSync(`${outDir}/final_report.json`, JSON.stringify({
  status: "succeeded",
  task_id: "fake-task-1",
  video_path: videoPath,
  balance_before: { wallet_balance: 10 },
  balance_after: { wallet_balance: 9 },
  deducted_points: 1
}));
