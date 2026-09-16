// This hook only guards npm publish; Marketplace and MIT source releases are supported.
process.stderr.write('本项目通过 Marketplace/VSIX 和 GitHub 分发，不发布 npm 包。请运行 npm run package:release。\n');
process.exitCode = 1;
