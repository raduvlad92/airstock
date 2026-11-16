import { expect, test } from '@playwright/test';

test('an owner creates a webhook, copies its secret, and sends a test', async ({ page }) => {
  await page.goto('/__e2e/login?email=e2e-webhooks@example.test');
  await page.getByLabel('Shop name').fill('Webhook shop');
  await page.getByRole('button', { name: 'Create shop' }).click();
  await expect(page.getByText('No products yet. Add one to start.')).toBeVisible();

  await page.getByRole('link', { name: 'Integrations' }).click();
  await page.getByRole('link', { name: 'Webhooks' }).click();
  await expect(page.getByText('No webhooks yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('n8n stock flow');
  await page.getByRole('textbox', { name: 'URL' }).fill('https://n8n.example.com/webhook/e2e-flow');
  // The checklist comes from the event-type registry.
  await expect(page.getByRole('checkbox', { name: /stock\.changed/ })).toBeChecked();
  await page.getByRole('checkbox', { name: /catalog\.item\.changed/ }).check();
  await expect(page.getByRole('checkbox', { name: /alert\.opened/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Create webhook' }).click();

  await expect(page.getByText(/It is shown only once/)).toBeVisible();
  const secret = await page.locator('.token-box code').textContent();
  expect(secret).toMatch(/^whsec_/);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'n8n stock flow' })).toBeVisible();

  await page.getByRole('button', { name: 'Send test' }).click();
  const log = page.getByRole('table', { name: 'Webhook deliveries' });
  await expect(log.getByText('delivered')).toBeVisible({ timeout: 10_000 });
  await expect(log.getByText('webhook.test')).toBeVisible();
  await expect(log.getByRole('cell', { name: '200' })).toBeVisible();

  const received = (await (await page.request.get('/__e2e/webhooks')).json()) as Array<{
    url: string;
    headers: Record<string, string>;
    body: string;
  }>;
  const hit = received.find((r) => r.url === 'https://n8n.example.com/webhook/e2e-flow');
  expect(hit?.headers['airstock-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  expect(JSON.parse(hit!.body)).toMatchObject({ type: 'webhook.test', test: true });
});
