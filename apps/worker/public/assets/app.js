// Dashboard shell (plan M4). It calls the same /api/v1 as every other client; the session
// cookie authenticates it, and the custom header keeps other sites from making these calls.

const root = document.getElementById('app');

async function api(path, options = {}) {
  const res = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      'x-airstock-request': '1',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    credentials: 'same-origin',
  });
  const body = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(body?.title || `Request failed (${res.status})`);
  return body;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'onclick' || key === 'onsubmit') node[key] = value;
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function showError(error) {
  root.prepend(el('p', { class: 'error' }, error.message));
}

async function renderShops() {
  const { shops } = await api('/shops');
  root.replaceChildren();
  if (shops.length === 0) {
    root.append(el('p', {}, 'You have no shop yet. Create one to start.'));
  } else {
    root.append(el('h2', {}, 'Your shops'));
    const list = el('div', { class: 'table-wrap' });
    const table = el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', {}, 'Shop'), el('th', {}, 'Role'), el('th', {}, '')])),
    ]);
    const tbody = el('tbody');
    for (const shop of shops) {
      tbody.append(
        el('tr', {}, [
          el('td', {}, shop.name),
          el('td', {}, shop.role),
          el('td', {}, [
            el(
              'button',
              { class: 'small', onclick: () => renderConnections(shop) },
              'AI connections',
            ),
            ' ',
            el('button', { class: 'small', onclick: () => renderShopify(shop) }, 'Shopify'),
            ' ',
            el('button', { class: 'small', onclick: () => renderMembers(shop) }, 'Members'),
          ]),
        ]),
      );
    }
    table.append(tbody);
    list.append(table);
    root.append(list);
  }
  root.append(createShopForm());
}

function createShopForm() {
  const form = el('form', {}, [
    el('h2', {}, 'Create a shop'),
    el('label', {}, ['Shop name', el('input', { name: 'name', required: '', maxlength: '200' })]),
    el('label', {}, [
      'Currency',
      el('input', { name: 'currency', value: 'EUR', pattern: '[A-Z]{3}', maxlength: '3' }),
    ]),
    el('label', {}, [
      'Time zone',
      el('input', {
        name: 'timezone',
        value: Intl.DateTimeFormat().resolvedOptions().timeZone,
        maxlength: '64',
      }),
    ]),
    el('button', { type: 'submit' }, 'Create shop'),
  ]);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await api('/shops', { method: 'POST', body: JSON.stringify(data) });
      await renderShops();
    } catch (error) {
      showError(error);
    }
  };
  return form;
}

async function renderConnections(shop) {
  const { connections } = await api(`/shops/${shop.id}/connections`);
  root.replaceChildren(
    el('p', {}, el('button', { class: 'small', onclick: () => renderShops() }, '← All shops')),
    el('h2', {}, `Connections in ${shop.name}`),
  );
  if (connections.length === 0) {
    root.append(
      el(
        'p',
        { class: 'muted' },
        `No connections yet. Add ${root.dataset.mcpUrl} as a custom connector in ChatGPT.`,
      ),
    );
    return;
  }
  const tbody = el('tbody');
  for (const c of connections) {
    const revoke =
      c.status === 'active'
        ? el(
            'button',
            {
              class: 'small',
              onclick: async () => {
                try {
                  await api(`/shops/${shop.id}/connections/${c.grantId}/revoke`, {
                    method: 'POST',
                  });
                  await renderConnections(shop);
                } catch (error) {
                  showError(error);
                }
              },
            },
            'Revoke',
          )
        : '';
    tbody.append(
      el('tr', {}, [
        el('td', {}, c.clientName || c.clientId || 'Not used yet'),
        el('td', {}, c.scopes.join(', ')),
        el('td', {}, c.status),
        el('td', {}, new Date(c.createdAt).toLocaleString()),
        el('td', {}, revoke),
      ]),
    );
  }
  root.append(
    el(
      'div',
      { class: 'table-wrap' },
      el('table', {}, [
        el(
          'thead',
          {},
          el('tr', {}, [
            el('th', {}, 'Client'),
            el('th', {}, 'Access'),
            el('th', {}, 'Status'),
            el('th', {}, 'Created'),
            el('th', {}, ''),
          ]),
        ),
        tbody,
      ]),
    ),
  );
}

