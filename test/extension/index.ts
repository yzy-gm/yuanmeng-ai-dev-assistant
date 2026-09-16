import { cliLauncherTests } from './cli-launcher.test.js';
import { buildCommandTests } from './build-command.test.js';
import { hostNoiseProbeTests } from './host-noise-probe.test.js';
import { gameplayTests } from './gameplay.test.js';
import { gameplayViewTests } from './gameplay-view.test.js';
import { languageFeatureTests } from './language-features.test.js';
import { m1UiTests } from './m1-ui.test.js';
import { officialSchemaGateTests } from './official-schema-gate.test.js';
import { patchConfirmationTests } from './patch-confirmation.test.js';
import { propertyCommandTests } from './property-command.test.js';
import { runtimeCapabilityTests } from './runtime-capabilities.test.js';
import { sceneProbeEvidenceTests } from './scene-probe-evidence.test.js';
import { sceneTreeTests } from './scene-tree.test.js';
import { sceneWorkflowViewTests } from './scene-workflow-views.test.js';
import { workflowTests } from './workflow.test.js';
import { mcpProviderDeliveryTests } from './mcp-provider-delivery.test.js';

export interface ExtensionTestCase {
  name: string;
  run(): Promise<void>;
}

export async function run(): Promise<void> {
  const filter = process.env.YMAI_EXTENSION_TEST_GREP;
  const pattern = filter === undefined || filter === '' ? null : new RegExp(filter, 'iu');
  const optionalHostNoiseProbes = process.env.YMAI_HOST_NOISE_PROBE === '1' ? hostNoiseProbeTests : [];
  const optionalSchemaGateTests = process.env.YMAI_OFFICIAL_SCHEMA_GATE_PROBE === '1'
    ? officialSchemaGateTests
    : [];
  const cases = [
    ...buildCommandTests,
    ...gameplayTests,
    ...gameplayViewTests,
    ...m1UiTests,
    ...languageFeatureTests,
    ...runtimeCapabilityTests,
    ...cliLauncherTests,
    ...patchConfirmationTests,
    ...propertyCommandTests,
    ...sceneProbeEvidenceTests,
    ...sceneTreeTests,
    ...sceneWorkflowViewTests,
    ...workflowTests,
    ...mcpProviderDeliveryTests,
    ...optionalHostNoiseProbes,
    ...optionalSchemaGateTests,
  ]
    .filter((testCase) => pattern === null || pattern.test(testCase.name));
  if (cases.length === 0) {
    throw new Error(`No Extension Host tests matched: ${filter ?? ''}`);
  }
  const failures: string[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run();
      console.log(`PASS ${testCase.name}`);
    } catch (error) {
      failures.push(`${testCase.name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      console.error(`FAIL ${testCase.name}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n\n'));
  }
}
