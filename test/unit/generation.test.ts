import { describe, expect, it } from 'vitest';

import type { ApiIndex } from '../../src/core/api/declaration-index.js';
import { generateLua, type GenerateLuaRequest } from '../../src/core/generation/templates.js';
import type { RegistryDocument, RegistryRecord } from '../../src/core/model.js';

const projectInstanceId = '00000000-0000-4000-8000-000000000902';

function record(recordId: string, kind: RegistryRecord['kind'], value: string): RegistryRecord {
  return {
    recordId,
    kind,
    name: recordId,
    value,
    scope: 'workspace',
    projectInstanceId,
    mapFingerprint: null,
    layerId: null,
    environment: 'test',
    validity: 'confirmed',
    source: {
      kind: 'user-entry',
      relativePath: null,
      sha256: 'a'.repeat(64),
      observedAt: '2026-08-20T00:00:00.000Z',
      officialExtensionVersion: null,
      evidence: 'UNIT_E2E',
    },
    lastConfirmedAt: '2026-08-20T00:00:00.000Z',
    notes: '',
  };
}

const registry: RegistryDocument = {
  schemaVersion: 1,
  records: [
    record('experience_label', 'ui-control', '41001'),
    record('round_started', 'signal', 'round_started'),
  ],
};

function declaration(module: string, name: string, params: string[]) {
  return {
    key: `${module}:colon:${name}`,
    module,
    name,
    callStyle: 'colon' as const,
    description: '',
    signature: `${module}:${name}(${params.join(', ')})`,
    params: params.map((param) => ({ name: param, type: param === 'Visible' ? 'boolean' : 'string', description: '' })),
    returns: [],
    officialExtensionVersion: '9.9.9-test',
    source: { relativePath: `res/lib/${module}.d.lua`, sha256: 'b'.repeat(64) },
  };
}

const api: ApiIndex = {
  schemaVersion: 1,
  officialExtensionVersion: '9.9.9-test',
  declarations: [
    declaration('UI', 'RegisterButton', ['WidgetId', 'Handler']),
    declaration('UI', 'SetVisible', ['WidgetId', 'Visible']),
    declaration('UI', 'SetText', ['WidgetId', 'Text']),
    declaration('Signal', 'Send', ['SignalName']),
    declaration('Signal', 'Listen', ['SignalName', 'Handler']),
  ],
};

const common = {
  projectInstanceId,
  mapFingerprint: null,
  targetPath: 'src/Generated.lua',
  existingContent: 'local Generated = {}\n',
  multiplayer: false,
  playerRoutingEvidence: 'not-required' as const,
  createdAt: '2026-08-20T00:00:00.000Z',
};

describe('API-backed Lua generation', () => {
  it('refuses absent signatures, unconfirmed player routing and unconfirmed records', () => {
    const request: GenerateLuaRequest = {
      ...common,
      kind: 'visibility',
      recordId: 'experience_label',
      visible: true,
      api: { module: 'UI', name: 'SetVisible', callStyle: 'colon' },
    };
    expect(() => generateLua(request, { ...api, declarations: [] }, registry)).toThrowError(
      expect.objectContaining({ code: 'API_NOT_FOUND' }),
    );
    expect(() => generateLua({ ...request, multiplayer: true, playerRoutingEvidence: 'none' }, api, registry)).toThrowError(
      expect.objectContaining({ code: 'PLAYER_ROUTING_UNCONFIRMED' }),
    );
    const pendingRegistry: RegistryDocument = {
      schemaVersion: 1,
      records: registry.records.map((item) => ({ ...item, validity: 'pending' })),
    };
    expect(() => generateLua(request, api, pendingRegistry)).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it.each<GenerateLuaRequest>([
    { ...common, kind: 'constants', recordIds: ['experience_label', 'round_started'] },
    { ...common, kind: 'config', recordIds: ['experience_label'] },
    { ...common, kind: 'button-handler', recordId: 'experience_label', handlerExpression: 'handlers.onExperience', api: { module: 'UI', name: 'RegisterButton', callStyle: 'colon' } },
    { ...common, kind: 'visibility', recordId: 'experience_label', visible: true, api: { module: 'UI', name: 'SetVisible', callStyle: 'colon' } },
    { ...common, kind: 'text-refresh', recordId: 'experience_label', text: 'Ready', api: { module: 'UI', name: 'SetText', callStyle: 'colon' } },
    { ...common, kind: 'signal-send', recordId: 'round_started', api: { module: 'Signal', name: 'Send', callStyle: 'colon' } },
    { ...common, kind: 'signal-listen', recordId: 'round_started', handlerExpression: 'handlers.onRoundStarted', api: { module: 'Signal', name: 'Listen', callStyle: 'colon' } },
  ])('creates a preview-only $kind proposal from selected values', (request) => {
    const proposal = generateLua(request, api, registry);

    expect(proposal.targetPath).toBe('src/Generated.lua');
    expect(proposal.originalContent).toBe(common.existingContent);
    expect(proposal.newContent).not.toBe(common.existingContent);
    expect(proposal.newSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(proposal.summary).toContain(request.kind);
    expect(proposal.newContent).toContain('environment=test');
  });
});
