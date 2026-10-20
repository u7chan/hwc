import { hc } from "hono/client";
import { useEffect, useState } from "preact/hooks";
import type { AppType } from "../server/app";

const api = hc<AppType>("/");

export function App() {
  const [health, setHealth] = useState("connecting");

  useEffect(() => {
    api.api.health
      .$get()
      .then(async (response) => {
        const data = await response.json();
        setHealth(data.ok ? "ok" : "error");
      })
      .catch((error: unknown) => {
        setHealth(error instanceof Error ? error.message : String(error));
      });
  }, []);

  return (
    <main class="hwc-app">
      <h1 class="hwc-title">hwc</h1>
      <p class="hwc-status">backend: {health}</p>
    </main>
  );
}
