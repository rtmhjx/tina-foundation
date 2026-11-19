import { afterEach, expect, it } from 'vitest';
import { providerModule, providerModules, registerProviderModules, removeProviderModule } from '../../src/providers/registry.ts';
import type { ProviderModule } from '../../src/providers/base.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(dispose => dispose()); });
const moduleFor = (id: string): ProviderModule => ({ ...providerModule('openai-responses-compat'), id, title: id });
function register(modules: ProviderModule[]): () => void {
  const dispose = registerProviderModules(modules);
  cleanups.push(dispose);
  return dispose;
}

it('withdraws owned modules in place, is idempotent and allows registration again in the same process', () => {
  const originalArray = providerModules;
  const first = moduleFor('fixture-registration-first');
  const second = moduleFor('fixture-registration-second');
  const dispose = register([first, second]);
  expect(providerModule(first.id)).toBe(first);
  expect(providerModule(second.id)).toBe(second);
  dispose();
  dispose();
  expect(providerModules).toBe(originalArray);
  expect(providerModules).not.toContain(first);
  expect(providerModules).not.toContain(second);
  expect(() => providerModule(first.id)).toThrow('Unknown provider module');
  register([first]);
  expect(providerModule(first.id)).toBe(first);
  expect(providerModules.filter(module => module === first)).toHaveLength(1);
});

it('validates the complete batch before exposing any provider when an ID conflicts', () => {
  const existing = moduleFor('fixture-registration-existing');
  const candidate = moduleFor('fixture-registration-candidate');
  register([existing]);
  expect(() => registerProviderModules([candidate, { ...existing }])).toThrow('已被占用');
  expect(providerModules).not.toContain(candidate);
  expect(() => providerModule(candidate.id)).toThrow('Unknown provider module');
  expect(() => registerProviderModules([candidate, candidate])).toThrow('已被占用');
  expect(providerModules).not.toContain(candidate);
});

it('restores the same module and array position when package removal fails', async () => {
  const module = moduleFor('fixture-registration-rollback');
  const dispose = register([module]);
  const index = providerModules.indexOf(module);
  await expect(removeProviderModule(module.id, async () => {
    expect(() => providerModule(module.id)).toThrow('Unknown provider module');
    expect(providerModules).not.toContain(module);
    throw new Error('Fixture removal failed');
  })).rejects.toThrow('Fixture removal failed');
  expect(providerModule(module.id)).toBe(module);
  expect(providerModules[index]).toBe(module);
  dispose();
  expect(providerModules).not.toContain(module);
});

it('an old owner cannot withdraw a replacement with the same ID', async () => {
  const first = moduleFor('fixture-registration-replaced');
  const disposeFirst = register([first]);
  await removeProviderModule(first.id, async () => 'removed');
  const replacement = { ...first, title: 'replacement' };
  register([replacement]);
  disposeFirst();
  expect(providerModule(first.id)).toBe(replacement);
  expect(providerModules).toContain(replacement);
});

it('failed asynchronous removal does not resurrect a module whose owner was disposed', async () => {
  const module = moduleFor('fixture-registration-disposed');
  const dispose = register([module]);
  let rejectRemoval!: (error: Error) => void;
  const removal = removeProviderModule(module.id, () => new Promise<string>((_resolve, reject) => { rejectRemoval = reject; }));
  dispose();
  rejectRemoval(new Error('Fixture removal failed'));
  await expect(removal).rejects.toThrow('Fixture removal failed');
  expect(providerModules).not.toContain(module);
  expect(() => providerModule(module.id)).toThrow('Unknown provider module');
});

it('failed asynchronous removal cannot overwrite a newer registration', async () => {
  const first = moduleFor('fixture-registration-concurrent');
  const disposeFirst = register([first]);
  let rejectRemoval!: (error: Error) => void;
  const removal = removeProviderModule(first.id, () => new Promise<string>((_resolve, reject) => { rejectRemoval = reject; }));
  const replacement = { ...first, title: 'replacement' };
  register([replacement]);
  disposeFirst();
  rejectRemoval(new Error('Fixture removal failed'));
  await expect(removal).rejects.toThrow('Fixture removal failed');
  expect(providerModule(first.id)).toBe(replacement);
  expect(providerModules).not.toContain(first);
});
