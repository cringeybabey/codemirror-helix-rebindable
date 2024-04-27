import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export async function runServer() {
  const server = await createServer({
    root: __dirname,
    server: {
      port: 45183,
    },
    // build: {
    //   rollupOptions: {
    //     input: "test-index.html"
    //   }
    // }
  });

  await server.listen();

  server.printUrls();

  return server;
}
