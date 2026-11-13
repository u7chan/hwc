import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createApp } from "./app";
import type { PaneClient } from "./herdr/panes";
import type { AppState } from "./herdr/state";
import {
  encodeAttachmentName,
  FILENAME_HEADER,
  MAX_FILE_ATTACHMENT_BYTES,
  MAX_IMAGE_ATTACHMENT_BYTES,
} from "../shared/attachments";
import {
  state,
  chatState,
  twoChatPanesState,
  createTestApp,
  pngBytes,
  withCheckout,
  createFilesApp,
} from "./app.test-helpers";

async function withAttachmentsRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "hwc-attachments-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createAttachmentApp(
  root: string,
  options: { state?: AppState; panes?: Partial<PaneClient> } = {},
): ReturnType<typeof createApp> {
  return createTestApp({
    state: options.state ?? chatState,
    panes: options.panes,
    attachmentsRoot: root,
  }).app;
}

async function uploadFile(
  app: ReturnType<typeof createApp>,
  options: {
    paneId?: string;
    name?: string;
    type?: string;
    body?: Uint8Array<ArrayBuffer>;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  return app.request(`/api/panes/${options.paneId ?? "w1:p1"}/attachments`, {
    method: "POST",
    headers: {
      [FILENAME_HEADER]: encodeAttachmentName(options.name ?? "image.png"),
      "content-type": options.type ?? "image/png",
      ...options.headers,
    },
    body: options.body ?? pngBytes,
  });
}

test("POST /api/panes/:id/attachments saves the file under its original basename", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const response = await uploadFile(app, { name: "screenshot.png" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { name: string };
    expect(body.name).toBe("screenshot.png");
    expect(await readFile(join(root, "w1:p1", body.name))).toEqual(Buffer.from(pngBytes));

    // 続けて貼った同名のファイルは上書きせず、拡張子の前に連番が付く。
    const second = (await (await uploadFile(app, { name: "screenshot.png" })).json()) as {
      name: string;
    };
    expect(second.name).toBe("screenshot-1.png");
    expect(await readFile(join(root, "w1:p1", second.name))).toEqual(Buffer.from(pngBytes));
  });
});

test("POST /api/panes/:id/attachments sanitizes the name before saving it", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);

    const path = (await (
      await uploadFile(app, { name: "../escape/report.zip", type: "application/zip" })
    ).json()) as { name: string };
    expect(path.name).toBe("escapereport.zip");

    const dotted = (await (await uploadFile(app, { name: ".env" })).json()) as { name: string };
    expect(dotted.name).toBe("env");

    // 保存先の外は作られない。
    expect((await readdir(root)).sort()).toEqual(["w1:p1"]);
    expect((await readdir(join(root, "w1:p1"))).sort()).toEqual(["env", "escapereport.zip"]);
  });
});

test("POST /api/panes/:id/attachments refuses a request without a usable file name", async () => {
  await withAttachmentsRoot(async (root) => {
    // 名前は body より先に見る。ペインが無くても 400 が返る。
    const app = createAttachmentApp(root, { state });
    for (const value of ["", "%E0%A4%A", "%zz", encodeURIComponent("...")]) {
      const response = await uploadFile(app, { headers: { [FILENAME_HEADER]: value } });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    expect(await readdir(root)).toEqual([]);
  });
});

test("POST /api/panes/:id/attachments returns 404 for a pane that is gone or has no chat", async () => {
  await withAttachmentsRoot(async (root) => {
    const missing = await uploadFile(createAttachmentApp(root), { paneId: "w1:p9" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "pane_not_found" });

    const noChat = await uploadFile(createAttachmentApp(root, { state }));
    expect(noChat.status).toBe(404);
    expect(await noChat.json()).toEqual({ error: "no_chat" });
  });
});

test("POST /api/panes/:id/attachments refuses a pane id that would escape the root", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);

    // %2e%2e は URL の解決で消える。%2F は残るので、デコードすると区切りを含む id になる。
    for (const paneId of ["%2e%2e", "..%2F..", "..%2F..%2Ftmp"]) {
      const response = await uploadFile(app, { paneId });
      expect(response.status).toBe(404);
    }
    expect(await readdir(root)).toEqual([]);
  });
});

test("POST /api/panes/:id/attachments stops an oversized image before reading it", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const response = await uploadFile(app, {
      headers: { "content-length": String(MAX_IMAGE_ATTACHMENT_BYTES + 1) },
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "attachment_too_large" });
  });
});

