// run.sh prefixes this file with `const config = {...}`.
const task = await taskSpace(config.spaceId);
const page = task.page('p1');
const fs = await import('node:fs/promises');
await fs.mkdir(config.artifactDir, { recursive: true });
const ensure = (value, message) => {
  if (!value) throw new Error(message);
};
let browserResult = null;

try {
  await page.goto(config.url);
  await page.waitForFunction(() => typeof window.quotaProviderPersistenceE2E?.run === 'function');
  browserResult = await page.evaluate(
    (input) => window.quotaProviderPersistenceE2E.run(input),
    {
      coreUrl: config.coreUrl,
      managementKey: config.managementKey,
      runId: `space-${config.spaceId}-${Date.now()}`,
    }
  );
  ensure(browserResult.passed, `quota persistence mismatch: ${JSON.stringify(browserResult)}`);
  ensure(browserResult.backend.devin.provider === 'devin', 'Devin backend record missing');
  ensure(browserResult.backend.meta.provider === 'meta', 'Meta backend record missing');
  ensure(browserResult.restored.devin.status === 'success', 'Devin store restore missing');
  ensure(browserResult.restored.meta.status === 'success', 'Meta store restore missing');

  const screenshot = `${config.artifactDir}/quota-provider-persistence.png`;
  const receipt = {
    passed: true,
    spaceId: task.spaceId,
    coreUrl: config.coreUrl,
    screenshot: null,
    screenshotError: null,
    result: browserResult,
  };
  await fs.writeFile(`${config.artifactDir}/result.json`, JSON.stringify(receipt, null, 2));
  try {
    await page.screenshot({ path: screenshot, fullPage: true });
    receipt.screenshot = screenshot;
  } catch (error) {
    receipt.screenshotError = error instanceof Error ? error.message : String(error);
  }
  await fs.writeFile(`${config.artifactDir}/result.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ artifact: `${config.artifactDir}/result.json`, ...receipt }));
  if (!config.keepOpen) await task.finish({ keep: [] });
} catch (error) {
  const receipt = {
    passed: false,
    spaceId: task.spaceId,
    coreUrl: config.coreUrl,
    error: error instanceof Error ? error.message : String(error),
    result: browserResult,
  };
  await fs.writeFile(`${config.artifactDir}/result.json`, JSON.stringify(receipt, null, 2));
  console.error(`Ego task space ${task.spaceId} retained for inspection`);
  throw error;
}
