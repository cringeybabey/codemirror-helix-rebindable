import { PluginOption, defineConfig } from "vite";
import { join, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import { readFile } from "node:fs/promises";

export default defineConfig({
  build: {
    target: "esnext",
  },
  plugins: [importFolderAsJson()],
});

async function listFiles(cwd: string) {
  console.log(`listing files under ${cwd}`);

  const child = spawn("git", ["ls-tree", "-r", "HEAD", "--name-only"], {
    cwd,
    stdio: ["pipe", "pipe", "inherit"],
  });

  child.stdout.setEncoding("utf8");

  const output = await text(child.stdout);

  return output.trim().split("\n");
}

function importFolderAsJson(): PluginOption {
  const virtualModuleId = "virtual:folder-content";
  const resolvedVirtualModuleId = "\0" + virtualModuleId;
  const prefix = "folder:";

  return {
    name: "import-folder-as-json",
    resolveId(id, importer) {
      if (id.startsWith(prefix)) {
        const importPath = id.slice(prefix.length);
        const [folderPath, cmd] = importPath.split("?");

        const resolvedPath = resolve(dirname(importer!), folderPath);

        return `${resolvedVirtualModuleId}?${resolvedPath}${cmd ? `&${cmd}` : ""}`;
      }
    },
    async load(id) {
      if (id.startsWith(resolvedVirtualModuleId)) {
        const [folder, cmd] = id.split("?")[1].split("&");

        const files = await listFiles(folder);

        if (cmd === "names") {
          return {
            code: `export default ${JSON.stringify(files)}`,
          };
        }

        const result = {};

        await Promise.all(
          files.map(async (file) => {
            const contents = await readFile(join(folder, file), "utf8");

            result[file] = contents;
          })
        );

        return {
          code: `export default ${JSON.stringify(result)}`,
        };
      }
    },
  };
}