test("POST /api/panes/:id/attachments accepts exactly the image limit and refuses one byte more", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);

    const atLimit = await uploadFile(app, { body: new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES) });
    expect(atLimit.status).toBe(200);

    const over = await uploadFile(app, { body: new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1) });
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "attachment_too_large" });
  });
});

test("POST /api/panes/:id/attachments gives a non-image file the larger limit", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const zip = { name: "report.zip", type: "application/zip" };

    // 画像なら 413 になる大きさでも、zip なら 25MB まで受け付ける。
    const atLimit = await uploadFile(app, {
      ...zip,
      body: new Uint8Array(MAX_FILE_ATTACHMENT_BYTES),
    });
    expect(atLimit.status).toBe(200);

    const over = await uploadFile(app, {
      ...zip,
      headers: { "content-length": String(MAX_FILE_ATTACHMENT_BYTES + 1) },
    });
    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "attachment_too_large" });
  });
});

test("POST /api/panes/:id/attachments counts the bytes it actually read", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    // Content-Length を持たない chunked の body。事前検査を通らず、読んだバイト数だけで落ちる。
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const request = new Request("http://localhost/api/panes/w1:p1/attachments", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        [FILENAME_HEADER]: encodeAttachmentName("image.png"),
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent > MAX_IMAGE_ATTACHMENT_BYTES) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          sent += chunk.byteLength;
        },
      }),
      // ストリームの body は長さが決まらないので duplex が要る。
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "attachment_too_large" });
  });
});

test("POST /api/panes/:id/attachments rejects an empty body", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const response = await uploadFile(app, { body: new Uint8Array(0) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});

test("GET /api/panes/:id/attachments/:name serves the saved image as immutable", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const { name } = (await (await uploadFile(app, { name: "screenshot.png" })).json()) as {
      name: string;
    };

    const response = await app.request(`/api/panes/w1:p1/attachments/${name}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
  });
});

test("GET /api/panes/:id/attachments/:name serves only the image types", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    // 保存はできるが配信はしない。名前が保存名として正しくても、画像以外は 400。
    await uploadFile(app, { name: "report.zip", type: "application/zip" });
    await uploadFile(app, { name: "mock.html", type: "text/html" });
    await uploadFile(app, { name: "icon.svg", type: "image/svg+xml" });

    for (const name of ["report.zip", "mock.html", "icon.svg"]) {
      const response = await app.request(`/api/panes/w1:p1/attachments/${name}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });
});

