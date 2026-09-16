export const PRIVATE_RELEASE_RESULT = Object.freeze({
  schemaVersion: 1,
  ok: false,
  code: 'NPM_DISTRIBUTION_DISABLED',
  message: '此旧入口仅保留 npm 发布阻断；MIT 源码导出与 Marketplace VSIX 请使用 npm run package:release。',
});

export function refusePublicRelease(options = {}) {
  const json = options.json === true;
  const rendered = json
    ? `${JSON.stringify(PRIVATE_RELEASE_RESULT)}\n`
    : `${PRIVATE_RELEASE_RESULT.code}: ${PRIVATE_RELEASE_RESULT.message}\n`;
  if (json) process.stdout.write(rendered);
  else process.stderr.write(rendered);
  process.exitCode = 1;
  return PRIVATE_RELEASE_RESULT;
}