// Shopify (plan Section 8): connect a store to a shop, then map one Shopify location to one
// location and match variants by SKU.
async function renderShopify(shop) {
  const [{ connections }, { locations }] = await Promise.all([
    api(`/shops/${shop.id}/shopify/connections`),
    api(`/shops/${shop.id}/locations`),
  ]);
  root.replaceChildren(
    el('p', {}, el('button', { class: 'small', onclick: () => renderShops() }, '← All shops')),
    el('h2', {}, `Shopify in ${shop.name}`),
  );
  for (const c of connections) root.append(shopifyCard(shop, c, locations));
  const input = el('input', {
    name: 'shop',
    placeholder: 'my-store.myshopify.com',
    required: '',
    maxlength: '100',
  });
  const form = el('form', {}, [
    el('h3', {}, connections.length ? 'Connect another store' : 'Connect a Shopify store'),
    el('label', {}, ['Store address', input]),
    el(
      'p',
      { class: 'fine' },
      'Shopify asks you to approve access to products, inventory, locations, and orders. Airstock never reads customer details.',
    ),
    el('button', { type: 'submit' }, 'Connect store'),
  ]);
  form.onsubmit = (event) => {
    event.preventDefault();
    const params = new URLSearchParams({ shop_id: shop.id, shop: input.value.trim() });
    window.location.assign(`/shopify/install?${params}`);
  };
  root.append(form);
}

