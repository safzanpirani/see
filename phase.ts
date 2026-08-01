import { availableBackends, ensureVisionBinary } from "./src/ocr.ts";
import { readSource } from "./src/image.ts";
const t = (l: string, t0: number) => console.log(`${l}: ${Date.now() - t0}ms`);
let t0 = Date.now(); await readSource(process.argv[2]!); t("fetch", t0);
t0 = Date.now(); const b = await availableBackends(); t(`availableBackends ${b}`, t0);
t0 = Date.now(); await ensureVisionBinary(); t("ensureVisionBinary", t0);
