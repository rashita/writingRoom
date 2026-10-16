import assert from 'node:assert/strict';
import { runNamedTask, showTaskLog } from '../src/named-tasks.js';

// Only the result window surface is needed to exercise the execution lifecycle.
let current;
class Dialog {
    dataset = {};
    open = false;
    nodes = new Map();
    listeners = {};
    querySelector(selector) {
        if (!this.nodes.has(selector)) this.nodes.set(selector, { textContent: '', hidden: false, disabled: false });
        return this.nodes.get(selector);
    }
    addEventListener(event, listener) { this.listeners[event] = listener; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    remove() { if (current === this) current = undefined; }
}
globalThis.document = {
    querySelector: selector => selector === '#run-task-dialog' ? current : null,
    createElement: () => new Dialog(),
    body: { append(dialog) { current = dialog; } },
};
const task = { id: 'pdf', label: 'PDFを作る', command: 'make pdf' };
let output, openError, calls, statuses;
function reset(overrides = {}) {
    current = undefined;
    output = { success: true, code: 0, stdout: 'built', stderr: '', output: 'Build/book.pdf', auto_open: false, output_error: null, ...overrides };
    openError = null;
    calls = [];
    statuses = [];
}
async function invoke(name, args) {
    calls.push([name, args]);
    if (name === 'get_named_tasks') return [task];
    if (name === 'run_named_task') return output;
    if (name === 'open_task_output' && openError) throw new Error(openError);
}
const status = text => statuses.push(text);
const prepare = async () => { calls.push(['save']); };
const openInApp = async path => {
    calls.push(['open-in-app', { path }]);
    if (openError) throw new Error(openError);
};
const run = () => runNamedTask({ invoke, status, prepare, id: task.id, openInApp });

reset();
await run();
assert.deepEqual(calls.map(([name]) => name), ['get_named_tasks', 'save', 'run_named_task']);
assert.equal(current.open, true);
assert.equal(current.querySelector('.task-open-output').hidden, false);
await current.querySelector('.task-open-output').onclick();
assert.deepEqual(calls.at(-1), ['open-in-app', { path: 'Build/book.pdf' }]);
assert.equal(current, undefined, 'manual internal open closes the result window');

reset({ open_external: true });
await run();
await current.querySelector('.task-open-output').onclick();
assert.deepEqual(calls.at(-1), ['open_task_output', { path: 'Build/book.pdf' }]);
assert.equal(current.open, true);

reset({ auto_open: true });
await run();
assert.equal(current, undefined, 'auto-open success closes the result window');
assert.equal(calls.at(-1)[0], 'open-in-app');
showTaskLog({ invoke, status, openInApp });
assert.match(current.querySelector('pre').textContent, /built/);
assert.match(current.querySelector('[role="status"]').textContent, /成果物を開きました/);

reset({ auto_open: true, open_external: true });
await run();
assert.equal(current, undefined);
assert.equal(calls.at(-1)[0], 'open_task_output');

reset({ auto_open: true });
openError = 'no application';
await run();
assert.equal(current.open, true);
assert.match(current.querySelector('[role="status"]').textContent, /no application/);

for (const result of [
    { success: false, code: 2 },
    { output_error: '成果物が見つかりません' },
]) {
    reset({ auto_open: true, ...result });
    await run();
    assert.equal(current.open, true);
    assert.equal(calls.some(([name]) => name === 'open_task_output' || name === 'open-in-app'), false);
    assert.equal(current.querySelector('.task-open-output').disabled, true);
}

reset({ output: '', stdout: 'x'.repeat(200100) });
await run();
assert.equal(current.querySelector('.task-open-output').hidden, true);
assert.ok(current.querySelector('pre').textContent.length < 200200);
assert.match(current.querySelector('pre').textContent, /省略/);

reset();
await runNamedTask({ invoke, status, prepare: async () => { throw new Error('save failed'); }, id: task.id });
assert.equal(calls.some(([name]) => name === 'run_named_task'), false);
showTaskLog({ invoke, status, openInApp });
assert.match(current.querySelector('pre').textContent, /save failed/);
console.log('Named command output and log checks passed');
