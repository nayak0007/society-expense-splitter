/**
 * Runs after the test framework is installed, before each suite.
 *
 * The app's stores persist to MMKV (a synchronous Nitro native module) and its session
 * helpers talk to expo-secure-store. Neither has a JS implementation in Jest, so both are
 * replaced with in-memory doubles — the same seam the real modules expose, so a store or a
 * hook that reads through them behaves identically without a device.
 */

jest.mock('react-native-mmkv', () => {
  class MMKV {
    private readonly store = new Map<string, string>();

    set(key: string, value: string): void {
      this.store.set(key, value);
    }

    getString(key: string): string | undefined {
      return this.store.get(key);
    }

    remove(key: string): void {
      this.store.delete(key);
    }

    clearAll(): void {
      this.store.clear();
    }
  }

  return { createMMKV: () => new MMKV(), MMKV };
});

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

/**
 * The Supabase adapter is replaced wholesale: it pulls in `@supabase/supabase-js` and the URL
 * polyfill, neither of which a component test exercises, and the API client is mocked at the
 * seam every test actually uses (a repository stub, or a mocked hook). Nothing in the suite
 * makes a network call.
 */
jest.mock('@/lib/supabase/supabase.client', () => ({
  getSupabaseClient: () => ({
    auth: { refreshSession: async () => ({ data: { session: null } }) },
  }),
  getSupabaseSession: async () => null,
}));

/**
 * T076's four native modules.
 *
 * The capture/compress/upload path is the first feature that reads files, hashes bytes and
 * sends a binary body, and every one of those steps lives in a native module with no JS
 * implementation. Each is therefore replaced with a double that mirrors the module's real
 * contract — the same shape the production code depends on — rather than a stub that only
 * returns `undefined`:
 *
 *  - **`expo-file-system`** gets an in-memory filesystem with real byte arrays, so size reads,
 *    hashing the exact bytes and the raw upload are all exercised end to end. The upload spy is
 *    exported so a test can assert *what* was PUT, and with which headers.
 *  - **`expo-crypto`** computes a **real SHA-256** through Node's `crypto` when the runtime
 *    exposes it, so a test that asserts "the digest is of the bytes that were uploaded" is an
 *    assertion about the algorithm rather than about a stand-in. The deterministic fallback
 *    exists only so a restricted runtime cannot make the whole suite unimportable.
 *  - **`expo-image-manipulator`** is stateful enough to model the two-pass pipeline: the probe
 *    returns the source dimensions, and each `saveAsync` reports a configurable output size, so
 *    "the second pass runs at 0.55 when the first overshoots 400 KB" is testable.
 *  - **`expo-image-picker`** / **`expo-document-picker`** default to *cancelled*, which is the
 *    only safe default: a test that forgets to arrange a pick must never be able to make the
 *    suite behave as though a user chose a file.
 */
jest.mock('expo-file-system', () => {
  // Named with the `mock` prefix babel-plugin-jest-hoist permits: a type alias is erased at
  // runtime but the hoist plugin still walks the identifier, and an unprefixed name reads as
  // an out-of-scope reference.
  type MockEntry = { size: number; bytes: Uint8Array<ArrayBuffer> };
  const store = new Map<string, MockEntry>();

  const join = (parts: readonly string[]): string => {
    let uri = parts[0] ?? '';
    for (const part of parts.slice(1)) {
      uri = `${uri.replace(/\/$/, '')}/${part.replace(/^\//, '')}`;
    }
    return uri;
  };

  const uploadImpl = jest.fn(async (..._args: unknown[]) => ({
    status: 200,
    body: '',
    headers: {},
  }));

  class File {
    readonly uri: string;

    constructor(...uris: readonly (string | { readonly uri: string })[]) {
      this.uri = join(uris.map((u) => (typeof u === 'string' ? u : u.uri)));
    }

    get exists(): boolean {
      return store.has(this.uri);
    }

    get size(): number {
      return store.get(this.uri)?.size ?? 0;
    }

    async bytes(): Promise<Uint8Array<ArrayBuffer>> {
      return store.get(this.uri)?.bytes ?? new Uint8Array(0);
    }

    delete(): void {
      store.delete(this.uri);
    }

    upload(url: string, options?: unknown): Promise<{ status: number }> {
      return uploadImpl(this.uri, url, options) as Promise<{ status: number }>;
    }
  }

  return {
    File,
    Directory: class Directory {
      readonly uri: string;
      constructor(...uris: readonly (string | { readonly uri: string })[]) {
        this.uri = join(uris.map((u) => (typeof u === 'string' ? u : u.uri)));
      }
    },
    Paths: { cache: 'file:///cache', document: 'file:///documents' },
    UploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
    /** Test seam: register a file the code under test will read. */
    __setFile: (uri: string, size: number, bytes?: Uint8Array<ArrayBuffer>): void => {
      store.set(uri, {
        size,
        bytes: bytes ?? new Uint8Array(size).fill(7),
      });
    },
    __deleteFile: (uri: string): void => {
      store.delete(uri);
    },
    __hasFile: (uri: string): boolean => store.has(uri),
    __uploadSpy: uploadImpl,
    __clearFiles: (): void => {
      store.clear();
    },
  };
});

