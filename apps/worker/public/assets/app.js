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
          el(
            'td',
            {},
            el('button', { class: 'small', onclick: () => renderConnections(shop) }, 'Connections'),
          ),
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

renderShops().catch(showError);
