import type { ApiIndex } from './declaration-index.js';
import type { LuaApiIdDomain, LuaApiKnowledge } from '../lua/source-index.js';

function normalizedParameterName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

/**
 * 官方 API 中不同名字都可能以 Id/UID 结尾，但它们不属于同一种台账。
 * 这里仅按参数名做“域分类”，不会把未知参数提升为场景实例。
 */
export function classifyApiIdDomain(parameterName: string): LuaApiIdDomain | null {
  const name = normalizedParameterName(parameterName);
  if (!/(?:id|uid)$/u.test(name)) return null;
  if (/(?:signalbox|triggerbox|logicelement|elementinstance|element)/u.test(name)) {
    return name.includes('type') ? 'element-type' : 'scene-instance';
  }
  if (/(?:instance)/u.test(name)) return 'scene-instance';
  if (/(?:player|user|role)/u.test(name)) return 'player';
  if (/(?:character)/u.test(name)) return 'character';
  if (/(?:scenelayer|layer)/u.test(name)) return 'scene-layer';
  if (/(?:group)/u.test(name)) return 'scene-group';
  if (/(?:item|goods|product)/u.test(name)) return 'item';
  if (/(?:control|widget|button|ui)/u.test(name)) return 'ui-control';
  if (/(?:creature|npc)/u.test(name)) return 'creature';
  if (/(?:prop)/u.test(name)) return 'prop';
  if (/(?:image|icon|texture)/u.test(name)) return 'image';
  if (/(?:effect|particle)/u.test(name)) return 'effect';
  if (/(?:camera)/u.test(name)) return 'camera';
  if (/(?:audio|sound|music)/u.test(name)) return 'audio';
  if (/(?:model)/u.test(name)) return 'model';
  if (/(?:resource|asset)/u.test(name)) return 'resource';
  return 'unknown';
}

function isSignalNameParameter(parameterName: string): boolean {
  const name = normalizedParameterName(parameterName);
  return /^(?:signal|signalname|signalkey|event|eventname|eventkey)$/u.test(name);
}

export function buildLuaApiKnowledge(index: ApiIndex): LuaApiKnowledge {
  return {
    calls: index.declarations.map((declaration) => ({
      qualifiedName: `${declaration.module}${declaration.callStyle === 'colon' ? ':' : '.'}${declaration.name}`,
      idParameterDomains: declaration.params.flatMap((parameter, parameterIndex) => {
        const domain = classifyApiIdDomain(parameter.name);
        return domain === null ? [] : [{ parameterIndex, domain }];
      }),
      signalParameterIndexes: declaration.params.flatMap((parameter, parameterIndex) => (
        isSignalNameParameter(parameter.name) ? [parameterIndex] : []
      )),
    })),
    configuredIdFields: [],
  };
}
