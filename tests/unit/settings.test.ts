import { afterEach, describe, expect, it, vi } from 'vitest';

/** Load the settings module fresh against a fake localStorage holding `saved`. */
async function load(saved: object | null) {
  const store = new Map<string, string>();
  if (saved) store.set('pt_settings', JSON.stringify(saved));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  vi.resetModules();
  const mod = await import('../../src/lib/settings');
  return { S: mod.getS(), stored: JSON.parse(store.get('pt_settings') ?? 'null'), mod };
}

afterEach(() => vi.unstubAllGlobals());

describe('settings migrations (new defaults reach people who never changed the old ones)', () => {
  it('moves old defaults to the new ones', async () => {
    const { S, stored } = await load({ kZoom: 170, traceSmoothMs: 80, tol: 35 });
    expect(S.kZoom).toBe(260);
    expect(S.traceSmoothMs).toBe(120);
    expect(stored._v).toBe(1);
  });

  it("leaves values the user chose", async () => {
    const { S } = await load({ kZoom: 200, traceSmoothMs: 150 });
    expect(S.kZoom).toBe(200);
    expect(S.traceSmoothMs).toBe(150);
  });

  it('does not re-run on later loads (a user can go back to the old value)', async () => {
    const { S } = await load({ kZoom: 170, _v: 1 });
    expect(S.kZoom).toBe(170);
  });

  it('uses the defaults when nothing is saved', async () => {
    const { S, mod } = await load(null);
    expect(S).toEqual(mod.DEFAULTS);
  });
});
