// Dependency-free smoke checks for the static demo's view and local copilot logic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(match, 'inline application script exists');

const elements = new Map();
const storage = {};
let activeModal = null;
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', onclick: null, oninput: null, onchange: null, onkeydown: null, classList: { add: () => {}, remove: () => {} } });
  return elements.get(id);
};
const context = vm.createContext({
  console,
  Date,
  Math,
  JSON,
  Number,
  String,
  Array,
  Object,
  structuredClone,
  localStorage: { getItem: (key) => storage[key] ?? null, setItem: (key, value) => { storage[key] = value; } },
  setTimeout: () => 0,
  document: {
    getElementById: element,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => {
      const controls = new Map();
      return {
        className: '', innerHTML: '',
        querySelector: (selector) => {
          if (!controls.has(selector)) controls.set(selector, { onclick: null });
          return controls.get(selector);
        },
        remove: () => {},
      };
    },
    body: { append: (modal) => { activeModal = modal; } },
  },
});
vm.runInContext(match[1], context, { filename: 'index.html:inline-script' });

const content = element('content').innerHTML;
assert.match(content, /航空供应链经营总览/);
assert.match(content, /SUPPLY/);
for (const next of ['supply', 'siaNdc', 'pricing', 'trading', 'finance', 'copilot']) {
  vm.runInContext(`page = '${next}'; render()`, context);
  assert.ok(element('content').innerHTML.length > 250, `${next} page renders`);
}
vm.runInContext("page = 'siaNdc'; render()", context);
assert.match(element('content').innerHTML, /调用 AirShopping/);
assert.match(element('content').innerHTML, /不创建订单、不支付、不出票/);
vm.runInContext(`page = 'pricing'; render(); runAsk('PEK 到 KIX 哪个报价含行李后最划算？')`, context);
assert.match(element('content').innerHTML, /统一报价列表/);
assert.match(element('trace').innerHTML, /CompareOffers/);
assert.match(vm.runInContext('chat[1].text', context), /当前最便宜的基础报价/);
assert.equal(vm.runInContext("quote(offers[0]) > offers[0].base + offers[0].fee", context), true);
vm.runInContext("book('OF-78022')", context);
assert.ok(activeModal, 'booking requires a confirmation dialog');
const confirm = activeModal.querySelector('[data-confirm]');
confirm.onclick();
assert.equal(JSON.parse(storage['airbridge-orders']).length, 1, 'confirmed demo order is persisted locally');
vm.runInContext("page = 'finance'; render()", context);
assert.match(element('content').innerHTML, /AB-/);
process.stdout.write('PASS: overview, 5 modules, SIA NDC page, copilot, pricing, simulated order, and finance ledger\n');

