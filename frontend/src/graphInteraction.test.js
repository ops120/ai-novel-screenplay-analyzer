import test from 'node:test';
import assert from 'node:assert/strict';
import { bindGraphSelection } from './graphInteraction.js';

function createFakeGraph() {
  const listeners = new Map();
  const calls = { on: 0, off: 0 };
  return {
    on(event, handler) {
      calls.on += 1;
      listeners.set(event, handler);
    },
    off(event, handler) {
      calls.off += 1;
      if (listeners.get(event) === handler) listeners.delete(event);
    },
    emit(event, payload) {
      listeners.get(event)?.(payload);
    },
    listener(event) {
      return listeners.get(event);
    },
    calls,
  };
}

test('bindGraphSelection dispatches string node ids and canvas deselection', () => {
  const graph = createFakeGraph();
  const selections = [];

  bindGraphSelection(graph, value => selections.push(value));
  graph.emit('node:click', { item: { getModel: () => ({ id: 42 }) } });
  graph.emit('canvas:click');

  assert.deepEqual(selections, ['42', null]);
});

test('cleanup precisely removes the handlers it registered', () => {
  const graph = createFakeGraph();
  const selections = [];
  const cleanup = bindGraphSelection(graph, value => selections.push(value));
  const nodeHandler = graph.listener('node:click');
  const canvasHandler = graph.listener('canvas:click');

  cleanup();

  assert.equal(graph.listener('node:click'), undefined);
  assert.equal(graph.listener('canvas:click'), undefined);
  nodeHandler({ item: { getModel: () => ({ id: 7 }) } });
  canvasHandler();
  assert.deepEqual(selections, ['7', null]);
});

test('missing callback is a safe no-op and binds nothing', () => {
  const graph = createFakeGraph();
  const cleanup = bindGraphSelection(graph);

  assert.doesNotThrow(cleanup);
  assert.equal(graph.listener('node:click'), undefined);
  assert.equal(graph.listener('canvas:click'), undefined);
  assert.deepEqual(graph.calls, { on: 0, off: 0 });
});
