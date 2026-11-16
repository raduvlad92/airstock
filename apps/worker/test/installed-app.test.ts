import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// The installed app (plan D13, 5.12): the manifest starts on the scanner with a shortcut per
// flow, and the service worker keeps only the app shell. Pages and API responses always come
// from the network, so stock on screen is never a stale copy.

const PUBLIC = new URL('../public/', import.meta.url);

describe('installed app', () => {
  it('starts on /app/scan with shortcuts for each flow and proper icons', async () => {
    const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', PUBLIC), 'utf8'));
    expect(manifest.start_url).toBe('/app/scan');
    expect(manifest.id).toBe('/app');
    expect(manifest.display).toBe('standalone');
    expect(manifest.shortcuts.map((s: { name: string; url: string }) => [s.name, s.url])).toEqual([
      ['Receive', '/app/scan?flow=receive'],
      ['Count', '/app/scan?flow=count'],
      ['Move', '/app/scan?flow=move'],
      ['Pick', '/app/scan?flow=pick'],
      ['Quick add', '/app/scan?flow=quick-add'],
    ]);
    const icons = [
      ...manifest.icons,
      ...manifest.shortcuts.flatMap((s: { icons: unknown[] }) => s.icons),
    ] as Array<{ src: string; sizes: string; purpose?: string }>;
    expect(icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    for (const icon of icons) {
      const bytes = await readFile(new URL(`.${icon.src}`, PUBLIC));
      if (icon.src.endsWith('.png')) {
        // PNG width and height sit at bytes 16–23 of the header.
        const size = `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
        expect(size, icon.src).toBe(icon.sizes);
      }
    }
  });

  it('caches the app shell only, never pages or API responses', async () => {
    const source = await readFile(new URL('sw.js', PUBLIC), 'utf8');
    const listeners = new Map<string, (event: unknown) => void>();
    runInNewContext(source, {
      self: {
        addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
        location: { origin: 'https://airstock.example' },
      },
      URL,
      caches: { open: () => new Promise(() => {}) },
      fetch: () => Promise.reject(new Error('no network in this test')),
      Promise,
      setTimeout,
      Response,
    });
    const handled = (path: string, method = 'GET') => {
      let responded = false;
      listeners.get('fetch')!({
        request: { method, url: `https://airstock.example${path}` },
        respondWith: () => {
          responded = true;
        },
      });
      return responded;
    };
    for (const path of [
      '/app/assets/app.js',
      '/app/assets/app.css',
      '/assets/vendor/zxing-wasm-3.1.6/zxing_reader.wasm',
      '/assets/vendor/zxing-wasm-3.1.6/zxing-reader.js',
      '/app/assets/pdf-Bx3k9aQ1.js',
      '/assets/icon-192.png',
    ]) {
      expect(handled(path), path).toBe(true);
    }
    for (const path of [
      '/app',
      '/app/scan',
      '/app/scan?flow=pick',
      '/api/v1/shops',
      '/api/v1/shops/x/scan?code=123',
      '/auth/login',
      '/assets/fonts/NotoSans-Regular.ttf',
    ]) {
      expect(handled(path), path).toBe(false);
    }
    expect(handled('/app/assets/app.js', 'POST')).toBe(false);
  });
});
