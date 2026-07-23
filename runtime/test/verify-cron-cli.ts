/**
 * 端到端验证：cron add CLI 子命令真能从命令行跑通
 *
 * 不通过 shell，直接模拟 process.argv 调 main()
 * 运行：node --import tsx scripts/verify-cron-cli.ts
 */

import { resolve } from 'node:path';

// 模拟 argv: awkn-engine cron add --name=... --cron=... --type=http --payload={...}
process.argv = [
  process.argv0,
  'src/cli.ts',
  'cron', 'add',
  '--name=每小时健康检查',
  '--cron=0 * * * *',
  '--type=http',
  '--payload={"url":"http://localhost:9000/health","method":"GET"}',
];

await import('../src/cli.js').catch(async () => {
  // cli.ts 不是 .js，tsx 直接 import 会失败；用 dynamic import + .ts 后缀
  await import('../src/cli.ts');
});

// 如果 cli.ts 自己调 process.exit，下面不会跑
console.log('done');