test("GET /api/panes/:id/attachments/:name returns 400 for a name outside the format", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);

    // %2F は URL の解決で消えないので、デコードすると "../" を含む名前になる。
    for (const name of [".env", "..%2Fimage.png", "a%2Fb.png", "image.png."]) {
      const response = await app.request(`/api/panes/w1:p1/attachments/${name}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
  });
});

test("GET /api/panes/:id/attachments/:name returns 404 for a name this pane never saved", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root, { state: twoChatPanesState });

    const absent = await app.request("/api/panes/w1:p1/attachments/pasted-20200101-000000.png");
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: "not_found" });

    // 別のペイン（state に実在する w1:p2）にだけ置いた名前は、w1:p1 からは開けない。
    const { name } = (await (await uploadFile(app, { paneId: "w1:p2" })).json()) as {
      name: string;
    };
    const own = await app.request(`/api/panes/w1:p2/attachments/${name}`);
    expect(own.status).toBe(200);

    const crossPane = await app.request(`/api/panes/w1:p1/attachments/${name}`);
    expect(crossPane.status).toBe(404);
    expect(await crossPane.json()).toEqual({ error: "not_found" });
  });
});

test("GET /api/panes/:id/attachments/:name returns 404 no_chat for a pane without a session", async () => {
  await withAttachmentsRoot(async (root) => {
    const response = await createAttachmentApp(root, { state }).request(
      "/api/panes/w1:p1/attachments/pasted-20261103-120000.png",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no_chat" });
  });
});

test("GET /api/panes/:id/files serves an image below the checkout", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs", "mock.png"), pngBytes);
    const app = createFilesApp(root);

    const response = await app.request("/api/panes/w1:p1/files?path=docs%2Fmock.png");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
  });
});

test("GET /api/panes/:id/files refuses a path outside the checkout", async () => {
  await withCheckout(async (root) => {
    await writeFile(join(root, "mock.png"), pngBytes);
    const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
    const outsidePath = join(outside, "secret.png");
    await writeFile(outsidePath, pngBytes);

    try {
      const app = createFilesApp(root);
      for (const path of [
        `..%2F${outside.split("/").pop()}%2Fsecret.png`,
        encodeURIComponent(outsidePath),
        "missing.png",
        "",
      ]) {
        const response = await app.request(`/api/panes/w1:p1/files?path=${path}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("GET /api/panes/:id/files returns no_chat for a pane without a session", async () => {
  await withCheckout(async (root) => {
    const response = await createFilesApp(root, { state }).request(
      "/api/panes/w1:p1/files?path=mock.png",
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "no_chat" });
  });
});

test("GET /api/panes/:id/files serves an image from an extra root by root number", async () => {
  await withCheckout(async (root) => {
    const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
    await mkdir(join(extra, "docs"), { recursive: true });
    await writeFile(join(extra, "docs", "mock.png"), pngBytes);

    try {
      const app = createFilesApp(root, { previewRoots: [extra] });

      const response = await app.request("/api/panes/w1:p1/files?root=1&path=docs%2Fmock.png");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);

      // 追加根の画像は、チェックアウトの root 0 には無い。
      expect((await app.request("/api/panes/w1:p1/files?root=0&path=docs%2Fmock.png")).status).toBe(
        404,
      );
      // 範囲外と整数でない番号は受けない。
      for (const index of ["2", "-1", "1.5", "x"]) {
        const denied = await app.request(
          `/api/panes/w1:p1/files?root=${index}&path=docs%2Fmock.png`,
        );
        expect(denied.status).toBe(404);
      }
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});

test("GET /api/panes/:id/files uses the first extra root when the pane has no checkout", async () => {
  const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
  await writeFile(join(extra, "mock.png"), pngBytes);

  try {
    const app = createFilesApp(null, { previewRoots: [extra] });
    const response = await app.request("/api/panes/w1:p1/files?root=0&path=mock.png");

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes);
  } finally {
    await rm(extra, { recursive: true, force: true });
  }
});

test("GET /api/panes/:id/preview serves HTML that cannot reach the BFF origin", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, "preview"), { recursive: true });
    await writeFile(join(root, "preview", "index.html"), "<!doctype html><p>mock</p>");
    const app = createFilesApp(root);

    const response = await app.request("/api/panes/w1:p1/preview/0/preview/index.html");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // 書き直したものをそのまま見たいので、版を URL に入れずにキャッシュさせない。
    expect(response.headers.get("cache-control")).toBe("no-store");
    // 不透明なオリジンからの module / fetch は CORS になる。このルートだけ開ける。
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    // iframe 属性を外されても、直接開いても、同じオリジンには戻らない。
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(await response.text()).toBe("<!doctype html><p>mock</p>");
  });
});

test("GET /api/panes/:id/preview serves the files the HTML refers to", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, "preview"), { recursive: true });
    await writeFile(join(root, "preview", "app.css"), "body{}");
    await writeFile(join(root, "preview", "app.js"), "export const ready = true;");
    await writeFile(join(root, "preview", "shot.png"), pngBytes);
    await writeFile(join(root, "preview", "notes.txt"), "text");
    const app = createFilesApp(root);

    const css = await app.request("/api/panes/w1:p1/preview/0/preview/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");

    const js = await app.request("/api/panes/w1:p1/preview/0/preview/app.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

    const image = await app.request("/api/panes/w1:p1/preview/0/preview/shot.png");
    expect(image.headers.get("content-type")).toBe("image/png");

    // 一覧に無い形式は配信しない。
    expect((await app.request("/api/panes/w1:p1/preview/0/preview/notes.txt")).status).toBe(404);
  });
});