jest.mock('expo-crypto', () => {
  const nodeCrypto = (() => {
    try {
      return require('node:crypto') as {
        createHash: (algorithm: string) => {
          update: (data: Uint8Array) => { digest: (encoding: string) => string };
        };
      };
    } catch {
      return null;
    }
  })();

  /** Deterministic, non-cryptographic stand-in used only when Node's crypto is unavailable. */
  const fallbackDigest = (bytes: Uint8Array): ArrayBuffer => {
    const out = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      out[index] = bytes.length === 0 ? 0 : (bytes[index % bytes.length] ?? 0);
    }
    out[0] = bytes.length & 0xff;
    out[1] = (bytes.length >> 8) & 0xff;
    return out.buffer;
  };

  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256', SHA1: 'SHA-1', MD5: 'MD5' },
    CryptoEncoding: { HEX: 'hex', BASE64: 'base64' },
    digest: jest.fn(async (_algorithm: string, data: Uint8Array | ArrayBuffer) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (nodeCrypto === null) return fallbackDigest(bytes);
      const hex = nodeCrypto.createHash('sha256').update(bytes).digest('hex');
      const buffer = new ArrayBuffer(32);
      const view = new Uint8Array(buffer);
      for (let index = 0; index < 32; index += 1) {
        view[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      }
      return buffer;
    }),
    digestStringAsync: jest.fn(async () => ''),
    randomUUID: jest.fn(() => '00000000-0000-4000-8000-000000000000'),
  };
});

jest.mock('expo-image-manipulator', () => {
  const state = {
    source: { width: 4000, height: 3000 },
    // `width`/`height` are optional so a test can let a save report the *context's* dimensions
    // — which is how a resize is proven rather than assumed.
    outputs: [] as { uri: string; width?: number; height?: number }[],
  };

  const context = () => {
    const pending: { resize?: { width?: number; height?: number } } = {};
    const ctx = {
      resize(size: { width?: number; height?: number }) {
        pending.resize = size;
        return ctx;
      },
      rotate() {
        return ctx;
      },
      flip() {
        return ctx;
      },
      crop() {
        return ctx;
      },
      reset() {
        return ctx;
      },
      async renderAsync() {
        // `renderAsync` reports the dimensions of the *current* transform. With no resize
        // queued that is the source size (a probe reads the source); with a single-axis
        // resize it is the source scaled by the same ratio, exactly as the real encoder
        // preserves aspect ratio — which is what proves the 1600 px cap.
        const resize = pending.resize;
        let width = state.source.width;
        let height = state.source.height;
        if (resize?.width !== undefined && resize?.height !== undefined) {
          width = resize.width;
          height = resize.height;
        } else if (resize?.width !== undefined) {
          width = resize.width;
          height = Math.round((state.source.height * resize.width) / state.source.width);
        } else if (resize?.height !== undefined) {
          height = resize.height;
          width = Math.round((state.source.width * resize.height) / state.source.height);
        }
        return {
          width,
          height,
          saveAsync: async () => {
            // Each save consumes one queued output, so a test can give the first pass and the
            // second pass different URIs and sizes.
            const next = state.outputs.shift();
            return {
              uri: next?.uri ?? 'file:///cache/render.jpg',
              width: next?.width ?? width,
              height: next?.height ?? height,
            };
          },
        };
      },
    };
    return ctx;
  };

  return {
    ImageManipulator: { manipulate: jest.fn(() => context()) },
    SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
    FlipType: { Vertical: 'vertical', Horizontal: 'horizontal' },
    /** Test seam: the source dimensions the probe should report. */
    __setSourceDimensions: (width: number, height: number): void => {
      state.source = { width, height };
      state.outputs = [];
    },
    /** Test seam: the outputs, in order, that each render should produce. */
    __setRenderOutputs: (
      outputs: readonly { uri: string; width?: number; height?: number }[],
    ): void => {
      state.outputs = [...outputs];
    },
  };
});

jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  launchCameraAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: null })),
  getPendingResultAsync: jest.fn(async () => null),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => ({ canceled: true, assets: null })),
}));

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(async () => ({ type: 'opened' })),
}));