function shopifyCard(shop, c, locations) {
  const stockable = locations.filter((l) => l.holdsStockAllowed && l.status === 'active');
  const mapped = c.locationMap
    ? `${c.shopifyLocations.find((l) => l.id === c.locationMap.shopifyLocationId)?.name ?? c.locationMap.shopifyLocationId} → ${stockable.find((l) => l.locationId === c.locationMap.locationId)?.path ?? 'a location'}`
    : 'Not mapped yet';
  const webhooks = c.webhooks.length
    ? c.webhooks
        .map((w) => `${w.topic} ${w.status}${w.message ? ` (${w.message})` : ''}`)
        .join(', ')
    : 'none';
  const card = el('section', { class: 'card inset' }, [
    el('h3', {}, `${c.shopDomain} · ${c.status}`),
    el('p', { class: 'fine' }, `Webhooks: ${webhooks}`),
    el('p', {}, `Location: ${mapped}. Variants mapped: ${c.variantsMapped}.`),
    c.conflicts
      ? el(
          'p',
          { class: 'error' },
          `${c.conflicts} quantity difference(s) with Shopify that no order explains. Airstock left Shopify unchanged; map again to take Shopify's current quantity as the starting point.`,
        )
      : '',
    el(
      'p',
      { class: 'fine' },
      `Last webhook: ${c.lastWebhookAt ? new Date(c.lastWebhookAt).toLocaleString() : 'none yet'}`,
    ),
  ]);
  if (c.status !== 'active') return card;
  const shopifySelect = el(
    'select',
    { name: 'shopifyLocationId' },
    c.shopifyLocations.filter((l) => l.active).map((l) => el('option', { value: l.id }, l.name)),
  );
  const locationSelect = el(
    'select',
    { name: 'locationId' },
    stockable.map((l) => el('option', { value: l.locationId }, l.path)),
  );
  if (c.locationMap) {
    shopifySelect.value = c.locationMap.shopifyLocationId;
    locationSelect.value = c.locationMap.locationId;
  }
  const result = el('p', { class: 'fine' });
  const form = el('form', {}, [
    el('label', {}, ['Shopify location', shopifySelect]),
    el('label', {}, ['Airstock location', locationSelect]),
    el(
      'p',
      { class: 'fine' },
      "Variants are matched by SKU. Airstock then sets Shopify's available quantity at that location to Airstock's availability and keeps it in step.",
    ),
    el('button', { type: 'submit' }, c.locationMap ? 'Map again by SKU' : 'Map by SKU'),
    result,
  ]);
  form.onsubmit = async (event) => {
    event.preventDefault();
    result.textContent = 'Matching…';
    try {
      const res = await fetch(`/shopify/connections/${c.connectionId}/map`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-airstock-request': '1' },
        body: JSON.stringify({
          shopId: shop.id,
          locationId: locationSelect.value,
          shopifyLocationId: shopifySelect.value,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.title || `Request failed (${res.status})`);
      const notes = [];
      if (body.unmatchedShopify.length)
        notes.push(`no match for ${body.unmatchedShopify.join(', ')}`);
      if (body.untrackedShopify.length)
        notes.push(`not tracked in Shopify: ${body.untrackedShopify.join(', ')}`);
      await renderShopify(shop);
      showNotice(
        `Mapped ${body.variantsMapped} variant(s)${notes.length ? `; ${notes.join('; ')}` : ''}.`,
      );
    } catch (error) {
      result.textContent = '';
      showError(error);
    }
  };
  card.append(form);
  return card;
}

// Members and invitations (plan M4). The invited person accepts by signing in with the
// invited email address.
async function renderMembers(shop) {
  const { members, invitations } = await api(`/shops/${shop.id}/members`);
  root.replaceChildren(
    el('p', {}, el('button', { class: 'small', onclick: () => renderShops() }, '← All shops')),
    el('h2', {}, `Members of ${shop.name}`),
  );
  const rows = [
    ...members.map((m) =>
      el('tr', {}, [el('td', {}, m.email), el('td', {}, m.role), el('td', {}, m.status)]),
    ),
    ...invitations.map((i) =>
      el('tr', {}, [
        el('td', {}, i.email),
        el('td', {}, i.role),
        el('td', {}, `invited${i.emailSentAt ? ', email sent' : ''} (${i.status})`),
      ]),
    ),
  ];
  root.append(
    el(
      'div',
      { class: 'table-wrap' },
      el('table', {}, [
        el(
          'thead',
          {},
          el('tr', {}, [el('th', {}, 'Email'), el('th', {}, 'Role'), el('th', {}, 'Status')]),
        ),
        el('tbody', {}, rows),
      ]),
    ),
  );
  const email = el('input', { name: 'email', type: 'email', required: '', maxlength: '320' });
  const role = el(
    'select',
    { name: 'role' },
    [
      ['viewer', 'Viewer'],
      ['inventory_operator', 'Inventory operator'],
      ['catalog_editor', 'Catalog editor'],
      ['manager', 'Manager'],
    ].map(([value, label]) => el('option', { value }, label)),
  );
  const form = el('form', {}, [
    el('h3', {}, 'Invite someone'),
    el('label', {}, ['Email', email]),
    el('label', {}, ['Role', role]),
    el('button', { type: 'submit' }, 'Send invitation'),
  ]);
  form.onsubmit = async (event) => {
    event.preventDefault();
    try {
      await api(`/shops/${shop.id}/invitations`, {
        method: 'POST',
        headers: { 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({ email: email.value, role: role.value }),
      });
      await renderMembers(shop);
      showNotice(`Invitation sent to ${email.value}.`);
    } catch (error) {
      showError(error);
    }
  };
  root.append(form);
}

function showNotice(message) {
  root.prepend(el('p', { class: 'notice' }, message));
}

const connected = new URLSearchParams(window.location.search).get('shopify');
renderShops()
  .then(() => {
    if (connected) showNotice('Shopify store connected. Open Shopify on the shop to map it.');
    if (new URLSearchParams(window.location.search).get('joined')) {
      showNotice('Invitation accepted. The shop is now in your list.');
    }
  })
  .catch(showError);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
