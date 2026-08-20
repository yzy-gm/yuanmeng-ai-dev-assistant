const minimumMajor = 20;
const actual = process.versions.node;
const major = Number.parseInt(actual.split('.')[0] ?? '', 10);

if (!Number.isInteger(major) || major < minimumMajor) {
  process.stderr.write(`元梦 AI 开发助手的开发工具和独立 CLI 需要 Node.js >= ${minimumMajor}，当前为 ${actual}。\n`);
  process.exitCode = 1;
}