test("GET /api/panes/:id/preview reads an extra root only when it is configured", async () => {
  await withCheckout(async (root) => {
    const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
    const page = join(extra, "mock.html");
    await writeFile(page, "<!doctype html>");

    try {
      const denied = await createFilesApp(root, { previewRoots: [] }).request(
        `/api/panes/w1:p1/preview/1/${encodeURIComponent(page)}`,
      );
      expect(denied.status).toBe(404);

      const app = createFilesApp(root, { previewRoots: [extra] });
      const allowed = await app.request(`/api/panes/w1:p1/preview/1/${encodeURIComponent(page)}`);
      expect(allowed.status).toBe(200);
      expect(await allowed.text()).toBe("<!doctype html>");
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});

test("GET /api/panes/:id/preview warns only when the HTML loads a script it cannot serve", async () => {
  await withCheckout(async (root) => {
    await mkdir(join(root, "preview"), { recursive: true });
    const warnedBody = '<script src="./app.tsx"></script>';
    await writeFile(join(root, "preview", "warned.html"), warnedBody);
    await writeFile(join(root, "preview", "plain.html"), '<script src="./app.js"></script>');
    await writeFile(join(root, "preview", "app.js"), "export {};");
    await writeFile(join(root, "preview", "app.css"), "body{}");
    const app = createFilesApp(root);

    const warned = await app.request("/api/panes/w1:p1/preview/0/preview/warned.html");
    expect(warned.status).toBe(200);
    expect(warned.headers.get("x-hwc-preview-warning")).toBe("script");
    // iframe の中身は書き換えない。案内はヘッダーだけで伝える。
    expect(await warned.text()).toBe(warnedBody);

    const plain = await app.request("/api/panes/w1:p1/preview/0/preview/plain.html");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-hwc-preview-warning")).toBeNull();

    // 案内は iframe のプレビューだけ。CSS と JS の応答には付けない。
    for (const path of ["preview/app.css", "preview/app.js"]) {
      const response = await app.request(`/api/panes/w1:p1/preview/0/${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-hwc-preview-warning")).toBeNull();
    }

    // クライアントは HEAD で同じ URL を確かめる。本文は 0 バイトのままでよい。
    const head = await app.request("/api/panes/w1:p1/preview/0/preview/warned.html", {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-hwc-preview-warning")).toBe("script");
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });
});

test("GET /api/panes/:id/preview serves an HTML under /tmp by default", async () => {
  await withCheckout(async (root) => {
    const dir = await mkdtemp(join("/tmp", "hwc-default-root-"));
    const page = join(dir, "mock.html");
    await writeFile(page, "<!doctype html>");

    try {
      // 追加根を設定しなくても、/tmp はチェックアウトの次の根になる（ADR 0066）。
      const response = await createFilesApp(root).request(
        `/api/panes/w1:p1/preview/1/${encodeURIComponent(page)}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<!doctype html>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("GET /api/panes/:id/preview keeps the root the chip was found in", async () => {
  await withCheckout(async (root) => {
    await writeFile(join(root, "mock.html"), "<!doctype html><p>checkout</p>");
    const extra = await mkdtemp(join(tmpdir(), "hwc-preview-root-"));
    await writeFile(join(extra, "mock.html"), "<!doctype html><p>extra</p>");
    await mkdir(join(extra, "assets"), { recursive: true });
    await writeFile(join(extra, "assets", "app.css"), "body{}");

    try {
      const app = createFilesApp(root, { previewRoots: [extra] });

      // 同じ相対名でも、根の番号が違えば別のファイルを返す。
      expect(await (await app.request("/api/panes/w1:p1/preview/0/mock.html")).text()).toBe(
        "<!doctype html><p>checkout</p>",
      );
      expect(await (await app.request("/api/panes/w1:p1/preview/1/mock.html")).text()).toBe(
        "<!doctype html><p>extra</p>",
      );

      // 相対参照も URL の根の番号を引き継ぐ（/preview/1/assets/app.css）。
      const css = await app.request("/api/panes/w1:p1/preview/1/assets/app.css");
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});

test("GET /api/panes/:id/preview refuses a root that does not exist", async () => {
  await withCheckout(async (root) => {
    await writeFile(join(root, "mock.html"), "<!doctype html>");
    const app = createFilesApp(root, { previewRoots: [] });

    for (const index of ["1", "-1", "1.5", "x"]) {
      const response = await app.request(`/api/panes/w1:p1/preview/${index}/mock.html`);
      expect(response.status).toBe(404);
    }
  });
});

test("GET /api/panes/:id/preview shows a page, not JSON, when the HTML is gone", async () => {
  await withCheckout(async (root) => {
    const app = createFilesApp(root);

    const missing = await app.request("/api/panes/w1:p1/preview/0/preview/gone.html");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(missing.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(await missing.text()).toContain("ファイルが見つかりません");

    // HTML 以外は JSON のまま。iframe は html しか要求しない。
    const css = await app.request("/api/panes/w1:p1/preview/0/preview/gone.css");
    expect(css.status).toBe(404);
    expect(await css.json()).toEqual({ error: "not_found" });
  });
});

test("GET /api/panes/:id/preview refuses traversal and a pane without a session", async () => {
  await withCheckout(async (root) => {
    const outside = await mkdtemp(join(tmpdir(), "hwc-outside-"));
    const outsidePath = join(outside, "secret.html");
    await writeFile(outsidePath, "<!doctype html>");

    try {
      const app = createFilesApp(root);
      for (const path of [
        `..%2F${basename(outside)}%2Fsecret.html`,
        encodeURIComponent(outsidePath),
        "missing.html",
      ]) {
        expect((await app.request(`/api/panes/w1:p1/preview/0/${path}`)).status).toBe(404);
      }

      const noChat = await createFilesApp(root, { state }).request(
        "/api/panes/w1:p1/preview/0/mock.html",
      );
      expect(noChat.status).toBe(404);
      expect(await noChat.json()).toEqual({ error: "no_chat" });

      const noPane = await app.request("/api/panes/w9:p9/preview/0/mock.html");
      expect(noPane.status).toBe(404);
      expect(await noPane.json()).toEqual({ error: "pane_not_found" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("POST /api/panes/:id/input appends the saved paths as a note", async () => {
  await withAttachmentsRoot(async (root) => {
    const seen: unknown[] = [];
    const app = createAttachmentApp(root, {
      panes: {
        send: async (options) => {
          seen.push(options);
        },
      },
    });
    const { name } = (await (await uploadFile(app)).json()) as { name: string };

    const response = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "look at this", submit: true, attachments: [name] }),
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        paneId: "w1:p1",
        text: `look at this\n\n<attached_files>\n- ${join(root, "w1:p1", name)}\n</attached_files>`,
        submit: true,
      },
    ]);
  });
});

test("POST /api/panes/:id/input accepts a message made of the images only", async () => {
  await withAttachmentsRoot(async (root) => {
    const seen: unknown[] = [];
    const app = createAttachmentApp(root, {
      panes: {
        send: async (options) => {
          seen.push(options);
        },
      },
    });
    const { name } = (await (await uploadFile(app)).json()) as { name: string };

    const response = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", submit: true, attachments: [name] }),
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        paneId: "w1:p1",
        text: `<attached_files>\n- ${join(root, "w1:p1", name)}\n</attached_files>`,
        submit: true,
      },
    ]);
  });
});

test("POST /api/panes/:id/input rejects an attachment this pane never saved", async () => {
  await withAttachmentsRoot(async (root) => {
    const sent: unknown[] = [];
    const app = createAttachmentApp(root, {
      panes: {
        send: async (options) => {
          sent.push(options);
        },
      },
    });

    const absent = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "hi",
        submit: true,
        attachments: ["pasted-20200101-000000.png"],
      }),
    });
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ error: "invalid_request" });

    const outside = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "hi",
        submit: true,
        attachments: ["../pasted-20200101-000000.png"],
      }),
    });
    expect(outside.status).toBe(400);
    expect(await outside.json()).toEqual({
      error: "attachments must be an array of attachment names",
    });
    expect(sent).toEqual([]);
  });
});

test("POST /api/panes/:id/input counts the note towards the size limit", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root);
    const { name } = (await (await uploadFile(app)).json()) as { name: string };

    // 注記の分だけ本文に書ける量が減る。素の本文なら収まる長さで確かめる。
    const note = `<attached_files>\n- ${join(root, "w1:p1", name)}\n</attached_files>`;
    const text = "a".repeat(16_384 - note.length - 1);

    const plain = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, submit: true }),
    });
    expect(plain.status).toBe(200);

    const response = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, submit: true, attachments: [name] }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "text and the attached files note must be at most 16384 bytes",
    });
  });
});

test("POST /api/panes/:id/input returns 404 for the pane that holds the images", async () => {
  await withAttachmentsRoot(async (root) => {
    const app = createAttachmentApp(root, { state });

    const noChat = await app.request("/api/panes/w1:p1/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", submit: true, attachments: ["pasted-20261103-120000.png"] }),
    });
    expect(noChat.status).toBe(404);
    expect(await noChat.json()).toEqual({ error: "no_chat" });

    const missing = await app.request("/api/panes/w1:p9/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "", submit: true, attachments: ["pasted-20261103-120000.png"] }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "pane_not_found" });
  });
});
